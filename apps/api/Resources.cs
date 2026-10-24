using System.Collections.Concurrent;
using Dapper;
using Npgsql;
using Teammates.Compute;

namespace Teammates.Api;

public sealed record StorageStatus(long UsedBytes, long QuotaBytes, int WarnPct, double Percent, string State, long FilesBytes, long ArtifactsBytes);

public sealed record ComputerResourceView(Guid ComputerId, string Power, long MemoryBytes, long MemoryLimitBytes, long MemoryPeakBytes, decimal CpuMinCores, decimal CpuMaxCores, DateTimeOffset? SampledAt);

/// <summary>Per-user storage quota. Warn at the plan's warn percent; at 100% block new writes (not deletes or shell, so the user can free space).</summary>
public static class StorageRules
{
    public const string Ok = "ok", Warning = "warning", Full = "full";
    public const string FullCode = "storage_full";
    public const long GiB = 1024L * 1024 * 1024;

    public static readonly IReadOnlySet<string> WriteTools = new HashSet<string>(StringComparer.Ordinal)
    {
        "write_file", "edit_file", "save_artifact", "setup_env", "job_start", "git_commit", "record_start", "write_skill"
    };

    public static bool Writes(string tool) => WriteTools.Contains(tool);

    public static StorageStatus Status(long files, long artifacts, BillingPlan plan)
    {
        var used = Math.Max(0, files) + Math.Max(0, artifacts);
        var quota = Math.Max(1, plan.StorageQuotaGb) * GiB;
        var percent = Math.Round(used * 100.0 / quota, 1);
        var state = used >= quota ? Full : percent >= plan.StorageWarnPct ? Warning : Ok;
        return new StorageStatus(used, quota, plan.StorageWarnPct, Math.Min(percent, 100), state, files, artifacts);
    }

    public static string Gb(long bytes) => (bytes / (double)GiB).ToString(bytes >= 10 * GiB ? "0" : "0.0", System.Globalization.CultureInfo.InvariantCulture) + " GB";

    public static string FullMessage(StorageStatus s) =>
        $"Your storage is full ({Gb(s.UsedBytes)} of {Gb(s.QuotaBytes)}). New files can't be saved until you delete files or old downloads, or upgrade your plan in Settings → Usage.";

    public static string? WarningMessage(StorageStatus s) => s.State switch
    {
        Warning => $"You've used {s.Percent:0}% of your storage ({Gb(s.UsedBytes)} of {Gb(s.QuotaBytes)}). At 100% new files can't be saved.",
        Full => FullMessage(s),
        _ => null
    };
}

/// <summary>Plan → computer limits. RAM is a ceiling (the host overcommits); CPU min is the weight under contention, max is the burst cap.</summary>
public static class PlanLimits
{
    public static ulong MemoryBytes(BillingPlan plan) => (ulong)Math.Max(512, plan.RamMb) * 1024UL * 1024UL;
    public static uint CpuMillis(BillingPlan plan) => (uint)Math.Clamp(plan.CpuMaxCores * 1000m, 250m, 64_000m);
    public static long NanoCpus(BillingPlan plan) => (long)(Math.Clamp(plan.CpuMaxCores, 0.25m, 64m) * 1_000_000_000m);
}

public sealed class ResourceMeter(Platform platform)
{
    private readonly ConcurrentDictionary<Guid, (DateTimeOffset At, StorageStatus Status)> _storage = new();
    private readonly ConcurrentDictionary<string, long> _applied = new();
    private static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(15);

    public void Invalidate(Guid owner) => _storage.TryRemove(owner, out _);

    public async Task<StorageStatus> StorageAsync(Guid owner, CancellationToken ct = default, bool fresh = false)
    {
        var now = DateTimeOffset.UtcNow;
        if (!fresh && _storage.TryGetValue(owner, out var hit) && now - hit.At < CacheFor) return hit.Status;
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var status = await StorageAsync(conn, owner);
        _storage[owner] = (now, status);
        return status;
    }

    public async Task<StorageStatus> StorageAsync(NpgsqlConnection conn, Guid owner)
    {
        var plan = await platform.Usage.PlanOfAsync(conn, owner);
        var (files, artifacts) = await UsedAsync(conn, owner);
        return StorageRules.Status(files, artifacts, plan);
    }

