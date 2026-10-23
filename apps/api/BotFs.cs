using System.Collections.Concurrent;
using System.Text;
using Teammates.Compute;

namespace Teammates.Api;

/// <summary>
/// Each bot's files live under /data/workspace/bots/{id} and are owned by that bot's uid.
/// Shell and file tools run as that uid, so a sibling directory is not readable.
/// </summary>
public static class BotFs
{
    public const string Prefix = "/data/workspace/bots/";
    private static readonly ConcurrentDictionary<string, int> Uids = new();
    private static string? _source;

    public static string IdOf(Guid botId) => botId.ToString("N");

    public static string Root(Guid botId) => Prefix + IdOf(botId);

    public static string RewriteCommand(Guid botId, string? command)
    {
        if (string.IsNullOrEmpty(command)) return command ?? "";
        if (System.Text.RegularExpressions.Regex.IsMatch(command, @"(?:^|/)\.\.(?:/|$)"))
            throw new ToolHalt("denied", "path_escapes_workspace");
        return System.Text.RegularExpressions.Regex.Replace(command, @"(?<![\w/.-])/workspace(?=/|[^\w.-]|$)", _ => Root(botId));
    }

    public static IReadOnlyList<string> ShellArgs(string command)
    {
        using var stream = typeof(BotFs).Assembly.GetManifestResourceStream("workspace_shell.py")!;
        using var reader = new StreamReader(stream);
        return ["python3", "-c", reader.ReadToEnd(), command];
    }

    public static void Forget(Guid botId) => Uids.TryRemove(IdOf(botId), out _);

    public static async Task<int> EnsureAsync(IComputeProvider compute, ComputerId computer, Guid botId, CancellationToken ct)
    {
        var id = IdOf(botId);
        if (Uids.TryGetValue(id, out var cached)) return cached;
        var (code, stdout, stderr) = await Capture(compute, RootSpec(computer, ["python3", "-c", Script("print(ensure(sys.argv[1]))"), id], TimeSpan.FromSeconds(20)), ct);
        if (code != 0 || !int.TryParse((stdout ?? "").Trim(), out var uid) || uid < 1000)
        {
            var detail = string.IsNullOrWhiteSpace(stderr) ? stdout : stderr;
            throw new ToolHalt("denied", "workspace_unavailable " + (detail ?? "").Trim());
        }
        Uids[id] = uid;
        return uid;
    }

    public static async Task WipeAsync(IComputeProvider compute, ComputerId computer, Guid botId, CancellationToken ct)
    {
        Forget(botId);
        try
        {
            await Capture(compute, RootSpec(computer, ["python3", "-c", Script("wipe(sys.argv[1])"), IdOf(botId)], TimeSpan.FromSeconds(20)), ct);
        }
        catch (ComputeException)
        {
            // The directory is removed the next time this computer wakes and wipe runs again.
        }
    }

    public static async Task<ExecSpec> ConfinedAsync(IComputeProvider compute, ComputerId computer, Guid botId, IReadOnlyList<string> argv, IReadOnlyDictionary<string, string>? env, IReadOnlyList<SecretEnvBinding>? secrets, TimeSpan timeout, ulong maxOutput, CancellationToken ct)
    {
        var uid = await EnsureAsync(compute, computer, botId, ct);
        var root = Root(botId);
        var merged = env == null ? new Dictionary<string, string>() : new Dictionary<string, string>(env);
        merged["BOT_ROOT"] = root;
        merged["BOT_ID"] = IdOf(botId);
        merged["HOME"] = root;
        return new ExecSpec(computer, argv, root, merged, secrets ?? [], uid + ":" + uid, timeout, maxOutput, false);
    }

    public static string Script(string call)
    {
        var source = Source();
        return source + "\nimport sys\ntry:\n    " + call + "\nexcept PermissionError as exc:\n    print(exc)\n    raise SystemExit(4)\n";
    }

    private static ExecSpec RootSpec(ComputerId computer, IReadOnlyList<string> argv, TimeSpan timeout) =>
        new(computer, argv, "/", new Dictionary<string, string>(), [], "", timeout, 32_768, false);

    public static async Task<(int Code, string Stdout, string Stderr)> Capture(IComputeProvider compute, ExecSpec spec, CancellationToken ct)
    {
        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        var code = 0;
        await foreach (var item in compute.ExecAsync(spec, IdempotencyKey.Require(Guid.NewGuid().ToString("n")), ct))
        {
            if (item is ExecStdout outEvent) stdout.Append(Encoding.UTF8.GetString(outEvent.Data));
            if (item is ExecStderr errEvent) stderr.Append(Encoding.UTF8.GetString(errEvent.Data));
            if (item is ExecExited exited) code = exited.ExitCode;
            if (item is ExecError error) throw new ToolHalt("denied", error.Message);
        }
        return (code, stdout.ToString(), stderr.ToString());
    }

    private static string Source()
    {
        if (_source != null) return _source;
        using var stream = typeof(BotFs).Assembly.GetManifestResourceStream("workspace.py");
        if (stream == null) throw new InvalidOperationException("workspace helper missing");
        using var reader = new StreamReader(stream);
        _source = reader.ReadToEnd();
        return _source;
    }
}
