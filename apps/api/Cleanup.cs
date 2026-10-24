using System.Text.Json;
using Dapper;
using Teammates.Compute;

namespace Teammates.Api;

public sealed record BackupInfo(string Id, string Computer, DateTimeOffset CreatedAt);
public sealed record CleanupResult(long RunId, int Computers, int RemovedFiles, long RemovedBytes, int RemovedBackups, int RemovedStoredDownloads);

/// <summary>Nightly cleanup rules, kept pure for tests.</summary>
public static class CleanupRules
{
    /// <summary>Snapshots to delete so each computer keeps only its newest <paramref name="keep"/> backups.</summary>
    public static IReadOnlyList<string> BackupsToDelete(IEnumerable<BackupInfo> backups, int keep) =>
        backups.GroupBy(b => b.Computer, StringComparer.Ordinal)
            .SelectMany(g => g.OrderByDescending(b => b.CreatedAt).ThenByDescending(b => b.Id, StringComparer.Ordinal).Skip(Math.Max(1, keep)))
            .Select(b => b.Id).ToList();

    public static bool Due(DateTimeOffset now, DateTimeOffset? lastNightly, int hourUtc) =>
        now.Hour == hourUtc && (lastNightly is null || now - lastNightly.Value > TimeSpan.FromHours(20));

    /// <summary>Root shell script run inside a computer. find(1) never follows symlinks (-P) and stays on one filesystem (-xdev),
    /// so a bot cannot steer the deletion outside its own temp, cache and download dirs. Job folders are never touched.
    /// Prints "files bytes".</summary>
    public static string Script(int downloadDays) => $$"""
        set -u
        n=0; b=0
        sweep() {
          while IFS= read -r s; do n=$((n+1)); b=$((b+s)); done < <(find -P "$@" -xdev -type f -printf '%s\n' -delete 2>/dev/null)
        }
        [ -d /tmp ] && sweep /tmp -mindepth 1 -mmin +1440 ! -path '/tmp/.X11-unix/*' ! -name '.X*-lock'
        [ -d /var/tmp ] && sweep /var/tmp -mindepth 1 -mmin +1440
        for home in /root /home/* /data/workspace/bots/*; do
          [ -d "$home" ] || continue
          [ -d "$home/.cache" ] && sweep "$home/.cache" -mindepth 1
          [ -d "$home/Downloads" ] && sweep "$home/Downloads" -mindepth 1 -mtime +{{downloadDays}}
        done
        [ -d /data/workspace/bots ] && sweep /data/workspace/bots -mindepth 2 -path '*/__pycache__/*' -name '*.pyc'
        [ -d /data/workspace/bots ] && sweep /data/workspace/bots -mindepth 2 -path '*/.sync-in-*' -mmin +60
        if [ -d /data/profiles ]; then
          sweep /data/profiles \( -path '*/Cache/*' -o -path '*/Code Cache/*' -o -path '*/GPUCache/*' -o -path '*/Service Worker/CacheStorage/*' -o -path '*/ShaderCache/*' -o -path '*/GrShaderCache/*' \)
          sweep /data/profiles -path '*/Downloads/*' -mtime +{{downloadDays}}
        fi
        echo "$n $b"
        """;
}

/// <summary>Removes temp files, caches and old downloads from awake computers (never wakes a sleeping one; those are cleaned
/// in their next before-sleep pass) and keeps only the newest N backups per computer.</summary>
public sealed class CleanupService(Platform platform, IConfiguration config, ILogger? logger = null)
{
    public int Hour => int.TryParse(config["CLEANUP_HOUR_UTC"], out var h) && h is >= 0 and < 24 ? h : 21; // 02:00 PKT
    public int KeepBackups => int.TryParse(config["CLEANUP_KEEP_BACKUPS"], out var k) && k > 0 ? k : 3;
    public int DownloadDays => int.TryParse(config["CLEANUP_DOWNLOAD_DAYS"], out var d) && d > 0 ? d : 30;
    public string SnapshotDir => config["SNAPSHOT_DIR"] ?? "/tmp/teammates-snapshots";

