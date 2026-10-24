using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Teammates.Compute;

namespace Teammates.Api;

/// <summary>Turns raw log bytes into redacted lines and keeps the newest ones. Pure; unit tested.</summary>
public sealed class JobLogBuffer
{
    public const int MaxLines = 2000;
    public const int MaxLineChars = 4000;
    private readonly LinkedList<string> _lines = new();
    private string _partial = "";
    private bool _inKey;

    public long Total { get; private set; }
    public int Count => _lines.Count;
    public IReadOnlyList<string> Snapshot() => _lines.ToList();

    /// <summary>Adds a chunk of text and returns the complete, redacted lines it finished.</summary>
    public IReadOnlyList<string> Append(string text, bool flush = false)
    {
        var added = new List<string>();
        var data = _partial + text.Replace("\r\n", "\n");
        var start = 0;
        while (true)
        {
            var newline = data.IndexOf('\n', start);
            if (newline < 0) break;
            Push(data[start..newline], added);
            start = newline + 1;
        }
        _partial = data[start..];
        // A line with no newline yet stays pending, unless it is already very long.
        if (_partial.Length > MaxLineChars || (flush && _partial.Length > 0))
        {
            Push(_partial, added);
            _partial = "";
        }
        return added;
    }

    private void Push(string raw, List<string> added)
    {
        // A private key spans lines, so line-by-line redaction would miss it: drop the whole block.
        if (_inKey)
        {
            if (raw.Contains("PRIVATE KEY-----") && raw.Contains("-----END")) _inKey = false;
            return;
        }
        if (raw.Contains("-----BEGIN") && raw.Contains("PRIVATE KEY-----") && !raw.Contains("-----END"))
        {
            _inKey = true;
            raw = "[redacted private key]";
        }
        var line = Dlp.Redact(raw.Length > MaxLineChars ? raw[..MaxLineChars] + "…" : raw);
        _lines.AddLast(line);
        Total++;
        while (_lines.Count > MaxLines) _lines.RemoveFirst();
        added.Add(line);
    }
}

/// <summary>Streams a background job's log to the computer panel over SSE. Reading the log
/// never wakes the desktop or keeps the computer awake: it runs with QuietActivity and only
/// while the computer is already awake. One poller per job, shared by every viewer; the last
/// <see cref="JobLogBuffer.MaxLines"/> lines stay in memory, the full log stays in the job's
/// log.txt on the computer.</summary>
public sealed class JobLogStreams(Platform platform)
{
    public const int ChunkBytes = 96 * 1024;
    public const int InitialBytes = 256 * 1024;
    public static TimeSpan Interval = TimeSpan.FromSeconds(1);

    public const string ReadScript = """
import base64, json, os, sys
root = os.environ['BOT_ROOT']
path = os.path.join(root, 'jobs', sys.argv[1], 'log.txt')
offset, cap, initial = int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
try:
    with open(path, 'rb') as f:
        f.seek(0, 2)
        size = f.tell()
        skip = False
        if offset < 0 or offset > size:
            offset = max(0, size - initial)
            skip = offset > 0
        f.seek(offset)
        data = f.read(cap)
        if skip:
            cut = data.find(b'\n')
            data = data[cut + 1:] if cut >= 0 else b''
        end = f.tell()
        print(json.dumps({'size': size, 'end': end, 'data': base64.b64encode(data).decode()}))
except FileNotFoundError:
    print(json.dumps({'size': 0, 'end': 0, 'data': ''}))
""";

    private sealed class State
    {
        public readonly object Gate = new();
        public readonly JobLogBuffer Buffer = new();
        public readonly List<Channel<string>> Subscribers = [];
        public long Offset = -1;
        public string Status = "running";
        public bool Asleep;
        public bool Ended;
        public Task? Pump;
        public readonly System.Text.Decoder Decoder = Encoding.UTF8.GetDecoder();
    }

    private readonly ConcurrentDictionary<Guid, State> _states = new();

    public int ActiveJobs => _states.Count;