    public static async Task<(long Files, long Artifacts)> UsedAsync(NpgsqlConnection conn, Guid owner) =>
        await conn.QuerySingleAsync<(long, long)>("""
            SELECT coalesce((SELECT sum(size_bytes) FROM stored_files WHERE owner_id=@owner),0)::bigint,
                   coalesce((SELECT sum(a.size_bytes) FROM artifacts a JOIN bots b ON b.id=a.bot_id WHERE b.owner_id=@owner),0)::bigint
            """, new { owner });

    public async Task<IReadOnlyList<ComputerResourceView>> ComputersAsync(NpgsqlConnection conn, Guid owner)
    {
        var plan = await platform.Usage.PlanOfAsync(conn, owner);
        var ids = (await conn.QueryAsync<Guid>("""
            SELECT computer_id FROM user_computers WHERE user_id=@owner
            UNION SELECT b.id FROM bots b WHERE b.owner_id=@owner AND NOT EXISTS (SELECT 1 FROM user_computers c WHERE c.user_id=@owner)
            """, new { owner })).ToList();
        var power = platform.Compute.PowerSnapshot().ToDictionary(item => item.Id, item => item.Power);
        var rows = (await conn.QueryAsync<(Guid Id, long Memory, long Limit, long Peak, DateTime At)>(
            "SELECT computer_id, memory_bytes, memory_limit_bytes, memory_peak_bytes, sampled_at FROM computer_resources WHERE computer_id = ANY(@ids)", new { ids = ids.ToArray() }))
            .ToDictionary(r => r.Id);
        return ids.Select(id =>
        {
            var awake = power.GetValueOrDefault(id.ToString()) ?? "asleep";
            rows.TryGetValue(id, out var r);
            var limit = r.Limit > 0 ? r.Limit : (long)PlanLimits.MemoryBytes(plan);
            return new ComputerResourceView(id, awake, awake == "awake" ? r.Memory : 0, limit, r.Peak, plan.CpuMinCores, plan.CpuMaxCores,
                r.At == default ? null : new DateTimeOffset(DateTime.SpecifyKind(r.At, DateTimeKind.Utc)));
        }).ToList();
    }

    /// <summary>Record each awake computer's RAM and make its live limits match the owner's plan (no restart; explicit user_quotas win).</summary>
    public async Task SampleAndReconcileAsync(CancellationToken ct)
    {
        var docker = platform.Compute;
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        foreach (var item in platform.Compute.PowerSnapshot().Where(p => p.Power == "awake"))
        {
            if (!Guid.TryParse(item.Id, out var computer)) continue;
            var owner = await ComputerNeed.OwnerOfComputer(conn, computer);
            if (owner is null) continue;
            var id = new ComputerId(item.Id);
            try
            {
                var memory = (long)await platform.Compute.ReadMemoryBytesAsync(id, ct);
                var plan = await platform.Usage.PlanOfAsync(conn, owner.Value);
                var quota = await conn.QuerySingleOrDefaultAsync<(int Cpu, long Memory)>("SELECT cpu_millis, memory_bytes FROM user_quotas WHERE user_id=@owner", new { owner });
                var wantMemory = quota.Memory > 0 ? quota.Memory : (long)PlanLimits.MemoryBytes(plan);
                var wantCpu = quota.Cpu is > 0 and not 400 ? quota.Cpu * 1_000_000L : PlanLimits.NanoCpus(plan);
                var key = item.Id + ":" + wantMemory + ":" + wantCpu;
                if (!_applied.ContainsKey(key))
                {
                    await docker.UpdateLimitsAsync(id, wantMemory, wantCpu, ct);
                    foreach (var stale in _applied.Keys.Where(k => k.StartsWith(item.Id + ":", StringComparison.Ordinal))) _applied.TryRemove(stale, out _);
                    _applied[key] = 0;
                }
                await conn.ExecuteAsync("""
                    INSERT INTO computer_resources (computer_id, owner_id, memory_bytes, memory_limit_bytes, memory_peak_bytes, cpu_max_cores, sampled_at)
                    VALUES (@computer, @owner, @memory, @limit, @memory, @cpu, now())
                    ON CONFLICT (computer_id) DO UPDATE SET owner_id=EXCLUDED.owner_id, memory_bytes=EXCLUDED.memory_bytes, memory_limit_bytes=EXCLUDED.memory_limit_bytes,
                      memory_peak_bytes=greatest(computer_resources.memory_peak_bytes, EXCLUDED.memory_bytes), cpu_max_cores=EXCLUDED.cpu_max_cores, sampled_at=now()
                    """, new { computer, owner, memory, limit = wantMemory, cpu = wantCpu / 1_000_000_000m });
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { /* a computer that just paused misses one pass */ }
        }
    }
}