    public async Task TickAsync(CancellationToken ct)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var last = await conn.ExecuteScalarAsync<DateTime?>("SELECT max(started_at) FROM cleanup_runs WHERE trigger='nightly'");
        var lastAt = last is null ? (DateTimeOffset?)null : new DateTimeOffset(DateTime.SpecifyKind(last.Value, DateTimeKind.Utc));
        if (CleanupRules.Due(DateTimeOffset.UtcNow, lastAt, Hour)) await RunAsync("nightly", null, ct);
    }

    public async Task<(int Files, long Bytes)> CleanComputerAsync(ComputerId computer, CancellationToken ct)
    {
        var spec = new ExecSpec(computer, ["bash", "-c", CleanupRules.Script(DownloadDays)], "/", new Dictionary<string, string>(), [], "", TimeSpan.FromMinutes(5), 4096, false);
        var (code, stdout, _) = await BotFs.Capture(platform.Compute, spec, ct);
        var parts = stdout.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (code != 0 || parts.Length < 2) return (0, 0);
        if (Guid.TryParse(computer.Value, out var id))
        {
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            await conn.ExecuteAsync("UPDATE workspace_sync SET cleaned_at=now() WHERE computer_id=@id", new { id });
        }
        return (int.TryParse(parts[0], out var n) ? n : 0, long.TryParse(parts[1], out var b) ? b : 0);
    }

    /// <summary>Before sleep: clean the disk if it has not been cleaned in a day, so storage and the next push stay small.</summary>
    public async Task CleanBeforeSleepAsync(ComputerId computer, CancellationToken ct)
    {
        if (!Guid.TryParse(computer.Value, out var id)) return;
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var cleaned = await conn.ExecuteScalarAsync<DateTime?>("SELECT min(coalesce(cleaned_at, 'epoch'::timestamptz)) FROM workspace_sync WHERE computer_id=@id", new { id });
        if (cleaned is { } at && DateTime.UtcNow - DateTime.SpecifyKind(at, DateTimeKind.Utc) < TimeSpan.FromHours(24)) return;
        await CleanComputerAsync(computer, ct);
    }

    public async Task<CleanupResult> RunAsync(string trigger, string? actor, CancellationToken ct)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var runId = await conn.ExecuteScalarAsync<long>("INSERT INTO cleanup_runs (trigger) VALUES (@trigger) RETURNING id", new { trigger });
        var computers = 0; var files = 0; long bytes = 0;
        var errors = new List<string>();
        foreach (var item in platform.Compute.PowerSnapshot().Where(p => p.Power == "awake"))
        {
            try
            {
                var (n, b) = await CleanComputerAsync(new ComputerId(item.Id), ct);
                computers++; files += n; bytes += b;
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { errors.Add(OutputRedactor.Redact(ex.Message)); }
        }
        // Old downloads already saved to object storage go too (same age rule as on disk, by file mtime).
        var cutoffNs = (DateTimeOffset.UtcNow - TimeSpan.FromDays(DownloadDays)).ToUnixTimeMilliseconds() * 1_000_000;
        var oldDownloads = (await conn.QueryAsync<(Guid Bot, string Path, string Key, Guid Owner)>(
            "SELECT bot_id, path, object_key, owner_id FROM stored_files WHERE (path LIKE 'Downloads/%' OR path LIKE '%/Downloads/%') AND mtime_ns < @cutoffNs",
            new { cutoffNs })).ToList();
        foreach (var row in oldDownloads)
        {
            await conn.ExecuteAsync("DELETE FROM stored_files WHERE bot_id=@Bot AND path=@Path", new { row.Bot, row.Path });
            if (await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM stored_files WHERE object_key=@Key", new { row.Key }) == 0)
            {
                try { await platform.Sync.Store.DeleteAsync(row.Key, ct); } catch (Exception ex) when (ex is not OperationCanceledException) { errors.Add("object delete failed"); }
            }
            platform.Resources.Invalidate(row.Owner);
        }
        var removedBackups = PruneBackups(errors);
        await conn.ExecuteAsync("""
            UPDATE cleanup_runs SET finished_at=now(), computers=@computers, removed_files=@files, removed_bytes=@bytes, removed_backups=@removedBackups,
              detail=CAST(@detail AS jsonb) WHERE id=@runId
            """, new { runId, computers, files = files + oldDownloads.Count, bytes, removedBackups, detail = JsonSerializer.Serialize(new { errors = errors.Take(10), storedDownloads = oldDownloads.Count, keep = KeepBackups, downloadDays = DownloadDays }) });
        await platform.Audit(actor ?? "system", "cleanup.run", null, null, new { trigger, computers, files, bytes, removedBackups, storedDownloads = oldDownloads.Count });
        logger?.LogInformation("cleanup {Trigger} computers {Computers} files {Files} bytes {Bytes} backups {Backups}", trigger, computers, files, bytes, removedBackups);
        return new CleanupResult(runId, computers, files, bytes, removedBackups, oldDownloads.Count);
    }

    public IReadOnlyList<BackupInfo> ListBackups()
    {
        var list = new List<BackupInfo>();
        if (!Directory.Exists(SnapshotDir)) return list;
        foreach (var dir in Directory.EnumerateDirectories(SnapshotDir))
        {
            var id = Path.GetFileName(dir);
            if (id.Length != 32 || !id.All(Uri.IsHexDigit)) continue;
            var computer = "unknown";
            var created = new DateTimeOffset(Directory.GetLastWriteTimeUtc(dir), TimeSpan.Zero);
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(dir, "meta.json")));
                computer = doc.RootElement.GetProperty("computerId").GetString() ?? computer;
                if (doc.RootElement.TryGetProperty("createdAt", out var c) && c.TryGetDateTimeOffset(out var at)) created = at;
            }
            catch (Exception ex) when (ex is IOException or JsonException or KeyNotFoundException or UnauthorizedAccessException) { }
            list.Add(new BackupInfo(id, computer, created));
        }
        return list;
    }

    private int PruneBackups(List<string> errors)
    {
        var removed = 0;
        foreach (var id in CleanupRules.BackupsToDelete(ListBackups(), KeepBackups))
        {
            try { Directory.Delete(Path.Combine(SnapshotDir, id), true); removed++; }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { errors.Add("backup delete failed"); }
        }
        return removed;
    }
}
