using System.Collections.Concurrent;
using Dapper;
using Npgsql;

namespace Teammates.Api;

public sealed record CreditRates(decimal UsdPerCredit, decimal ComputerCreditsPerMinute, decimal StorageFreeGb, decimal StorageCreditsPerGbWeek)
{
    public static readonly CreditRates Default = new(0.001m, 0.1m, 5m, 50m);
}

public sealed record BillingPlan(string Id, string Name, decimal PriceUsd, long WeeklyCredits, decimal OnDemandCapUsd,
    int JobDefaultMinutes, int JobMaxMinutes, int MaxRunningJobs, string? UpgradeTo,
    int StorageQuotaGb = 50, int StorageWarnPct = 80, int RamMb = 8192, decimal CpuMinCores = 1m, decimal CpuMaxCores = 2m)
{
    public static readonly BillingPlan Standard = new("standard", "Standard", 30m, 4500, 100m, 60, 240, 3, "pro");
}

/// <summary>Raw usage inside one weekly window. StorageGbDaysOver is the sum over sampled days of GB above the free amount.</summary>
public sealed record UsageInputs(decimal AiUsd, long ComputerMinutes, long BackgroundMinutes, decimal StorageGbDaysOver, decimal PriorOnDemandUsdThisMonth);

public sealed record CreditSummary(
    string PlanId, string PlanName, decimal PlanPriceUsd, string? UpgradeTo,
    long Allowance, decimal AiCredits, decimal ComputerCredits, decimal StorageCredits, decimal UsedCredits,
    decimal Percent, long ComputerMinutes, long BackgroundMinutes,
    DateTimeOffset WindowStart, DateTimeOffset ResetsAt, int ResetsInDays,
    decimal? OnDemandLimitUsd, decimal OnDemandCapUsd, decimal OnDemandUsedUsd, decimal OverageCredits,
    string State, bool Paused);

/// <summary>One unified usage meter. AI, computer minutes and storage all convert to credits at real cost.</summary>
public static class Credits
{
    public const string LimitCode = "usage_limit";

    /// <summary>The weekly window containing now, anchored on the user's sign-up time.</summary>
    public static (DateTimeOffset Start, DateTimeOffset End) Window(DateTimeOffset anchor, DateTimeOffset now)
    {
        if (anchor > now) anchor = now;
        var weeks = Math.Floor((now - anchor).TotalDays / 7d);
        var start = anchor.AddDays(weeks * 7d);
        return (start, start.AddDays(7));
    }

    public static decimal StorageGbOver(long bytes, decimal freeGb) =>
        Math.Max(0m, bytes / 1_073_741_824m - freeGb);

    public static CreditSummary Compute(BillingPlan plan, CreditRates rates, UsageInputs usage, decimal? onDemandLimitUsd,
        DateTimeOffset windowStart, DateTimeOffset windowEnd, DateTimeOffset now)
    {
        var ai = rates.UsdPerCredit > 0 ? usage.AiUsd / rates.UsdPerCredit : 0m;
        var computer = usage.ComputerMinutes * rates.ComputerCreditsPerMinute;
        var storage = usage.StorageGbDaysOver * rates.StorageCreditsPerGbWeek / 7m;
        var used = ai + computer + storage;
        var allowance = Math.Max(0, plan.WeeklyCredits);
        var overage = Math.Max(0m, used - allowance);
        var limit = onDemandLimitUsd is > 0 ? Math.Min(onDemandLimitUsd.Value, plan.OnDemandCapUsd) : (decimal?)null;
        var onDemandUsed = usage.PriorOnDemandUsdThisMonth + overage * rates.UsdPerCredit;
        var percent = allowance > 0 ? used / allowance * 100m : used > 0 ? 100m : 0m;
        var overAllowance = used >= allowance;
        var paused = overAllowance && (limit is null || onDemandUsed >= limit.Value);
        var state = paused ? "paused" : overAllowance ? "on_demand" : percent >= 80m ? "warning" : "ok";
        var resetsIn = (int)Math.Max(0, Math.Ceiling((windowEnd - now).TotalDays));
        return new CreditSummary(plan.Id, plan.Name, plan.PriceUsd, plan.UpgradeTo, allowance,
            Round(ai), Round(computer), Round(storage), Round(used), Math.Round(percent, 1),
            usage.ComputerMinutes, usage.BackgroundMinutes, windowStart, windowEnd, resetsIn,
            limit, plan.OnDemandCapUsd, Math.Round(onDemandUsed, 2), Round(overage), state, paused);
    }

