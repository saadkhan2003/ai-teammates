using System.Text.Json;
using Dapper;

namespace Teammates.Api;

/// <summary>User usage &amp; billing, background jobs, and admin billing configuration. No payment is processed:
/// on-demand limits and upgrade requests are recorded and audited only.</summary>
public static class UsageRoutes
{
    public static readonly decimal[] OnDemandSteps = [10m, 25m, 50m, 100m, 200m, 300m];

    public static IEnumerable<decimal> OnDemandOptions(decimal cap) => OnDemandSteps.Where(step => step <= cap);

    public static void Map(WebApplication app, Platform platform)
    {
        app.MapGet("/api/usage/credits", async (HttpContext ctx) =>
        {
            var user = await Beta.User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var summary = await platform.Usage.SummaryAsync(user.Value, ctx.RequestAborted, fresh: true);
            await using var conn = await platform.Data.OpenConnectionAsync(ctx.RequestAborted);
            var upgrade = summary.UpgradeTo is null ? null : await conn.QuerySingleOrDefaultAsync<BillingPlan>(
                "SELECT " + UsageMeter.PlanColumns() + " FROM billing_plans WHERE id=@id", new { id = summary.UpgradeTo });
            var rates = await platform.Usage.RatesAsync(conn);
            var storage = await platform.Resources.StorageAsync(conn, user.Value);
            var plan = await platform.Usage.PlanOfAsync(conn, user.Value);
            var computers = await platform.Resources.ComputersAsync(conn, user.Value);
            return Results.Json(new
            {
                storage = new { storage.UsedBytes, storage.QuotaBytes, storage.Percent, storage.WarnPct, storage.State, storage.FilesBytes, storage.ArtifactsBytes, message = StorageRules.WarningMessage(storage) },
                limits = new { storageQuotaGb = plan.StorageQuotaGb, ramMb = plan.RamMb, cpuMinCores = plan.CpuMinCores, cpuMaxCores = plan.CpuMaxCores },
                computers = computers.Select(c => new { id = c.ComputerId, power = c.Power, memoryBytes = c.MemoryBytes, memoryLimitBytes = c.MemoryLimitBytes, memoryPeakBytes = c.MemoryPeakBytes, cpuMinCores = c.CpuMinCores, cpuMaxCores = c.CpuMaxCores, sampledAt = c.SampledAt }),
                credits = summary,
                message = summary.Paused ? Credits.PausedMessage(summary) : null,
                onDemandOptions = OnDemandOptions(summary.OnDemandCapUsd),
                upgrade = upgrade is null ? null : new { id = upgrade.Id, name = upgrade.Name, priceUsd = upgrade.PriceUsd, weeklyCredits = upgrade.WeeklyCredits },
                rates = new { rates.UsdPerCredit, rates.ComputerCreditsPerMinute, rates.StorageFreeGb, rates.StorageCreditsPerGbWeek }
            });
        });

        app.MapPut("/api/usage/on-demand", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await Beta.User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            decimal? limit = null;
            if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("limitUsd", out var raw) && raw.ValueKind == JsonValueKind.Number)
                limit = raw.GetDecimal();
            else if (!(body.ValueKind == JsonValueKind.Object && body.TryGetProperty("limitUsd", out var nul) && nul.ValueKind == JsonValueKind.Null))
                return Results.BadRequest(new { error = "limitUsd must be a number or null" });
            await using var conn = await platform.Data.OpenConnectionAsync(ctx.RequestAborted);
            var plan = await platform.Usage.PlanOfAsync(conn, user.Value);
            if (limit is { } value && (value <= 0 || value > plan.OnDemandCapUsd))
                return Results.BadRequest(new { error = $"Choose a limit between $1 and ${plan.OnDemandCapUsd:0} for your plan." });
            await conn.ExecuteAsync("UPDATE users SET on_demand_limit_usd=@limit WHERE id=@id", new { id = user.Value, limit });
            platform.Usage.Invalidate(user.Value);
            await platform.Audit(user.Value.ToString(), "usage.on_demand.set", null, null, new { limitUsd = limit, charged = false });
            await platform.PublishTo(user.Value, new { type = "usage" });
            return Results.Json(new { ok = true, credits = await platform.Usage.SummaryAsync(user.Value, ctx.RequestAborted, fresh: true) });
        });

        app.MapPost("/api/usage/plan-request", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await Beta.User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var target = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("planId", out var p) ? p.GetString() : null;
            await using var conn = await platform.Data.OpenConnectionAsync(ctx.RequestAborted);
            if (target == null || await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM billing_plans WHERE id=@id", new { id = target }) == 0)
                return Results.BadRequest(new { error = "unknown plan" });
            await platform.Audit(user.Value.ToString(), "usage.plan.upgrade_requested", null, null, new { planId = target, charged = false });
            return Results.Json(new { ok = true, status = "requested", message = "Upgrade requested. An admin will switch your plan; nothing has been charged." });
        });

        app.MapGet("/api/bots/{id:guid}/jobs", async (HttpContext ctx, Guid id) =>
        {
            var user = await Beta.User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync(ctx.RequestAborted);
            if (await conn.ExecuteScalarAsync<Guid?>("SELECT owner_id FROM bots WHERE id=@id", new { id }) != user) return Results.NotFound();
            var jobs = await platform.Jobs.ListForOwner(user.Value, id);
            var screen = await conn.ExecuteScalarAsync<DateTime?>("""
                SELECT max(s.started_at) FROM task_steps s JOIN tasks t ON t.id=s.task_id JOIN bots b ON b.id=t.bot_id
                WHERE b.owner_id=@owner AND (s.tool LIKE 'browser%' OR s.tool LIKE 'computer%' OR s.tool IN ('type_secret','request_login'))
                """, new { owner = user.Value });
            var now = DateTimeOffset.UtcNow;
            return Results.Json(new
            {
                jobs = jobs.Select(job => ComputerJobs.View(job, now)),
                running = jobs.Count(job => JobRules.IsActive(job.Status)),
                screenLastUsedAt = screen is null ? (DateTimeOffset?)null : new DateTimeOffset(DateTime.SpecifyKind(screen.Value, DateTimeKind.Utc))
            });
        });

        app.MapGet("/api/jobs/{id:guid}/log", async (HttpContext ctx, Guid id) =>
        {
            var user = await Beta.User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync(ctx.RequestAborted);
            var job = await platform.Jobs.Get(conn, id);
            if (job == null || job.OwnerId != user) return Results.NotFound();
            var awake = platform.Compute.PowerSnapshot().FirstOrDefault(item => item.Id == job.ComputerId.ToString()).Power == "awake";
            // Reading a log is not use of the computer: it must not reset the idle clock.
            Teammates.Compute.DockerComputeProvider.QuietActivity.Value = true;
            try
            {
                var log = awake ? await platform.Jobs.TailAsync(job, JobRules.LogTailBytes, ctx.RequestAborted) : null;
                return Results.Json(new { id, status = job.Status, log = log ?? "", asleep = !awake });
            }
            finally { Teammates.Compute.DockerComputeProvider.QuietActivity.Value = false; }
        });

        // Live tail over SSE. Never wakes the desktop or the computer; see JobLogStreams.
        app.MapGet("/api/jobs/{id:guid}/log/stream", async (HttpContext ctx, Guid id) =>
        {
            var user = await Beta.User(ctx, platform);
            if (user == null) { ctx.Response.StatusCode = 401; return; }
            JobRow? job;
            await using (var conn = await platform.Data.OpenConnectionAsync(ctx.RequestAborted))
                job = await platform.Jobs.Get(conn, id);
            if (job == null || job.OwnerId != user) { ctx.Response.StatusCode = 404; return; }
            await platform.JobLogs.StreamAsync(ctx, job);
        });

        app.MapPost("/api/jobs/{id:guid}/cancel", async (HttpContext ctx, Guid id) =>
        {
            var user = await Beta.User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using (var conn = await platform.Data.OpenConnectionAsync(ctx.RequestAborted))
            {
                var job = await platform.Jobs.Get(conn, id);
                if (job == null || job.OwnerId != user) return Results.NotFound();
            }
            var result = await platform.Jobs.CancelAsync(user.Value, id, "user", null, ctx.RequestAborted);
            return Results.Json(result);
        });

        var admin = app.MapGroup("/api/admin/billing");
        admin.AddEndpointFilter(async (context, next) => await AiAdmin.Guard(context.HttpContext, platform) ?? await next(context));
        admin.MapGet("", async () =>
        {
            await using var conn = await platform.Data.OpenConnectionAsync();
            var plans = await conn.QueryAsync<BillingPlan>("SELECT " + UsageMeter.PlanColumns() + " FROM billing_plans ORDER BY price_usd");
            return Results.Json(new { plans, rates = await platform.Usage.RatesAsync(conn) });
        });
        admin.MapPut("/plans/{id}", async (HttpContext ctx, string id, JsonElement body) =>
        {
            var actor = ctx.Items["ai_actor"]?.ToString() ?? "admin";
            long? weekly = Num(body, "weeklyCredits") is { } w ? (long)w : null;
            var cap = Num(body, "onDemandCapUsd");
            int? jobDefault = Num(body, "jobDefaultMinutes") is { } d ? (int)d : null;
            int? jobMax = Num(body, "jobMaxMinutes") is { } x ? (int)x : null;
            int? running = Num(body, "maxRunningJobs") is { } r ? (int)r : null;
            int? storageGb = Num(body, "storageQuotaGb") is { } sg ? (int)sg : null;
            int? warnPct = Num(body, "storageWarnPct") is { } wp ? (int)wp : null;
            int? ramMb = Num(body, "ramMb") is { } rm ? (int)rm : null;
            var cpuMin = Num(body, "cpuMinCores");
            var cpuMax = Num(body, "cpuMaxCores");
            if (weekly is < 0 or > 10_000_000 || cap is < 0 or > 100_000 || jobDefault is < 1 or > 1440 || jobMax is < 1 or > 1440 || running is < 0 or > 50
                || storageGb is < 1 or > 10_000 || warnPct is < 1 or > 100 || ramMb is < 512 or > 262_144 || cpuMin is < 0.25m or > 64m || cpuMax is < 0.25m or > 64m)
                return Results.BadRequest(new { error = "value out of range" });
            await using var conn = await platform.Data.OpenConnectionAsync();
            var changed = await conn.ExecuteAsync("""
                UPDATE billing_plans SET weekly_credits=coalesce(@weekly,weekly_credits), on_demand_cap_usd=coalesce(@cap,on_demand_cap_usd),
                  job_default_minutes=coalesce(@jobDefault,job_default_minutes), job_max_minutes=coalesce(@jobMax,job_max_minutes),
                  max_running_jobs=coalesce(@running,max_running_jobs),
                  storage_quota_gb=coalesce(@storageGb,storage_quota_gb), storage_warn_pct=coalesce(@warnPct,storage_warn_pct), ram_mb=coalesce(@ramMb,ram_mb),
                  cpu_min_cores=coalesce(@cpuMin,cpu_min_cores), cpu_max_cores=coalesce(@cpuMax,cpu_max_cores)
                WHERE id=@id AND coalesce(@jobDefault,job_default_minutes) <= coalesce(@jobMax,job_max_minutes)
                  AND coalesce(@cpuMin,cpu_min_cores) <= coalesce(@cpuMax,cpu_max_cores)
                """, new { id, weekly, cap, jobDefault, jobMax, running, storageGb, warnPct, ramMb, cpuMin, cpuMax });
            if (changed == 0) return Results.BadRequest(new { error = "unknown plan, job default above max, or CPU min above max" });
            platform.Usage.InvalidateAll();
            await platform.Audit(actor, "billing.plan.update", null, null, new { plan = id, weekly, cap, jobDefault, jobMax, running, storageGb, warnPct, ramMb, cpuMin, cpuMax });
            return Results.Json(new { ok = true });
        });
        admin.MapPut("/plans/{id}/assign/{userId:guid}", async (HttpContext ctx, string id, Guid userId) =>
        {
            await using var conn = await platform.Data.OpenConnectionAsync();
            if (await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM billing_plans WHERE id=@id", new { id }) == 0) return Results.BadRequest(new { error = "unknown plan" });
            if (await conn.ExecuteAsync("UPDATE users SET plan_id=@id WHERE id=@userId", new { id, userId }) == 0) return Results.NotFound();
            platform.Usage.Invalidate(userId);
            await platform.Audit(ctx.Items["ai_actor"]?.ToString() ?? "admin", "billing.plan.assign", null, null, new { plan = id, user = userId });
            return Results.Json(new { ok = true });
        });
        admin.MapPut("/rates", async (HttpContext ctx, JsonElement body) =>
        {
            var usd = Num(body, "usdPerCredit"); var minute = Num(body, "computerCreditsPerMinute");
            var free = Num(body, "storageFreeGb"); var gb = Num(body, "storageCreditsPerGbWeek");
            if (usd is <= 0 or > 1 || minute is < 0 or > 1000 || free is < 0 or > 10_000 || gb is < 0 or > 100_000)
                return Results.BadRequest(new { error = "value out of range" });
            await using var conn = await platform.Data.OpenConnectionAsync();
            await conn.ExecuteAsync("""
                UPDATE credit_rates SET usd_per_credit=coalesce(@usd,usd_per_credit), computer_credits_per_minute=coalesce(@minute,computer_credits_per_minute),
                  storage_free_gb=coalesce(@free,storage_free_gb), storage_credits_per_gb_week=coalesce(@gb,storage_credits_per_gb_week) WHERE id
                """, new { usd, minute, free, gb });
            await platform.Audit(ctx.Items["ai_actor"]?.ToString() ?? "admin", "billing.rates.update", null, null, new { usd, minute, free, gb });
            return Results.Json(new { ok = true });
        });
        admin.MapGet("/resources", async (HttpContext ctx) =>
        {
            await using var conn = await platform.Data.OpenConnectionAsync(ctx.RequestAborted);
            var runs = await conn.QueryAsync("""
                SELECT id, trigger, started_at AS "startedAt", finished_at AS "finishedAt", computers, removed_files AS "removedFiles",
                  removed_bytes AS "removedBytes", removed_backups AS "removedBackups" FROM cleanup_runs ORDER BY id DESC LIMIT 10
                """);
            var sync = await conn.QuerySingleAsync<(long Files, long Bytes, DateTime? LastPush)>(
                "SELECT (SELECT count(*) FROM stored_files), coalesce((SELECT sum(size_bytes) FROM stored_files),0)::bigint, (SELECT max(pushed_at) FROM workspace_sync)");
            var backups = platform.Cleanup.ListBackups();
            return Results.Json(new
            {
                baseImage = platform.Compute.BaseImage,
                imagesInUse = platform.Compute.ImagesInUse(),
                maxComputers = platform.Compute.MaxComputers,
                memoryCeilingBytes = platform.Compute.MemoryCeilingBytes,
                objectStore = new { name = platform.Sync.Store.Name, enabled = platform.Sync.Enabled, files = sync.Files, bytes = sync.Bytes, lastPushAt = sync.LastPush },
                cleanup = new { hourUtc = platform.Cleanup.Hour, keepBackups = platform.Cleanup.KeepBackups, downloadDays = platform.Cleanup.DownloadDays, backups = backups.Count, runs }
            });
        });
        admin.MapPost("/cleanup/run", async (HttpContext ctx) =>
        {
            var result = await platform.Cleanup.RunAsync("admin", ctx.Items["ai_actor"]?.ToString() ?? "admin", ctx.RequestAborted);
            return Results.Json(result);
        });
        admin.MapPost("/sync/{computer:guid}/{direction}", async (HttpContext ctx, Guid computer, string direction) =>
        {
            if (direction is not ("push" or "pull")) return Results.BadRequest(new { error = "direction must be push or pull" });
            var id = new Teammates.Compute.ComputerId(computer.ToString());
            var reports = direction == "push" ? await platform.Sync.PushAsync(id, ctx.RequestAborted) : await platform.Sync.PullAsync(id, ctx.RequestAborted);
            await platform.Audit(ctx.Items["ai_actor"]?.ToString() ?? "admin", "storage.sync." + direction, null, null, new { computer, bots = reports.Count });
            return Results.Json(new { reports });
        });
        admin.MapGet("/usage", async (HttpContext ctx) =>
        {
            await using var conn = await platform.Data.OpenConnectionAsync(ctx.RequestAborted);
            var users = (await conn.QueryAsync<(Guid Id, string Username, string? DisplayName)>("SELECT id AS Id, username AS Username, display_name AS DisplayName FROM users ORDER BY created_at LIMIT 500")).ToList();
            var now = DateTimeOffset.UtcNow;
            var rows = new List<object>();
            foreach (var user in users)
            {
                var s = await platform.Usage.SummaryAsync(conn, user.Id, now);
                var disk = await platform.Resources.StorageAsync(conn, user.Id);
                var machines = await platform.Resources.ComputersAsync(conn, user.Id);
                rows.Add(new { id = user.Id, username = user.Username, displayName = user.DisplayName ?? user.Username, plan = s.PlanName, s.Allowance,
                    ai = s.AiCredits, computer = s.ComputerCredits, storage = s.StorageCredits, used = s.UsedCredits, s.Percent,
                    s.ComputerMinutes, s.BackgroundMinutes, s.State, s.OnDemandLimitUsd, s.OnDemandUsedUsd, s.ResetsAt,
                    storageUsedBytes = disk.UsedBytes, storageQuotaBytes = disk.QuotaBytes, storagePercent = disk.Percent, storageState = disk.State,
                    computers = machines.Count, ramBytes = machines.Sum(m => m.MemoryBytes), ramLimitBytes = machines.Sum(m => m.MemoryLimitBytes) });
            }
            return Results.Json(new { users = rows });
        });
    }

    private static decimal? Num(JsonElement body, string name) =>
        body.ValueKind == JsonValueKind.Object && body.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDecimal() : null;
}
