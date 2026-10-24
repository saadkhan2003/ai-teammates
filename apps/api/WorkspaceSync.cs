using System.Collections.Concurrent;
using System.Formats.Tar;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using Npgsql;
using Teammates.Compute;

namespace Teammates.Api;

public sealed record DiskFile(string Path, long Size, long MtimeNs);
public sealed record StoredFile(string Path, long SizeBytes, long MtimeNs, string Sha256, string ObjectKey, Guid? SourceComputer);
public sealed record PushPlan(IReadOnlyList<DiskFile> Upload, IReadOnlyList<StoredFile> Delete, IReadOnlyList<DiskFile> SkippedQuota, IReadOnlyList<DiskFile> TooLarge);
public sealed record SyncReport(Guid BotId, string Direction, int Files, long Bytes, int Deleted, int SkippedQuota, string? Error);

/// <summary>Pure decisions for workspace sync, unit-tested without a computer.</summary>
public static class SyncPlan
{
    /// <summary>The container archive API wraps the packed tar in another tar. Copy the inner tar to a private,
    /// delete-on-close temp file first: reading a tar nested inside a forward-only tar stream is unreliable.</summary>
    public static async Task<FileStream> OpenPackedAsync(Stream outer, CancellationToken ct)
    {
        using var outerReader = new TarReader(outer, leaveOpen: true);
        var wrapper = await outerReader.GetNextEntryAsync(false, ct);
        if (wrapper is null || wrapper.EntryType is not (TarEntryType.RegularFile or TarEntryType.V7RegularFile) || wrapper.DataStream is null)
            throw new InvalidOperationException("pack archive missing");
        var path = Path.Combine(Path.GetTempPath(), "tm-pack-" + Guid.NewGuid().ToString("n"));
        var file = new FileStream(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 81920, FileOptions.DeleteOnClose);
        try
        {
            await wrapper.DataStream.CopyToAsync(file, ct);
            file.Position = 0;
            return file;
        }
        catch { await file.DisposeAsync(); throw; }
    }

    public const long MaxFileBytes = 1L << 30;

    /// <summary>What to save before sleep. Deletions are only trusted when the disk descends from the last sync
    /// (its token matches), so a fresh or restored disk never wipes stored files.</summary>
    public static PushPlan Push(IReadOnlyList<DiskFile> disk, IReadOnlyList<StoredFile> stored, bool lineage, long usedBytes, long quotaBytes)
    {
        var byPath = stored.ToDictionary(f => f.Path, StringComparer.Ordinal);
        var onDisk = disk.Select(f => f.Path).ToHashSet(StringComparer.Ordinal);
        var delete = lineage ? stored.Where(f => !onDisk.Contains(f.Path)).ToList() : [];
        var used = usedBytes - delete.Sum(f => f.SizeBytes);
        var upload = new List<DiskFile>();
        var skipped = new List<DiskFile>();
        var large = new List<DiskFile>();
        var changed = disk.Where(f => !byPath.TryGetValue(f.Path, out var s) || s.SizeBytes != f.Size || s.MtimeNs != f.MtimeNs)
            .OrderBy(f => f.Size - (byPath.TryGetValue(f.Path, out var s) ? s.SizeBytes : 0)).ThenBy(f => f.Path, StringComparer.Ordinal);
        foreach (var file in changed)
        {
            if (file.Size > MaxFileBytes) { large.Add(file); continue; }
            var delta = file.Size - (byPath.TryGetValue(file.Path, out var old) ? old.SizeBytes : 0);
            if (delta > 0 && used + delta > quotaBytes) { skipped.Add(file); continue; }
            used += delta;
            upload.Add(file);
        }
        return new PushPlan(upload, delete, skipped, large);
    }

    /// <summary>What to restore on wake: stored files missing on this disk, or newer in storage than on disk.
    /// A disk in lineage is already current and pulls nothing.</summary>
    public static IReadOnlyList<StoredFile> Pull(IReadOnlyList<DiskFile> disk, IReadOnlyList<StoredFile> stored, bool lineage)
    {
        if (lineage) return [];
        var byPath = disk.ToDictionary(f => f.Path, StringComparer.Ordinal);
        return stored.Where(s => !byPath.TryGetValue(s.Path, out var d) || (s.MtimeNs > d.MtimeNs && (s.SizeBytes != d.Size || s.MtimeNs != d.MtimeNs)))
            .OrderBy(s => s.Path, StringComparer.Ordinal).ToList();
    }