    /// <summary>The message shown when heavy work is paused. Never names a model or provider.</summary>
    public static string PausedMessage(CreditSummary summary) =>
        "You've used all of this week's included usage, so new background jobs and waking the computer are paused until "
        + summary.ResetsAt.ToString("MMM d") + ". Chat still works. To keep going now, open Settings → Usage & Billing and "
        + (summary.OnDemandLimitUsd is null ? "choose an on-demand monthly limit" : "raise your on-demand monthly limit")
        + (summary.UpgradeTo is null ? "." : ", or upgrade your plan.");

    private static decimal Round(decimal value) => Math.Round(value, 3);
}

/// <summary>Reads and records usage. Owners' summaries are cached briefly; writes invalidate.</summary>
public sealed class UsageMeter(Platform platform)
{
    private readonly ConcurrentDictionary<Guid, (DateTimeOffset At, CreditSummary Summary)> _cache = new();
    private DateOnly _storageDay;
    public static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(10);

    public void Invalidate(Guid owner) => _cache.TryRemove(owner, out _);
    public void InvalidateAll() => _cache.Clear();

    public async Task<CreditRates> RatesAsync(NpgsqlConnection conn) =>
        await conn.QuerySingleOrDefaultAsync<CreditRates>(
            "SELECT usd_per_credit AS UsdPerCredit, computer_credits_per_minute AS ComputerCreditsPerMinute, storage_free_gb AS StorageFreeGb, storage_credits_per_gb_week AS StorageCreditsPerGbWeek FROM credit_rates WHERE id")
        ?? CreditRates.Default;

    public static string PlanColumns(string alias = "") =>
        string.Join(", ", new[] { ("id", "Id"), ("name", "Name"), ("price_usd", "PriceUsd"), ("weekly_credits", "WeeklyCredits"), ("on_demand_cap_usd", "OnDemandCapUsd"),
            ("job_default_minutes", "JobDefaultMinutes"), ("job_max_minutes", "JobMaxMinutes"), ("max_running_jobs", "MaxRunningJobs"), ("upgrade_to", "UpgradeTo"),
            ("storage_quota_gb", "StorageQuotaGb"), ("storage_warn_pct", "StorageWarnPct"), ("ram_mb", "RamMb"), ("cpu_min_cores", "CpuMinCores"), ("cpu_max_cores", "CpuMaxCores") }
            .Select(pair => (alias.Length > 0 ? alias + "." : "") + pair.Item1 + " AS " + pair.Item2));

    public async Task<BillingPlan> PlanOfAsync(NpgsqlConnection conn, Guid owner) =>
        await conn.QuerySingleOrDefaultAsync<BillingPlan>(
            "SELECT " + PlanColumns("p") + " FROM users u JOIN billing_plans p ON p.id = u.plan_id WHERE u.id=@owner", new { owner })
        ?? BillingPlan.Standard;

    public async Task<CreditSummary> SummaryAsync(Guid owner, CancellationToken ct = default, bool fresh = false)
    {
        var now = DateTimeOffset.UtcNow;
        if (!fresh && _cache.TryGetValue(owner, out var hit) && now - hit.At < CacheFor) return hit.Summary;
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var summary = await SummaryAsync(conn, owner, now);
        _cache[owner] = (now, summary);
        return summary;
    }