    public async Task StreamAsync(HttpContext ctx, JobRow job)
    {
        var ct = ctx.RequestAborted;
        ctx.Response.ContentType = "text/event-stream";
        ctx.Response.Headers.CacheControl = "no-cache";
        ctx.Response.Headers["X-Accel-Buffering"] = "no";
        var state = _states.GetOrAdd(job.Id, _ => new State { Status = job.Status });
        var channel = Channel.CreateBounded<string>(new BoundedChannelOptions(256) { FullMode = BoundedChannelFullMode.DropOldest });
        string snapshot;
        lock (state.Gate)
        {
            state.Subscribers.Add(channel);
            snapshot = Event("snapshot", new { lines = state.Buffer.Snapshot(), total = state.Buffer.Total, status = state.Status, asleep = state.Asleep, maxLines = JobLogBuffer.MaxLines });
            if (state.Pump == null || state.Pump.IsCompleted) state.Pump = Task.Run(() => PumpAsync(job, state));
        }
        try
        {
            await ctx.Response.WriteAsync(": connected\n\n", ct);
            await ctx.Response.WriteAsync(snapshot, ct);
            await ctx.Response.Body.FlushAsync(ct);
            using var keepAlive = new PeriodicTimer(TimeSpan.FromSeconds(15));
            var tick = keepAlive.WaitForNextTickAsync(ct).AsTask();
            while (!ct.IsCancellationRequested)
            {
                var read = channel.Reader.WaitToReadAsync(ct).AsTask();
                var done = await Task.WhenAny(read, tick);
                if (done == tick)
                {
                    if (!await tick) break;
                    await ctx.Response.WriteAsync(": ping\n\n", ct);
                    await ctx.Response.Body.FlushAsync(ct);
                    tick = keepAlive.WaitForNextTickAsync(ct).AsTask();
                    continue;
                }
                if (!await read) break;
                while (channel.Reader.TryRead(out var message)) await ctx.Response.WriteAsync(message, ct);
                await ctx.Response.Body.FlushAsync(ct);
            }
        }
        catch (OperationCanceledException) { }
        catch (IOException) { }
        finally
        {
            lock (state.Gate) state.Subscribers.Remove(channel);
        }
    }

    private static string Event(string type, object payload) =>
        "data: " + JsonSerializer.Serialize(new { type, data = payload }) + "\n\n";

    private static void Broadcast(State state, string message)
    {
        lock (state.Gate)
            foreach (var sub in state.Subscribers) sub.Writer.TryWrite(message);
    }

    private async Task PumpAsync(JobRow job, State state)
    {
        // Reading a log is not use of the computer: never move its idle clock, never start a desktop.
        DockerComputeProvider.QuietActivity.Value = true;
        var computer = new ComputerId(job.ComputerId.ToString());
        var quietTicks = 0;
        while (true)
        {
            lock (state.Gate)
                if (state.Subscribers.Count == 0)
                {
                    // Keep the lines while the job runs so reopening is instant; drop them once it is over.
                    if (state.Ended) _states.TryRemove(job.Id, out _);
                    return;
                }
            try
            {
                string status;
                await using (var conn = await platform.Data.OpenConnectionAsync())
                    status = (await platform.Jobs.Get(conn, job.Id))?.Status ?? "gone";
                var finished = status is not ("starting" or "running");
                var awake = platform.Compute.PowerSnapshot().FirstOrDefault(item => item.Id == computer.Value).Power == "awake";
                if (status != state.Status)
                {
                    state.Status = status;
                    Broadcast(state, Event("status", new { status }));
                }
                if (awake != !state.Asleep)
                {
                    state.Asleep = !awake;
                    Broadcast(state, Event(awake ? "awake" : "asleep", new { status }));
                }
                var got = 0;
                if (awake)
                {
                    using var budget = new CancellationTokenSource(TimeSpan.FromSeconds(15));
                    var (code, stdout, _) = await BotFs.Capture(platform.Compute,
                        await BotFs.ConfinedAsync(platform.Compute, computer, job.BotId,
                            ["python3", "-c", ReadScript, job.Id.ToString("n"), state.Offset.ToString(), ChunkBytes.ToString(), InitialBytes.ToString()],
                            null, null, TimeSpan.FromSeconds(15), 200_000, budget.Token), budget.Token);
                    if (code == 0)
                    {
                        using var doc = JsonDocument.Parse(stdout);
                        var bytes = Convert.FromBase64String(doc.RootElement.GetProperty("data").GetString() ?? "");
                        var end = doc.RootElement.GetProperty("end").GetInt64();
                        got = bytes.Length;
                        state.Offset = end;
                        var chars = new char[Encoding.UTF8.GetMaxCharCount(bytes.Length)];
                        var n = state.Decoder.GetChars(bytes, 0, bytes.Length, chars, 0, flush: false);
                        IReadOnlyList<string> lines;
                        lock (state.Gate) lines = state.Buffer.Append(new string(chars, 0, n), flush: finished && got == 0);
                        if (lines.Count > 0) Broadcast(state, Event("lines", new { lines, total = state.Buffer.Total }));
                    }
                }
                if (finished && (got == 0 || !awake))
                {
                    if (++quietTicks >= 2 && !state.Ended)
                    {
                        state.Ended = true;
                        Broadcast(state, Event("end", new { status }));
                    }
                }
                else quietTicks = 0;
                if (got >= ChunkBytes) continue;
            }
            catch (Exception)
            {
                // A computer that is restarting or a missing file: try again on the next tick.
            }
            await Task.Delay(state.Ended ? TimeSpan.FromSeconds(5) : Interval);
        }
    }
}