    public static bool SafePath(string path) =>
        path.Length is > 0 and <= 1024 && !path.StartsWith('/') && !path.Contains('\0') && !path.Split('/').Any(part => part is "" or "." or "..");

    public static string ObjectKey(Guid owner, Guid bot, string sha256) => $"files/{owner:N}/{bot:N}/{sha256}";
}

/// <summary>Mirrors each bot's saved files between its computer's SSD working dir and object storage:
/// pull on wake (in the background), push before sleep. Runs the in-computer half as the bot's own uid.</summary>
public sealed class WorkspaceSync(Platform platform, IObjectStore store, ILogger? logger = null)
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _gates = new();
    private static string? _script;
    public IObjectStore Store => store;
    public bool Enabled { get; init; } = true;

    public async Task<IReadOnlyList<SyncReport>> PushAsync(ComputerId computer, CancellationToken ct) => await EachBot(computer, PushBotAsync, ct);
    public async Task<IReadOnlyList<SyncReport>> PullAsync(ComputerId computer, CancellationToken ct) => await EachBot(computer, PullBotAsync, ct);

    private async Task<IReadOnlyList<SyncReport>> EachBot(ComputerId computer, Func<ComputerId, Guid, Guid, CancellationToken, Task<SyncReport>> run, CancellationToken ct)
    {
        if (!Enabled || !Guid.TryParse(computer.Value, out var computerId)) return [];
        var gate = _gates.GetOrAdd(computer.Value, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            List<(Guid Bot, Guid Owner)> bots;
            await using (var conn = await platform.Data.OpenConnectionAsync(ct))
            {
                var owner = await ComputerNeed.OwnerOfComputer(conn, computerId);
                if (owner is null) return [];
                bots = (await conn.QueryAsync<Guid>("SELECT id FROM bots WHERE owner_id=@owner ORDER BY created_at", new { owner })).Select(b => (b, owner.Value)).ToList();
            }
            var reports = new List<SyncReport>();
            foreach (var (bot, owner) in bots)
            {
                if ((await platform.PlacementForBot(bot, ct)).Computer.Value != computer.Value) continue;
                SyncReport report;
                try { report = await run(computer, bot, owner, ct); }
                catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
                {
                    report = new SyncReport(bot, "error", 0, 0, 0, 0, OutputRedactor.Redact(ex.Message));
                    await using var conn = await platform.Data.OpenConnectionAsync(CancellationToken.None);
                    await conn.ExecuteAsync("""
                        INSERT INTO workspace_sync (computer_id, bot_id, token, last_error) VALUES (@computerId, @bot, '', @error)
                        ON CONFLICT (computer_id, bot_id) DO UPDATE SET last_error=EXCLUDED.last_error
                        """, new { computerId, bot, error = report.Error!.Length > 300 ? report.Error[..300] : report.Error });
                    if (logger != null) logger.LogWarning(ex, "workspace sync failed {Bot}", bot);
                    else Console.Error.WriteLine($"workspace sync failed {bot}: {OutputRedactor.Redact(ex.ToString())}");
                }
                reports.Add(report);
            }
            return reports;
        }
        finally { gate.Release(); }
    }

    public async Task<SyncReport> PushBotAsync(ComputerId computer, Guid bot, Guid owner, CancellationToken ct)
    {
        var computerId = Guid.Parse(computer.Value);
        var (diskToken, disk) = await ManifestAsync(computer, bot, ct);
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var stored = await StoredAsync(conn, bot);
        var dbToken = await conn.ExecuteScalarAsync<string?>("SELECT token FROM workspace_sync WHERE computer_id=@computerId AND bot_id=@bot", new { computerId, bot });
        var lineage = !string.IsNullOrEmpty(diskToken) && diskToken == dbToken;
        if (!lineage && stored.Count > 0)
        {
            // A disk that did not come from the last sync must restore first, or edits would be judged against the wrong base.
            await PullBotAsync(computer, bot, owner, ct);
            (diskToken, disk) = await ManifestAsync(computer, bot, ct);
            stored = await StoredAsync(conn, bot);
            dbToken = await conn.ExecuteScalarAsync<string?>("SELECT token FROM workspace_sync WHERE computer_id=@computerId AND bot_id=@bot", new { computerId, bot });
            lineage = !string.IsNullOrEmpty(diskToken) && diskToken == dbToken;
        }
        var used = (await ResourceMeter.UsedAsync(conn, owner)) is var u ? u.Files + u.Artifacts : 0;
        var plan = await platform.Usage.PlanOfAsync(conn, owner);
        var push = SyncPlan.Push(disk, stored, lineage, used, Math.Max(1, plan.StorageQuotaGb) * StorageRules.GiB);
        long bytes = 0;
        var uploaded = 0;
        if (push.Upload.Count > 0)
        {
            var want = push.Upload.Select(f => f.Path).ToHashSet(StringComparer.Ordinal);
            var wantName = ".sync-want-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLowerInvariant() + ".json";
            var wantFile = BotFs.Root(bot) + "/" + wantName;
            var owningUid = await BotFs.EnsureAsync(platform.Compute, computer, bot, ct);
            await PutSmallFileAsync(computer, wantFile, JsonSerializer.SerializeToUtf8Bytes(want), owningUid, ct);
            string? tarPath = null;
            try
            {
                var packed = await RunAsync(computer, bot, ["pack", wantName], ct);
                tarPath = packed.GetProperty("tar").GetString();
                if (tarPath is null || !tarPath.StartsWith(BotFs.Root(bot) + "/.sync-out-", StringComparison.Ordinal) || tarPath.IndexOf('/', BotFs.Root(bot).Length + 1) >= 0 || tarPath.Contains("..")) throw new InvalidOperationException("bad pack path");
                await using var outer = await platform.Compute.GetArchiveAsync(computer, tarPath, ct);
                await using var inner = await SyncPlan.OpenPackedAsync(outer, ct);
                using var reader = new TarReader(inner);
                while (await reader.GetNextEntryAsync(false, ct) is { } entry)
                {
                    if (entry.EntryType is not (TarEntryType.RegularFile or TarEntryType.V7RegularFile) || entry.DataStream is null) continue;
                    if (!SyncPlan.SafePath(entry.Name) || !want.Remove(entry.Name)) continue;
                    var temp = Path.Combine(Path.GetTempPath(), "tm-up-" + Guid.NewGuid().ToString("n"));
                    try
                    {
                        string sha;
                        long size;
                        await using (var file = new FileStream(temp, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 81920, FileOptions.DeleteOnClose))
                        {
                            using (var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
                            {
                                var buffer = new byte[81920];
                                int read;
                                while ((read = await entry.DataStream.ReadAsync(buffer, ct)) > 0)
                                {
                                    hash.AppendData(buffer, 0, read);
                                    await file.WriteAsync(buffer.AsMemory(0, read), ct);
                                }
                                sha = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
                            }
                            size = file.Length;
                            var key = SyncPlan.ObjectKey(owner, bot, sha);
                            if (!stored.Any(s => s.ObjectKey == key))
                            {
                                file.Position = 0;
                                await store.PutAsync(key, file, size, ct);
                            }
                            var mtime = entry is PaxTarEntry pax && pax.ExtendedAttributes.TryGetValue("mtime_ns", out var ns) && long.TryParse(ns, out var parsed)
                                ? parsed : entry.ModificationTime.ToUnixTimeMilliseconds() * 1_000_000;
                            await conn.ExecuteAsync("""
                                INSERT INTO stored_files (bot_id, path, owner_id, size_bytes, mtime_ns, sha256, object_key, source_computer, updated_at)
                                VALUES (@bot, @path, @owner, @size, @mtime, @sha, @key, @computerId, now())
                                ON CONFLICT (bot_id, path) DO UPDATE SET size_bytes=EXCLUDED.size_bytes, mtime_ns=EXCLUDED.mtime_ns, sha256=EXCLUDED.sha256,
                                  object_key=EXCLUDED.object_key, source_computer=EXCLUDED.source_computer, updated_at=now()
                                """, new { bot, path = entry.Name, owner, size, mtime, sha, key, computerId });
                        }
                        bytes += size;
                        uploaded++;
                    }
                    finally { if (File.Exists(temp)) File.Delete(temp); }
                }
            }
            finally
            {
                await RootAsync(computer, ["rm", "-f", "--", wantFile, .. tarPath is null ? Array.Empty<string>() : [tarPath]], CancellationToken.None);
            }
        }
        foreach (var gone in push.Delete)
        {
            await conn.ExecuteAsync("DELETE FROM stored_files WHERE bot_id=@bot AND path=@path", new { bot, path = gone.Path });
            if (await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM stored_files WHERE object_key=@key", new { key = gone.ObjectKey }) == 0)
                await store.DeleteAsync(gone.ObjectKey, ct);
        }
        var token = lineage ? diskToken : NewToken();
        if (!lineage) await RunAsync(computer, bot, ["token", token], ct);
        await conn.ExecuteAsync("""
            INSERT INTO workspace_sync (computer_id, bot_id, token, pushed_at, pushed_files, skipped_quota, last_error)
            VALUES (@computerId, @bot, @token, now(), @uploaded, @skipped, NULL)
            ON CONFLICT (computer_id, bot_id) DO UPDATE SET token=EXCLUDED.token, pushed_at=now(), pushed_files=EXCLUDED.pushed_files,
              skipped_quota=EXCLUDED.skipped_quota, last_error=NULL
            """, new { computerId, bot, token, uploaded, skipped = push.SkippedQuota.Count + push.TooLarge.Count });
        platform.Resources.Invalidate(owner);
        if (push.SkippedQuota.Count > 0)
            await platform.Audit("policy", "storage.full", bot, null, new { skipped = push.SkippedQuota.Count, code = StorageRules.FullCode });
        return new SyncReport(bot, "push", uploaded, bytes, push.Delete.Count, push.SkippedQuota.Count + push.TooLarge.Count, null);
    }

    public async Task<SyncReport> PullBotAsync(ComputerId computer, Guid bot, Guid owner, CancellationToken ct)
    {
        var computerId = Guid.Parse(computer.Value);
        var (diskToken, disk) = await ManifestAsync(computer, bot, ct);
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var stored = await StoredAsync(conn, bot);
        var dbToken = await conn.ExecuteScalarAsync<string?>("SELECT token FROM workspace_sync WHERE computer_id=@computerId AND bot_id=@bot", new { computerId, bot });
        var lineage = !string.IsNullOrEmpty(diskToken) && diskToken == dbToken;
        var pull = SyncPlan.Pull(disk, stored, lineage);
        var token = lineage ? diskToken : NewToken();
        long bytes = 0;
        var placed = 0;
        if (pull.Count > 0)
        {
            var uid = await BotFs.EnsureAsync(platform.Compute, computer, bot, ct);
            var stage = ".sync-in-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLowerInvariant();
            var temp = Path.Combine(Path.GetTempPath(), "tm-down-" + Guid.NewGuid().ToString("n") + ".tar");
            try
            {
                var meta = new Dictionary<string, long>(StringComparer.Ordinal);
                await using (var file = new FileStream(temp, FileMode.CreateNew, FileAccess.Write))
                await using (var writer = new TarWriter(file, TarEntryFormat.Pax, leaveOpen: true))
                {
                    await writer.WriteEntryAsync(new PaxTarEntry(TarEntryType.Directory, stage + "/") { Mode = (UnixFileMode)0b111_000_000, Uid = uid, Gid = uid }, ct);
                    var dirs = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var item in pull)
                    {
                        if (!SyncPlan.SafePath(item.Path)) continue;
                        await using var body = await store.GetAsync(item.ObjectKey, ct);
                        if (body is null) continue;
                        var parts = item.Path.Split('/');
                        for (var i = 1; i < parts.Length; i++)
                        {
                            var dir = string.Join('/', parts[..i]);
                            if (dirs.Add(dir))
                                await writer.WriteEntryAsync(new PaxTarEntry(TarEntryType.Directory, stage + "/" + dir + "/") { Mode = (UnixFileMode)0b111_000_000, Uid = uid, Gid = uid }, ct);
                        }
                        await using var buffered = new FileStream(Path.Combine(Path.GetTempPath(), "tm-obj-" + Guid.NewGuid().ToString("n")), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 81920, FileOptions.DeleteOnClose);
                        await body.CopyToAsync(buffered, ct);
                        buffered.Position = 0;
                        await writer.WriteEntryAsync(new PaxTarEntry(TarEntryType.RegularFile, stage + "/" + item.Path) { Mode = (UnixFileMode)0b110_000_000, Uid = uid, Gid = uid, DataStream = buffered }, ct);
                        meta[item.Path] = item.MtimeNs;
                        bytes += item.SizeBytes;
                    }
                    var metaBytes = JsonSerializer.SerializeToUtf8Bytes(meta);
                    await writer.WriteEntryAsync(new PaxTarEntry(TarEntryType.RegularFile, stage + "/.meta.json") { Mode = (UnixFileMode)0b110_000_000, Uid = uid, Gid = uid, DataStream = new MemoryStream(metaBytes) }, ct);
                }
                await using (var upload = File.OpenRead(temp))
                    await platform.Compute.PutArchiveAsync(computer, BotFs.Root(bot), upload, ct);
                // The archive API writes as root; hand the fresh, randomly named stage to the bot's uid without following links.
                await RootAsync(computer, ["chown", "-R", "-h", "--", uid + ":" + uid, BotFs.Root(bot) + "/" + stage], ct);
                var result = await RunAsync(computer, bot, ["place", stage, token], ct);
                placed = result.TryGetProperty("placed", out var p) ? p.GetInt32() : 0;
            }
            finally { if (File.Exists(temp)) File.Delete(temp); }
        }
        else if (!lineage) await RunAsync(computer, bot, ["token", token], ct);
        await conn.ExecuteAsync("""
            INSERT INTO workspace_sync (computer_id, bot_id, token, pulled_at, pulled_files, last_error)
            VALUES (@computerId, @bot, @token, now(), @placed, NULL)
            ON CONFLICT (computer_id, bot_id) DO UPDATE SET token=EXCLUDED.token, pulled_at=now(), pulled_files=EXCLUDED.pulled_files, last_error=NULL
            """, new { computerId, bot, token, placed });
        return new SyncReport(bot, "pull", placed, bytes, 0, 0, null);
    }

    private static async Task<List<StoredFile>> StoredAsync(NpgsqlConnection conn, Guid bot) =>
        (await conn.QueryAsync<StoredFile>(
            "SELECT path AS Path, size_bytes AS SizeBytes, mtime_ns AS MtimeNs, sha256 AS Sha256, object_key AS ObjectKey, source_computer AS SourceComputer FROM stored_files WHERE bot_id=@bot",
            new { bot })).ToList();

    private async Task<(string Token, List<DiskFile> Files)> ManifestAsync(ComputerId computer, Guid bot, CancellationToken ct)
    {
        var json = await RunAsync(computer, bot, ["manifest"], ct);
        var files = new List<DiskFile>();
        foreach (var row in json.GetProperty("files").EnumerateArray())
        {
            var path = row[0].GetString() ?? "";
            var mtimeNs = row.GetArrayLength() >= 4 ? row[2].GetInt64() * 1_000_000_000L + row[3].GetInt64() : row[2].GetInt64();
            if (SyncPlan.SafePath(path)) files.Add(new DiskFile(path, row[1].GetInt64(), mtimeNs));
        }
        return (json.GetProperty("token").GetString() ?? "", files);
    }

    private async Task<JsonElement> RunAsync(ComputerId computer, Guid bot, string[] args, CancellationToken ct)
    {
        var spec = await BotFs.ConfinedAsync(platform.Compute, computer, bot, ["python3", "-c", Script(), .. args], null, null, TimeSpan.FromMinutes(2), 32UL << 20, ct);
        var (code, stdout, stderr) = await BotFs.Capture(platform.Compute, spec, ct);
        if (code != 0) throw new InvalidOperationException("sync helper failed: " + (stderr.Length > 200 ? stderr[..200] : stderr));
        var line = stdout.Trim().Split('\n').LastOrDefault() ?? "{}";
        using var doc = JsonDocument.Parse(line);
        return doc.RootElement.Clone();
    }

    private async Task RootAsync(ComputerId computer, IReadOnlyList<string> argv, CancellationToken ct)
    {
        try { await BotFs.Capture(platform.Compute, new ExecSpec(computer, argv, "/", new Dictionary<string, string>(), [], "", TimeSpan.FromSeconds(60), 8192, false), ct); }
        catch (Exception ex) when (ex is not OperationCanceledException) { logger?.LogDebug("sync root step failed {Message}", ex.Message); }
    }

    private async Task PutSmallFileAsync(ComputerId computer, string path, byte[] content, int uid, CancellationToken ct)
    {
        using var tar = new MemoryStream();
        await using (var writer = new TarWriter(tar, TarEntryFormat.Pax, leaveOpen: true))
            await writer.WriteEntryAsync(new PaxTarEntry(TarEntryType.RegularFile, Path.GetFileName(path)) { Mode = (UnixFileMode)0b110_000_000, Uid = uid, Gid = uid, DataStream = new MemoryStream(content) }, ct);
        tar.Position = 0;
        await platform.Compute.PutArchiveAsync(computer, Path.GetDirectoryName(path)!, tar, ct);
        // Docker's archive upload does not keep the tar uid by default; hand the 0600 file to the bot uid explicitly.
        await RootAsync(computer, ["chown", "-h", $"{uid}:{uid}", "--", path], ct);
    }

    private static string NewToken() => Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();

    private static string Script()
    {
        if (_script != null) return _script;
        using var stream = typeof(WorkspaceSync).Assembly.GetManifestResourceStream("workspace_sync.py") ?? throw new InvalidOperationException("sync helper missing");
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return _script = reader.ReadToEnd();
    }
}