    public async Task<CreditSummary> SummaryAsync(NpgsqlConnection conn, Guid owner, DateTimeOffset now)
    {
        var rates = await RatesAsync(conn);
        var plan = await PlanOfAsync(conn, owner);
        var user = await conn.QuerySingleOrDefaultAsync<(DateTime Anchor, decimal? Limit)>(
            "SELECT coalesce(usage_anchor, created_at) AS Anchor, on_demand_limit_usd AS Limit FROM users WHERE id=@owner", new { owner });
        var anchor = user.Anchor == default ? now : new DateTimeOffset(DateTime.SpecifyKind(user.Anchor, DateTimeKind.Utc));
        var (start, end) = Credits.Window(anchor, now);
        var ai = await conn.ExecuteScalarAsync<decimal>(
            "SELECT coalesce(sum(cost_usd),0) FROM model_calls WHERE owner_id=@owner AND created_at >= @start AND created_at < @end", new { owner, start, end });
        var minutes = await conn.QuerySingleAsync<(long Total, long Background)>(
            "SELECT count(*) AS Total, count(*) FILTER (WHERE background) AS Background FROM computer_usage_minutes WHERE owner_id=@owner AND minute >= @start AND minute < @end", new { owner, start, end });
        var storageDays = await conn.QueryAsync<long>(
            "SELECT bytes FROM storage_usage_days WHERE owner_id=@owner AND day >= @startDay AND day < @endDay",
            new { owner, startDay = start.UtcDateTime.Date, endDay = end.UtcDateTime.Date.AddDays(1) });
        var gbDaysOver = storageDays.Sum(bytes => Credits.StorageGbOver(bytes, rates.StorageFreeGb));
        var monthStart = new DateTimeOffset(now.Year, now.Month, 1, 0, 0, 0, TimeSpan.Zero);
        var priorOverage = await conn.ExecuteScalarAsync<decimal>(
            "SELECT coalesce(sum(overage_credits),0) FROM credit_windows WHERE owner_id=@owner AND window_start >= @monthStart AND window_start < @start",
            new { owner, monthStart, start });
        return Credits.Compute(plan, rates, new UsageInputs(ai, minutes.Total, minutes.Background, gbDaysOver, priorOverage * rates.UsdPerCredit),
            user.Limit, start, end, now);
    }

    /// <summary>Null when heavy work may run; otherwise the user-facing reason.</summary>
    public async Task<string?> BlockReasonAsync(Guid owner, CancellationToken ct = default)
    {
        var summary = await SummaryAsync(owner, ct);
        return summary.Paused ? Credits.PausedMessage(summary) : null;
    }

    /// <summary>Null when waking this computer is allowed: it is already awake, or the owner still has usage left.</summary>
    public async Task<string?> WakeBlockAsync(Guid owner, string computerId, CancellationToken ct = default)
    {
        if (platform.Compute.PowerSnapshot().FirstOrDefault(item => item.Id == computerId).Power == "awake") return null;
        return await BlockReasonAsync(owner, ct);
    }

    /// <summary>Called by maintenance every ~30 s: one row per awake computer-minute, a daily storage sample, window snapshots.</summary>
    public async Task TickAsync(CancellationToken ct)
    {
        var awake = platform.Compute.PowerSnapshot().Where(item => item.Power == "awake").Select(item => item.Id).ToArray();
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var minute = DateTimeOffset.UtcNow;
        minute = new DateTimeOffset(minute.Year, minute.Month, minute.Day, minute.Hour, minute.Minute, 0, TimeSpan.Zero);
        var owners = new HashSet<Guid>();
        foreach (var raw in awake)
        {
            if (!Guid.TryParse(raw, out var computer)) continue;
            var owner = await conn.ExecuteScalarAsync<Guid?>(
                "SELECT user_id FROM user_computers WHERE computer_id=@computer UNION ALL SELECT owner_id FROM bots WHERE id=@computer LIMIT 1", new { computer });
            if (owner is null) continue;
            var background = await conn.ExecuteScalarAsync<bool>(
                // A job shorter than the ~30 s tick still counts: include jobs that finished in the last minute.
                "SELECT EXISTS (SELECT 1 FROM computer_jobs WHERE computer_id=@computer AND (status IN ('starting','running') OR finished_at > now() - interval '60 seconds'))", new { computer });
            await conn.ExecuteAsync("""
                INSERT INTO computer_usage_minutes (computer_id, minute, owner_id, background) VALUES (@computer, @minute, @owner, @background)
                ON CONFLICT (computer_id, minute) DO UPDATE SET background = computer_usage_minutes.background OR EXCLUDED.background
                """, new { computer, minute, owner, background });
            owners.Add(owner.Value);
        }
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        if (_storageDay != today)
        {
            await SampleStorageAsync(conn, today);
            _storageDay = today;
        }
        foreach (var owner in owners) await SnapshotAsync(conn, owner);
    }

    public async Task SampleStorageAsync(NpgsqlConnection conn, DateOnly day) =>
        await conn.ExecuteAsync("""
            INSERT INTO storage_usage_days (owner_id, day, bytes)
            SELECT u.id, @day, coalesce((SELECT sum(a.size_bytes) FROM artifacts a JOIN bots b ON b.id = a.bot_id WHERE b.owner_id = u.id), 0)
                 + coalesce((SELECT sum(f.size_bytes) FROM stored_files f WHERE f.owner_id = u.id), 0)
            FROM users u
            ON CONFLICT (owner_id, day) DO UPDATE SET bytes = EXCLUDED.bytes
            """, new { day = day.ToDateTime(TimeOnly.MinValue) });

    public async Task SnapshotAsync(NpgsqlConnection conn, Guid owner)
    {
        var summary = await SummaryAsync(conn, owner, DateTimeOffset.UtcNow);
        _cache[owner] = (DateTimeOffset.UtcNow, summary);
        await conn.ExecuteAsync("""
            INSERT INTO credit_windows (owner_id, window_start, allowance, used_credits, overage_credits)
            VALUES (@owner, @start, @allowance, @used, @overage)
            ON CONFLICT (owner_id, window_start) DO UPDATE SET allowance=EXCLUDED.allowance, used_credits=EXCLUDED.used_credits, overage_credits=EXCLUDED.overage_credits, updated_at=now()
            """, new { owner, start = summary.WindowStart, allowance = summary.Allowance, used = summary.UsedCredits, overage = summary.OverageCredits });
    }
}

/// <summary>Which tools need a running computer, and which tasks wake it upfront.</summary>
public static class ComputerNeed
{
    private static readonly HashSet<string> Tools = new(StringComparer.Ordinal)
    {
        "browser_open", "browser_extract", "browser_click", "browser_screenshot", "type_secret", "browser.type_secret", "request_login",
        "computer_screenshot", "computer_click", "computer_type", "computer_key", "computer_scroll", "record_start", "record_stop",
        "shell", "setup_env", "write_file", "read_file", "edit_file", "delete_file", "save_artifact",
        "git_status", "git_diff", "git_commit", "run_tests", "create_pr", "spawn_child_task", "job_start"
    };

    public static bool Needs(string tool) => Tools.Contains(tool);

    /// <summary>Chat and coding tasks wake the computer at lease time (first token speed). Routines and
    /// bot-to-bot work wake it only when a tool actually needs it.</summary>
    public static bool EagerWake(string kind, Guid? routineId) => routineId is null && !kind.StartsWith("peer", StringComparison.Ordinal);

    public static async Task<Guid?> OwnerOfComputer(NpgsqlConnection conn, Guid computer) =>
        await conn.ExecuteScalarAsync<Guid?>("SELECT user_id FROM user_computers WHERE computer_id=@computer UNION ALL SELECT owner_id FROM bots WHERE id=@computer LIMIT 1", new { computer });
}
