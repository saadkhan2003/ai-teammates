using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Amazon.S3.Model;
using Dapper;
using Npgsql;
using Teammates.Compute;

namespace Teammates.Api;

/// <summary>
/// Admin console API. Model registry, default, fallback, spend caps, and the
/// kill switch are the contract for the speed-v1 branch, which owns the 12
/// request-time safety checks. That branch should refuse a call when
/// model_registry.killed is true, when feature_flags.model_kill is on, or when
/// today's spend passes daily_spend_cap_cents (0 means uncapped).
/// </summary>
public static class AdminConsole
{
    public const string ModelMergeBranch = "speed-v1";
    public const int ModelSafetyFeatures = 12;

    public static void Map(WebApplication app, Platform platform)
    {
        app.MapGet("/api/maintenance", async () =>
        {
            await using var conn = await Open(platform);
            return Results.Json(await Maintenance(conn));
        });

        app.MapGet("/api/admin/console/session", (HttpContext ctx, CancellationToken _) => Run(ctx, platform, "read", async (id, role, conn) =>
        {
            var enrolled = await conn.ExecuteScalarAsync<bool>("SELECT coalesce((SELECT enabled FROM admin_totp WHERE user_id=@id), false)", new { id });
            var impersonation = await conn.QuerySingleOrDefaultAsync(
                """
                SELECT i.id, u.username, u.display_name, i.started_at
                FROM admin_impersonations i
                JOIN users u ON u.id=i.target_id
                WHERE i.actor_id=@id AND i.ended_at IS NULL
                ORDER BY i.started_at DESC LIMIT 1
                """, new { id });
            return Results.Json(new
            {
                role,
                totpRequired = Access.RequiresTotp(role),
                totpEnrolled = enrolled,
                maintenance = await Maintenance(conn),
                impersonation = impersonation == null ? null : Platform.ToDict(impersonation)
            });
        }));

        app.MapGet("/api/admin/console/overview", (HttpContext ctx, CancellationToken _) => Run(ctx, platform, "read", async (_, _, conn) =>
        {
            var activeUsers = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM users WHERE status='active'");
            var signups = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM users WHERE created_at >= date_trunc('month', now())");
            var mrr = await conn.ExecuteScalarAsync<long>("SELECT coalesce(sum(p.price_usd * 100), 0)::bigint FROM users u JOIN billing_plans p ON p.id=u.plan_id WHERE u.status='active'");
            var awake = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM user_computers WHERE status IN ('running', 'recovering')");
            var spendToday = await conn.ExecuteScalarAsync<decimal>("SELECT coalesce(sum(cost_usd), 0) FROM model_calls WHERE created_at >= date_trunc('day', now())");
            var spendMonth = await conn.ExecuteScalarAsync<decimal>("SELECT coalesce(sum(cost_usd), 0) FROM model_calls WHERE created_at >= date_trunc('month', now())");
            var errors = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM tasks WHERE status='failed' AND updated_at >= now() - interval '1 day'");
            var postgres = await conn.ExecuteScalarAsync<int>("SELECT 1") == 1;
            var spendSeries = await Daily(conn, "SELECT created_at::date AS day, coalesce(sum(cost_usd), 0) AS value FROM model_calls WHERE created_at >= now() - interval '7 days' GROUP BY 1");
            var signupSeries = await Daily(conn, "SELECT created_at::date AS day, count(*)::numeric AS value FROM users WHERE created_at >= now() - interval '7 days' GROUP BY 1");
            var errorSeries = await Daily(conn, "SELECT updated_at::date AS day, count(*)::numeric AS value FROM tasks WHERE status='failed' AND updated_at >= now() - interval '7 days' GROUP BY 1");
            return Results.Json(new
            {
                activeUsers,
                mrrCents = mrr,
                signups,
                awakeComputers = awake,
                aiSpendTodayUsd = spendToday,
                aiSpendMonthUsd = spendMonth,
                errors,
                health = postgres ? "up" : "down",
                maxComputers = platform.MaxComputers,
                spendSeries,
                signupSeries,
                errorSeries
            });
        }));

        app.MapGet("/api/admin/console/users/{id:guid}", (HttpContext ctx, Guid id) => Run(ctx, platform, "read", async (_, _, conn) =>
        {
            var exists = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM users WHERE id=@id", new { id });
            if (exists == 0) return Results.NotFound();
            var notes = await conn.QueryAsync("SELECT n.id, n.body, n.created_at, a.username AS author FROM admin_notes n JOIN users a ON a.id=n.author_id WHERE n.user_id=@id ORDER BY n.created_at DESC", new { id });
            var orgs = await conn.QueryAsync("SELECT o.id, o.name, m.role FROM organization_members m JOIN organizations o ON o.id=m.org_id WHERE m.user_id=@id", new { id });
            var limits = await conn.QuerySingleOrDefaultAsync("SELECT storage_mb, ram_mb, cpu_millis, weekly_credits FROM user_limit_overrides WHERE user_id=@id", new { id });
            return Results.Json(new { notes = notes.Select(Platform.ToDict), organizations = orgs.Select(Platform.ToDict), limits = limits == null ? null : Platform.ToDict(limits) });
        }));

        app.MapPost("/api/admin/console/users/{id:guid}/notes", (HttpContext ctx, Guid id, JsonElement body) => Run(ctx, platform, "note", async (actor, _, conn) =>
        {
            var text = Str(body, "body")?.Trim() ?? "";
            if (text.Length is < 1 or > 4000) return Results.BadRequest(new { error = "Write a note up to 4000 characters." });
            var exists = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM users WHERE id=@id", new { id });
            if (exists == 0) return Results.NotFound();
            var noteId = await conn.ExecuteScalarAsync<Guid>("INSERT INTO admin_notes (user_id, author_id, body) VALUES (@id, @actor, @text) RETURNING id", new { id, actor, text });
            await platform.Audit(actor.ToString(), "admin.note", null, null, new { userId = id, noteId });
            return Results.Json(new { id = noteId }, statusCode: 201);
        }));

        app.MapPost("/api/admin/console/impersonate", (HttpContext ctx, JsonElement body) => Run(ctx, platform, "impersonate", async (actor, _, conn) =>
        {
            if (!Guid.TryParse(Str(body, "userId"), out var target) || target == actor) return Results.BadRequest(new { error = "Choose another person." });
            var username = await conn.ExecuteScalarAsync<string>("SELECT username FROM users WHERE id=@target AND status <> 'banned'", new { target });
            if (string.IsNullOrEmpty(username)) return Results.NotFound();
            await conn.ExecuteAsync("UPDATE admin_impersonations SET ended_at=now() WHERE actor_id=@actor AND ended_at IS NULL", new { actor });
            var id = await conn.ExecuteScalarAsync<Guid>("INSERT INTO admin_impersonations (actor_id, target_id) VALUES (@actor, @target) RETURNING id", new { actor, target });
            await platform.Audit(actor.ToString(), "admin.impersonate.start", null, null, new { target, id });
            return Results.Json(new { id, username });
        }));

        app.MapPost("/api/admin/console/impersonate/end", (HttpContext ctx, CancellationToken _) => Run(ctx, platform, "impersonate", async (actor, _, conn) =>
        {
            await conn.ExecuteAsync("UPDATE admin_impersonations SET ended_at=now() WHERE actor_id=@actor AND ended_at IS NULL", new { actor });
            await platform.Audit(actor.ToString(), "admin.impersonate.end", null, null, new { });
            return Results.Json(new { ok = true });
        }));

        app.MapPost("/api/admin/console/users/{id:guid}/status", (HttpContext ctx, Guid id, JsonElement body) => Run(ctx, platform, StatusAction(Str(body, "status")), async (actor, actorRole, conn) =>
        {
            var status = Str(body, "status") ?? "";
            if (status is not ("active" or "disabled" or "banned")) return Results.BadRequest(new { error = "Status must be active, disabled, or banned." });
            if (id == actor && status != "active") return Results.Json(new { error = "you cannot change your own access" }, statusCode: 403);
            var targetRole = await conn.ExecuteScalarAsync<string>("SELECT role FROM users WHERE id=@id", new { id });
            if (string.IsNullOrEmpty(targetRole)) return Results.NotFound();
            if (!Access.CanChangeStatus(actorRole, targetRole)) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            await conn.ExecuteAsync("UPDATE users SET status=@status WHERE id=@id", new { id, status });
            if (status != "active") await conn.ExecuteAsync("DELETE FROM sessions WHERE user_id=@id", new { id });
            await platform.Audit(actor.ToString(), "admin.user.status", null, null, new { userId = id, status });
            return Results.Json(new { id, status });
        }));

        app.MapPost("/api/admin/console/users/{id:guid}/reset", (HttpContext ctx, Guid id) => Run(ctx, platform, "reset", async (actor, actorRole, conn) =>
        {
            var targetRole = await conn.ExecuteScalarAsync<string>("SELECT role FROM users WHERE id=@id", new { id });
            if (string.IsNullOrEmpty(targetRole)) return Results.NotFound();
            if (!Access.CanChangeStatus(actorRole, targetRole) && actor != id) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            var temporary = Convert.ToHexString(RandomNumberGenerator.GetBytes(9)).ToLowerInvariant();
            await conn.ExecuteAsync("UPDATE users SET password_hash=@hash WHERE id=@id", new { id, hash = Passwords.Hash(temporary) });
            await conn.ExecuteAsync("DELETE FROM sessions WHERE user_id=@id", new { id });
            await platform.Audit(actor.ToString(), "admin.user.reset", null, null, new { userId = id });
            return Results.Json(new { temporaryPassword = temporary });
        }));

        app.MapDelete("/api/admin/console/users/{id:guid}", (HttpContext ctx, Guid id, [Microsoft.AspNetCore.Mvc.FromBody] JsonElement body) => Run(ctx, platform, "delete", async (actor, _, conn) =>
        {
            if (id == actor) return Results.Json(new { error = "you cannot delete yourself" }, statusCode: 403);
            var row = await conn.QuerySingleOrDefaultAsync<(string Username, string Role)>("SELECT username, role FROM users WHERE id=@id", new { id });
            if (string.IsNullOrEmpty(row.Username)) return Results.NotFound();
            if (!string.Equals(Str(body, "confirm"), row.Username, StringComparison.Ordinal))
                return Results.BadRequest(new { error = "Type the username to confirm." });
            if (row.Role == "owner")
            {
                var owners = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM users WHERE role='owner'");
                if (owners <= 1) return Results.BadRequest(new { error = "The last owner stays." });
            }
            await platform.Audit(actor.ToString(), "admin.user.delete", null, null, new { userId = id, username = row.Username });
            await conn.ExecuteAsync("DELETE FROM users WHERE id=@id", new { id });
            return Results.Json(new { deleted = true });
        }));

        app.MapGet("/api/admin/console/orgs", (HttpContext ctx, CancellationToken _) => Run(ctx, platform, "read", async (_, _, conn) =>
        {
            var rows = await conn.QueryAsync(
                """
                SELECT o.id, o.name, o.created_at, count(m.user_id) AS members
                FROM organizations o
                LEFT JOIN organization_members m ON m.org_id=o.id
                GROUP BY o.id
                ORDER BY o.created_at
                """);
            return Results.Json(new { organizations = rows.Select(Platform.ToDict) });
        }));

        app.MapPost("/api/admin/console/orgs", (HttpContext ctx, JsonElement body) => Run(ctx, platform, "org", async (actor, _, conn) =>
        {
            var name = Str(body, "name")?.Trim() ?? "";
            if (name.Length is < 1 or > 80) return Results.BadRequest(new { error = "Name the organization." });
            var id = await conn.ExecuteScalarAsync<Guid>("INSERT INTO organizations (name, created_by) VALUES (@name, @actor) RETURNING id", new { name, actor });
            await conn.ExecuteAsync("INSERT INTO organization_members (org_id, user_id, role) VALUES (@id, @actor, 'owner')", new { id, actor });
            await platform.Audit(actor.ToString(), "admin.org.create", null, null, new { id, name });
            return Results.Json(new { id, name }, statusCode: 201);
        }));

        app.MapGet("/api/admin/console/bots", (HttpContext ctx, CancellationToken _) => Run(ctx, platform, "read", async (_, _, conn) =>
        {
            var rows = await conn.QueryAsync(
                """
                SELECT b.id, b.name, b.status, b.owner_id, u.username, b.updated_at
                FROM bots b JOIN users u ON u.id=b.owner_id
                ORDER BY b.updated_at DESC
                LIMIT 200
                """);
            return Results.Json(new { bots = rows.Select(Platform.ToDict) });
        }));

        app.MapPost("/api/admin/console/bots/{id:guid}/kill", (HttpContext ctx, Guid id) => Run(ctx, platform, "kill", async (actor, _, conn) =>
        {
            var n = await conn.ExecuteAsync("UPDATE bots SET status='stopped', updated_at=now() WHERE id=@id", new { id });
            if (n == 0) return Results.NotFound();
            await conn.ExecuteAsync("UPDATE tasks SET status='cancelled', updated_at=now(), finished_at=now(), lease_owner=NULL WHERE bot_id=@id AND status NOT IN ('completed','failed','cancelled')", new { id });
            await platform.Audit(actor.ToString(), "admin.bot.kill", id, null, new { });
            return Results.Json(new { id, status = "stopped" });
        }));

        app.MapPost("/api/admin/console/bots/{id:guid}/restart", (HttpContext ctx, Guid id) => Run(ctx, platform, "kill", async (actor, _, conn) =>
        {
            if (await Flag(conn, "bots_kill")) return Results.Json(new { error = "Bot restart is switched off." }, statusCode: 423);
            var n = await conn.ExecuteAsync("UPDATE bots SET status='idle', updated_at=now() WHERE id=@id", new { id });
            if (n == 0) return Results.NotFound();
            await platform.Audit(actor.ToString(), "admin.bot.restart", id, null, new { });
            return Results.Json(new { id, status = "idle" });
        }));

        app.MapGet("/api/admin/console/bots/{id:guid}/runs", (HttpContext ctx, Guid id) => Run(ctx, platform, "read", async (_, role, conn) =>
        {
            var reveal = ctx.Request.Query["reveal"] == "1";
            if (reveal && !Access.Allows(role, "transcript")) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            var runs = await conn.QueryAsync("SELECT id, title, status, created_at, finished_at FROM tasks WHERE bot_id=@id ORDER BY created_at DESC LIMIT 20", new { id });
            var taskId = ctx.Request.Query["task"].ToString();
            object? transcript = null;
            if (Guid.TryParse(taskId, out var task))
            {
                var lines = (await conn.QueryAsync<(int Seq, string Role, string? Content)>("SELECT seq, role, content FROM task_transcript WHERE task_id=@task ORDER BY seq LIMIT 200", new { task })).ToList();
                transcript = lines.Select(line => reveal
                    ? (object)new { line.Seq, line.Role, content = line.Content }
                    : new { line.Seq, line.Role, bytes = line.Content?.Length ?? 0, redacted = true });
            }
            return Results.Json(new { runs = runs.Select(Platform.ToDict), transcript, revealed = reveal });
        }));

        app.MapGet("/api/admin/console/computers", (HttpContext ctx, CancellationToken _) => Run(ctx, platform, "read", async (_, _, conn) =>
        {
            var rows = (await conn.QueryAsync<(Guid ComputerId, Guid UserId, string Status, string Username, int Cpu, long Memory, long Disk)>(
                """
                SELECT c.computer_id, c.user_id, c.status, u.username,
                       coalesce(q.cpu_millis, 1000) AS cpu,
                       coalesce(q.memory_bytes, 0) AS memory,
                       coalesce(q.disk_bytes, 0) AS disk
                FROM user_computers c
                JOIN users u ON u.id=c.user_id
                LEFT JOIN user_quotas q ON q.user_id=c.user_id
                ORDER BY u.username
                """)).ToList();
            var list = new List<object>();
            foreach (var row in rows)
            {
                double? cpu = null;
                ulong? ram = null;
                ulong? disk = null;
                string live = "unavailable";
                try
                {
                    using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
                    cts.CancelAfter(TimeSpan.FromMilliseconds(1200));
                    var metrics = await platform.Compute.GetMetricsAsync(new ComputerId(row.ComputerId.ToString()), cts.Token);
                    cpu = metrics.CpuRatio;
                    ram = metrics.MemoryUsedBytes;
                    disk = metrics.DiskUsedBytes;
                    live = "live";
                }
                catch (Exception ex) when (ex is not OperationCanceledException || !ctx.RequestAborted.IsCancellationRequested)
                {
                    live = "quota";
                }
                list.Add(new
                {
                    computerId = row.ComputerId,
                    userId = row.UserId,
                    username = row.Username,
                    status = row.Status,
                    host = Environment.MachineName,
                    quotaCpuMillis = row.Cpu,
                    quotaMemoryBytes = row.Memory,
                    quotaDiskBytes = row.Disk,
                    cpuRatio = cpu,
                    memoryBytes = ram,
                    diskBytes = disk,
                    metrics = live
                });
            }
            var jobs = await conn.QueryAsync(
                """
                SELECT t.id, t.title, t.status, b.name AS bot, u.username
                FROM tasks t
                JOIN bots b ON b.id=t.bot_id
                JOIN users u ON u.id=b.owner_id
                WHERE t.status IN ('queued','planning','running','recovering')
                ORDER BY t.created_at
                LIMIT 100
                """);
            var saved = await conn.ExecuteScalarAsync<int?>("SELECT max_computers FROM host_capacity WHERE host_id='local'");
            return Results.Json(new
            {
                host = Environment.MachineName,
                maxComputers = platform.MaxComputers,
                savedMaxComputers = saved,
                note = "The running process keeps MAX_COMPUTERS until it restarts.",
                computers = list,
                jobs = jobs.Select(Platform.ToDict)
            });
        }));

        app.MapPost("/api/admin/console/computers/{id:guid}/{action}", (HttpContext ctx, Guid id, string action) => Run(ctx, platform, "kill", async (actor, _, conn) =>
        {
            if (action is not ("wake" or "sleep" or "stop")) return Results.NotFound();
            var known = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM user_computers WHERE computer_id=@id", new { id });
            if (known == 0) return Results.NotFound();
            if (action == "wake" && await Flag(conn, "computers_kill")) return Results.Json(new { error = "Computer wake is switched off." }, statusCode: 423);
            var computer = new ComputerId(id.ToString());
            var key = new IdempotencyKey($"admin-{action}-{id:N}");
            try
            {
                if (action == "wake") await platform.Compute.EnsureAwakeAsync(computer, ctx.RequestAborted);
                else await platform.Compute.StopComputerAsync(computer, new StopOptions(action == "stop", TimeSpan.FromSeconds(5)), key, ctx.RequestAborted);
            }
            catch (Exception ex)
            {
                return Results.Json(new { error = "The computer runtime refused that change.", detail = ex.GetType().Name }, statusCode: 409);
            }
            var status = action switch { "wake" => "running", "sleep" => "sleeping", _ => "stopped" };
            await conn.ExecuteAsync("UPDATE user_computers SET status=@status WHERE computer_id=@id", new { id, status });
            await platform.Audit(actor.ToString(), "admin.computer." + action, null, null, new { computerId = id, status });
            return Results.Json(new { id, status });
        }));

        app.MapPost("/api/admin/console/jobs/{id:guid}/kill", (HttpContext ctx, Guid id) => Run(ctx, platform, "kill", async (actor, _, conn) =>
        {
            var n = await conn.ExecuteAsync("UPDATE tasks SET status='cancelled', updated_at=now(), finished_at=now(), lease_owner=NULL WHERE id=@id AND status NOT IN ('completed','failed','cancelled')", new { id });
            if (n == 0) return Results.NotFound();
            await platform.Audit(actor.ToString(), "admin.job.kill", null, id, new { });
            return Results.Json(new { id, status = "cancelled" });
        }));

        app.MapPut("/api/admin/console/capacity", (HttpContext ctx, JsonElement body) => Run(ctx, platform, "plan", async (actor, _, conn) =>
        {
            if (!body.TryGetProperty("maxComputers", out var raw) || !raw.TryGetInt32(out var max) || max is < 1 or > 100)
                return Results.BadRequest(new { error = "Enter a computer cap from 1 to 100." });
            await conn.ExecuteAsync(
                """
                INSERT INTO host_capacity (host_id, max_computers, note, updated_at) VALUES ('local', @max, 'Saved for the next process start.', now())
                ON CONFLICT (host_id) DO UPDATE SET max_computers=EXCLUDED.max_computers, updated_at=now()
                """, new { max });
            await platform.Audit(actor.ToString(), "admin.capacity", null, null, new { max, applied = platform.MaxComputers });
            return Results.Json(new { savedMaxComputers = max, maxComputers = platform.MaxComputers, note = "The running process keeps MAX_COMPUTERS until it restarts." });
        }));

        app.MapGet("/api/admin/console/plans", (HttpContext ctx, CancellationToken _) => Run(ctx, platform, "read", async (_, _, conn) =>
        {
            var plans = await conn.QueryAsync("SELECT id AS plan_id, (price_usd*100)::int AS price_cents, weekly_credits, storage_quota_gb*1024 AS storage_mb, ram_mb, (cpu_max_cores*1000)::int AS cpu_millis FROM billing_plans ORDER BY price_usd");
            var topup = await conn.QuerySingleAsync("SELECT enabled, pack_credits, pack_cents, max_packs_per_week FROM topup_rules WHERE id='default'");
            var overrides = await conn.QueryAsync(
                """
                SELECT o.user_id, u.username, o.storage_mb, o.ram_mb, o.cpu_millis, o.weekly_credits
                FROM user_limit_overrides o JOIN users u ON u.id=o.user_id
                """);
            return Results.Json(new
            {
                plans = plans.Select(Platform.ToDict),
                topup = Platform.ToDict(topup),
                overrides = overrides.Select(Platform.ToDict),
                caps = new { storageMb = AdminLimits.MaxStorageMb, ramMb = AdminLimits.MaxRamMb, cpuMillis = AdminLimits.MaxCpuMillis }
            });
        }));

        app.MapPut("/api/admin/console/plans/{planId}", (HttpContext ctx, string planId, JsonElement body) => Run(ctx, platform, "plan", async (actor, _, conn) =>
        {
            if (!await conn.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM billing_plans WHERE id=@planId)", new { planId })) return Results.BadRequest(new { error = "Unknown plan." });
            var price = Int(body, "priceCents");
            var weekly = Int(body, "weeklyCredits");
            var storage = Int(body, "storageMb");
            var ram = Int(body, "ramMb");
            var cpu = Int(body, "cpuMillis");
            if (price == null || weekly == null || storage == null || ram == null || cpu == null || (price < 0 || price > 10_000_000 || weekly < 0 || weekly > 10_000_000 || storage < 1 || storage > 10_240_000 || ram < 512 || ram > 262144 || cpu < 250 || cpu > 64000))
                return Results.BadRequest(new { error = "Check the plan limits: storage 1–10,000 GB, RAM 512 MB–256 GB, and CPU 250–64,000 millis." });
            await conn.ExecuteAsync(
                """
                UPDATE billing_plans SET price_usd=@price/100.0, weekly_credits=@weekly,
                    storage_quota_gb=GREATEST(1,ceil(@storage/1024.0)::int), ram_mb=GREATEST(512,@ram),
                    cpu_min_cores=LEAST(cpu_min_cores,GREATEST(0.25,@cpu/1000.0)), cpu_max_cores=GREATEST(0.25,@cpu/1000.0), updated_at=now()
                WHERE id=@planId
                """, new { planId, price, weekly, storage, ram, cpu });
            await platform.Audit(actor.ToString(), "admin.plan", null, null, new { planId, price, weekly, storage, ram, cpu });
            return Results.Json(new { planId, priceCents = price, weeklyCredits = weekly, storageMb = storage, ramMb = ram, cpuMillis = cpu });
        }));

        app.MapPut("/api/admin/console/topup", (HttpContext ctx, JsonElement body) => Run(ctx, platform, "plan", async (actor, _, conn) =>
        {
            var enabled = body.TryGetProperty("enabled", out var flag) && flag.ValueKind == JsonValueKind.True;
            var credits = Int(body, "packCredits");
            var cents = Int(body, "packCents");
            var max = Int(body, "maxPacksPerWeek");
            if (credits is null or < 1 or > 1_000_000 || cents is null or < 0 or > 1_000_000 || max is null or < 0 or > 100)
                return Results.BadRequest(new { error = "Check the pack size, price, and weekly cap." });
            await conn.ExecuteAsync("UPDATE topup_rules SET enabled=@enabled, pack_credits=@credits, pack_cents=@cents, max_packs_per_week=@max, updated_at=now() WHERE id='default'", new { enabled, credits, cents, max });
            await conn.ExecuteAsync("UPDATE feature_flags SET enabled=@enabled, updated_at=now() WHERE key='topups_open'", new { enabled });
            await platform.Audit(actor.ToString(), "admin.topup", null, null, new { enabled, credits, cents, max });
            return Results.Json(new { enabled, packCredits = credits, packCents = cents, maxPacksPerWeek = max });
        }));

        app.MapPut("/api/admin/console/users/{id:guid}/limits", (HttpContext ctx, Guid id, JsonElement body) => Run(ctx, platform, "plan", async (actor, _, conn) =>
        {
            var exists = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM users WHERE id=@id", new { id });
            if (exists == 0) return Results.NotFound();
            int? storage = Optional(body, "storageMb");
            int? ram = Optional(body, "ramMb");
            int? cpu = Optional(body, "cpuMillis");
            int? weekly = Optional(body, "weeklyCredits");
            if (storage is < 1 or > AdminLimits.MaxStorageMb || ram is < 512 or > AdminLimits.MaxRamMb || cpu is < 250 or > AdminLimits.MaxCpuMillis || weekly is < 0 or > 1_000_000)
                return Results.BadRequest(new { error = "That override is outside the cap." });
            await conn.ExecuteAsync(
                """
                INSERT INTO user_limit_overrides (user_id, storage_mb, ram_mb, cpu_millis, weekly_credits, updated_at)
                VALUES (@id, @storage, @ram, @cpu, @weekly, now())
                ON CONFLICT (user_id) DO UPDATE SET storage_mb=EXCLUDED.storage_mb, ram_mb=EXCLUDED.ram_mb, cpu_millis=EXCLUDED.cpu_millis, weekly_credits=EXCLUDED.weekly_credits, updated_at=now()
                """, new { id, storage, ram, cpu, weekly });
            await platform.Audit(actor.ToString(), "admin.limits", null, null, new { userId = id, storage, ram, cpu, weekly });
            return Results.Json(new { id, storageMb = storage, ramMb = ram, cpuMillis = cpu, weeklyCredits = weekly });
        }));

        app.MapGet("/api/admin/console/billing", (HttpContext ctx, CancellationToken _) => Run(ctx, platform, "read", async (_, _, conn) =>
        {
            var usage = await conn.QueryAsync(
                """
                SELECT u.id, u.username,
                       (SELECT count(*) FROM model_calls m WHERE m.owner_id=u.id) AS ai_calls,
                       (SELECT coalesce(sum(m.cost_usd), 0) FROM model_calls m WHERE m.owner_id=u.id) AS ai_spend,
                       (SELECT count(*) FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE b.owner_id=u.id) AS computer_tasks,
                       (SELECT coalesce(sum(a.size_bytes), 0) FROM artifacts a JOIN bots b ON b.id=a.bot_id WHERE b.owner_id=u.id) AS storage_bytes,
                       coalesce(ba.credit_balance, 0) AS credits
                FROM users u
                LEFT JOIN billing_accounts ba ON ba.user_id=u.id
                ORDER BY u.username
                """);
            var invoices = await conn.QueryAsync("SELECT i.id, i.user_id, u.username, i.number, i.plan_id, i.amount_cents, i.currency, i.status, i.provider, i.issued_at FROM invoices i JOIN users u ON u.id=i.user_id ORDER BY i.issued_at DESC LIMIT 100");
            var ledger = await conn.QueryAsync("SELECT id, user_id, kind, credits, amount_cents, note, created_at FROM credit_ledger ORDER BY created_at DESC LIMIT 100");
            var provider = platform.BillingProviderName;
            var providerStatus = provider is BillingProviders.Paddle or BillingProviders.LemonSqueezy
                ? "not included in this build"
                : provider == BillingProviders.Mock ? "mock" : "unknown";
            return Results.Json(new
            {
                usage = usage.Select(Platform.ToDict),
                invoices = invoices.Select(Platform.ToDict),
                ledger = ledger.Select(Platform.ToDict),
                provider = new { name = provider, status = providerStatus, chargesCard = false }
            });
        }));

        app.MapPost("/api/admin/console/grants", (HttpContext ctx, JsonElement body) => Run(ctx, platform, "grant", async (actor, _, conn) =>
        {
            if (!Guid.TryParse(Str(body, "userId"), out var userId)) return Results.BadRequest(new { error = "Choose a person." });
            var credits = Int(body, "credits");
            if (credits is null or < 1 or > 1_000_000) return Results.BadRequest(new { error = "Enter a credit amount." });
            await AccountRoutes.EnsureBilling(conn, userId);
            var balance = await conn.ExecuteScalarAsync<int?>("SELECT credit_balance FROM billing_accounts WHERE user_id=@userId", new { userId });
            if (balance == null) return Results.NotFound();
            int next;
            try { next = BillingMath.AdjustBalance(balance.Value, null, credits); }
            catch (ArgumentOutOfRangeException) { return Results.BadRequest(new { error = "That grant is too large." }); }
            await conn.ExecuteAsync("UPDATE billing_accounts SET credit_balance=@next, provider='mock', updated_at=now() WHERE user_id=@userId", new { userId, next });
            await conn.ExecuteAsync("INSERT INTO credit_ledger (user_id, kind, credits, note, actor_id) VALUES (@userId, 'grant', @credits, 'staff grant', @actor)", new { userId, credits, actor });
            await platform.Audit(actor.ToString(), "admin.grant", null, null, new { userId, credits });
            return Results.Json(new { userId, creditBalance = next });
        }));

        app.MapPost("/api/admin/console/topup-packs", (HttpContext ctx, JsonElement body) => Run(ctx, platform, "grant", async (actor, _, conn) =>
        {
            if (!await Flag(conn, "topups_open")) return Results.Json(new { error = "Top-up packs are off." }, statusCode: 423);
            if (!Guid.TryParse(Str(body, "userId"), out var userId)) return Results.BadRequest(new { error = "Choose a person." });
            var rule = await conn.QuerySingleAsync<(int Credits, int Cents, int Max)>("SELECT pack_credits, pack_cents, max_packs_per_week FROM topup_rules WHERE id='default'");
            var used = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM credit_ledger WHERE user_id=@userId AND kind='topup' AND created_at >= now() - interval '7 days'", new { userId });
            if (used >= rule.Max) return Results.BadRequest(new { error = "That account is at the weekly pack cap." });
            await AccountRoutes.EnsureBilling(conn, userId);
            var balance = await conn.ExecuteScalarAsync<int?>("SELECT credit_balance FROM billing_accounts WHERE user_id=@userId", new { userId });
            if (balance == null) return Results.NotFound();
            var next = BillingMath.AdjustBalance(balance.Value, null, rule.Credits);
            await conn.ExecuteAsync("UPDATE billing_accounts SET credit_balance=@next, provider='mock', updated_at=now() WHERE user_id=@userId", new { userId, next });
            await conn.ExecuteAsync("INSERT INTO credit_ledger (user_id, kind, credits, amount_cents, note, actor_id) VALUES (@userId, 'topup', @credits, @cents, 'pack recorded, not charged', @actor)", new { userId, credits = rule.Credits, cents = rule.Cents, actor });
            await platform.Audit(actor.ToString(), "admin.topup.pack", null, null, new { userId, rule.Credits });
            return Results.Json(new { userId, credits = rule.Credits, charged = false });
        }));

        app.MapPost("/api/admin/console/refunds", (HttpContext ctx, JsonElement body) => Run(ctx, platform, "refund", async (actor, _, conn) =>
        {
            if (!Guid.TryParse(Str(body, "invoiceId"), out var invoiceId)) return Results.BadRequest(new { error = "Choose an invoice." });
            var amount = Int(body, "amountCents");
            var reason = Str(body, "reason")?.Trim() ?? "";
            if (amount == null || reason.Length is < 1 or > 400) return Results.BadRequest(new { error = "Enter an amount and a reason." });
            var invoice = await conn.QuerySingleOrDefaultAsync<(Guid UserId, int Amount, string Provider)>("SELECT user_id, amount_cents, provider FROM invoices WHERE id=@invoiceId", new { invoiceId });
            if (invoice.UserId == Guid.Empty) return Results.NotFound();
            if (invoice.Provider is BillingProviders.Paddle or BillingProviders.LemonSqueezy)
                return Results.Json(new { error = "That provider is not included in this build." }, statusCode: 409);
            var already = await conn.ExecuteScalarAsync<int>("SELECT coalesce(sum(amount_cents), 0) FROM refunds WHERE invoice_id=@invoiceId", new { invoiceId });
            if (!AdminLimits.RefundFits(invoice.Amount, already, amount.Value)) return Results.BadRequest(new { error = "That refund is larger than the invoice." });
            var id = await conn.ExecuteScalarAsync<Guid>("INSERT INTO refunds (invoice_id, user_id, amount_cents, reason, actor_id) VALUES (@invoiceId, @user, @amount, @reason, @actor) RETURNING id", new { invoiceId, user = invoice.UserId, amount, reason, actor });
            if (already + amount == invoice.Amount)
                await conn.ExecuteAsync("UPDATE invoices SET status='refunded' WHERE id=@invoiceId", new { invoiceId });
            await conn.ExecuteAsync("INSERT INTO credit_ledger (user_id, kind, amount_cents, note, actor_id) VALUES (@user, 'refund', @amount, @reason, @actor)", new { user = invoice.UserId, amount, reason, actor });
            await platform.Audit(actor.ToString(), "admin.refund", null, null, new { invoiceId, amount });
            return Results.Json(new { id, charged = false });
        }));

        app.MapGet("/api/admin/console/models", (HttpContext ctx, CancellationToken _) => Run(ctx, platform, "read", async (_, _, conn) =>
        {
            var models = await conn.QueryAsync("SELECT id, label, provider, enabled, is_default, is_fallback, daily_spend_cap_cents, killed FROM model_registry ORDER BY id");
            var kill = await Flag(conn, "model_kill");
            return Results.Json(new
            {
                models = models.Select(Platform.ToDict),
                killSwitch = kill,
                merge = new { branch = ModelMergeBranch, safetyFeatures = ModelSafetyFeatures, contract = "model_registry" }
            });
        }));

        app.MapPut("/api/admin/console/models/{id}", (HttpContext ctx, string id, JsonElement body) => Run(ctx, platform, "flag", async (actor, _, conn) =>
        {
            var label = Str(body, "label")?.Trim() ?? "";
            var provider = Str(body, "provider")?.Trim() ?? "";
            if (label.Length is < 1 or > 80 || provider.Length is < 1 or > 40) return Results.BadRequest(new { error = "Enter a label and a provider." });
            var enabled = Bool(body, "enabled");
            var isDefault = Bool(body, "isDefault");
            var isFallback = Bool(body, "isFallback");
            var cap = Int(body, "dailySpendCapCents");
            if (cap is null or < 0 or > 10_000_000) return Results.BadRequest(new { error = "Enter a spend cap. Zero means uncapped." });
            if (isDefault == true) await conn.ExecuteAsync("UPDATE model_registry SET is_default=false");
            if (isFallback == true) await conn.ExecuteAsync("UPDATE model_registry SET is_fallback=false");
            await conn.ExecuteAsync(
                """
                INSERT INTO model_registry (id, label, provider, enabled, is_default, is_fallback, daily_spend_cap_cents, updated_at)
                VALUES (@id, @label, @provider, @enabled, @isDefault, @isFallback, @cap, now())
                ON CONFLICT (id) DO UPDATE SET label=EXCLUDED.label, provider=EXCLUDED.provider, enabled=EXCLUDED.enabled,
                    is_default=EXCLUDED.is_default, is_fallback=EXCLUDED.is_fallback, daily_spend_cap_cents=EXCLUDED.daily_spend_cap_cents, updated_at=now()
                """, new { id, label, provider, enabled, isDefault, isFallback, cap });
            await platform.Audit(actor.ToString(), "admin.model", null, null, new { id, isDefault, cap });
            return Results.Json(new { id, label, provider, enabled, isDefault, isFallback, dailySpendCapCents = cap });
        }));

        app.MapPost("/api/admin/console/models/kill", (HttpContext ctx, JsonElement body) => Run(ctx, platform, "flag", async (actor, _, conn) =>
        {
            var killed = Bool(body, "killed");
            await conn.ExecuteAsync("UPDATE feature_flags SET enabled=@killed, updated_at=now() WHERE key='model_kill'", new { killed });
            await conn.ExecuteAsync("UPDATE model_registry SET killed=@killed, updated_at=now()", new { killed });
            await platform.Audit(actor.ToString(), "admin.model.kill", null, null, new { killed });
            return Results.Json(new { killed });
        }));

        app.MapGet("/api/admin/console/storage", (HttpContext ctx, CancellationToken _) => Run(ctx, platform, "read", async (_, _, conn) =>
        {
            var byUser = await conn.QueryAsync(
                """
                SELECT u.id, u.username, coalesce(sum(a.size_bytes), 0) AS bytes, count(a.id) AS files
                FROM users u
                LEFT JOIN bots b ON b.owner_id=u.id
                LEFT JOIN artifacts a ON a.bot_id=b.id
                GROUP BY u.id
                ORDER BY bytes DESC
                """);
            var cleanups = await conn.QueryAsync("SELECT id, status, bytes_freed, note, started_at, finished_at FROM admin_cleanup_runs ORDER BY started_at DESC LIMIT 10");
            var backups = await conn.QueryAsync("SELECT id, label, status, bytes, note, started_at, finished_at FROM backups ORDER BY started_at DESC LIMIT 10");
            object store;
            try
            {
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
                cts.CancelAfter(TimeSpan.FromSeconds(2));
                var listed = await platform.S3.ListObjectsV2Async(new ListObjectsV2Request { BucketName = platform.Bucket, MaxKeys = 50 }, cts.Token);
                store = new { status = "ok", bucket = platform.Bucket, keys = listed.S3Objects?.Count ?? 0 };
            }
            catch (Exception ex)
            {
                store = new { status = "unavailable", bucket = platform.Bucket, detail = ex.GetType().Name };
            }
            return Results.Json(new { users = byUser.Select(Platform.ToDict), cleanups = cleanups.Select(Platform.ToDict), backups = backups.Select(Platform.ToDict), objectStore = store });
        }));

        app.MapPost("/api/admin/console/cleanup", (HttpContext ctx, CancellationToken _) => Run(ctx, platform, "cleanup", async (actor, _, conn) =>
        {
            var run = await conn.ExecuteScalarAsync<Guid>("INSERT INTO admin_cleanup_runs (status, note) VALUES ('running', 'Artifacts older than 90 days.') RETURNING id");
            var old = (await conn.QueryAsync<(Guid Id, string Key, long Size)>("SELECT id, object_key, size_bytes FROM artifacts WHERE created_at < now() - interval '90 days'")).ToList();
            long freed = 0;
            var removed = 0;
            foreach (var row in old)
            {
                try
                {
                    await platform.S3.DeleteObjectAsync(platform.Bucket, row.Key, ctx.RequestAborted);
                    await conn.ExecuteAsync("DELETE FROM artifacts WHERE id=@id", new { row.Id });
                    freed += row.Size;
                    removed++;
                }
                catch (Exception ex)
                {
                    await conn.ExecuteAsync("UPDATE admin_cleanup_runs SET status='failed', bytes_freed=@freed, note=@note, finished_at=now() WHERE id=@run", new { run, freed, note = ex.GetType().Name });
                    return Results.Json(new { id = run, status = "failed", removed, bytesFreed = freed }, statusCode: 502);
                }
            }
            var note = removed == 0 ? "Nothing older than 90 days." : $"Removed {removed} objects.";
            await conn.ExecuteAsync("UPDATE admin_cleanup_runs SET status='completed', bytes_freed=@freed, note=@note, finished_at=now() WHERE id=@run", new { run, freed, note });
            await platform.Audit(actor.ToString(), "admin.cleanup", null, null, new { removed, freed });
            return Results.Json(new { id = run, status = "completed", removed, bytesFreed = freed, note });
        }));

        app.MapPost("/api/admin/console/backups", (HttpContext ctx, CancellationToken _) => Run(ctx, platform, "backup", async (actor, _, conn) =>
        {
            var bytes = await conn.ExecuteScalarAsync<long>("SELECT pg_database_size(current_database())");
            var id = await conn.ExecuteScalarAsync<Guid>(
                """
                INSERT INTO backups (label, status, bytes, note, finished_at)
                VALUES ('catalog', 'recorded', @bytes, 'Size recorded. An offsite copy is not configured.', now())
                RETURNING id
                """, new { bytes });
            await platform.Audit(actor.ToString(), "admin.backup", null, null, new { id, bytes });
            return Results.Json(new { id, status = "recorded", bytes, note = "Size recorded. An offsite copy is not configured." });
        }));

        app.MapGet("/api/admin/console/plugins", (HttpContext ctx, CancellationToken _) => Run(ctx, platform, "read", async (_, _, conn) =>
        {
            var rows = await conn.QueryAsync("SELECT id, name, publisher, category, trust, blocked, featured, health_status FROM plugin_catalog ORDER BY featured DESC, name LIMIT 300");
            return Results.Json(new { plugins = rows.Select(Platform.ToDict) });
        }));

        app.MapPost("/api/admin/console/plugins/{id}/state", (HttpContext ctx, string id, JsonElement body) => Run(ctx, platform, "plugin", async (actor, _, conn) =>
        {
            var blocked = Bool(body, "blocked");
            var featured = Bool(body, "featured");
            var n = await conn.ExecuteAsync("UPDATE plugin_catalog SET blocked=@blocked, featured=@featured, updated_at=now() WHERE id=@id", new { id, blocked, featured });
            if (n == 0) return Results.NotFound();
            await platform.Audit(actor.ToString(), "admin.plugin", null, null, new { id, blocked, featured });
            return Results.Json(new { id, blocked, featured });
        }));

        app.MapGet("/api/admin/console/flags", (HttpContext ctx, CancellationToken _) => Run(ctx, platform, "read", async (_, _, conn) =>
        {
            var flags = await conn.QueryAsync("SELECT key, enabled, description, kind FROM feature_flags ORDER BY kind, key");
            var message = await conn.ExecuteScalarAsync<string>("SELECT value FROM platform_settings WHERE key='maintenance_message'") ?? "";
            return Results.Json(new { flags = flags.Select(Platform.ToDict), maintenanceMessage = message });
        }));

        app.MapPut("/api/admin/console/flags/{key}", (HttpContext ctx, string key, JsonElement body) => Run(ctx, platform, FlagAction(key), async (actor, _, conn) =>
        {
            var enabled = Bool(body, "enabled");
            var n = await conn.ExecuteAsync("UPDATE feature_flags SET enabled=@enabled, updated_at=now() WHERE key=@key", new { key, enabled });
            if (n == 0) return Results.NotFound();
            if (key == "maintenance_mode")
            {
                var message = Str(body, "message")?.Trim() ?? "";
                if (message.Length > 240) return Results.BadRequest(new { error = "Keep the banner under 240 characters." });
                await UpsertSetting(conn, "maintenance_message", message);
            }
            await platform.Audit(actor.ToString(), "admin.flag", null, null, new { key, enabled });
            return Results.Json(new { key, enabled });
        }));

        app.MapGet("/api/admin/console/announcements", (HttpContext ctx, CancellationToken _) => Run(ctx, platform, "read", async (_, _, conn) =>
        {
            var rows = await conn.QueryAsync("SELECT id, title, body, kind, published, starts_at, ends_at, created_at FROM announcements ORDER BY created_at DESC LIMIT 100");
            return Results.Json(new { announcements = rows.Select(Platform.ToDict) });
        }));

        app.MapPost("/api/admin/console/announcements", (HttpContext ctx, JsonElement body) => Run(ctx, platform, "announce", async (actor, _, conn) =>
        {
            var title = Str(body, "title")?.Trim() ?? "";
            var text = Str(body, "body")?.Trim() ?? "";
            var kind = Str(body, "kind") ?? "banner";
            if (title.Length is < 1 or > 120 || text.Length > 4000 || kind is not ("banner" or "changelog"))
                return Results.BadRequest(new { error = "Enter a title. Kind is banner or changelog." });
            var published = Bool(body, "published");
            var id = await conn.ExecuteScalarAsync<Guid>("INSERT INTO announcements (title, body, kind, published) VALUES (@title, @text, @kind, @published) RETURNING id", new { title, text, kind, published });
            await platform.Audit(actor.ToString(), "admin.announcement", null, null, new { id, kind, published });
            return Results.Json(new { id }, statusCode: 201);
        }));

        app.MapGet("/api/admin/console/templates", (HttpContext ctx, CancellationToken _) => Run(ctx, platform, "read", async (_, _, conn) =>
        {
            var rows = await conn.QueryAsync("SELECT id, subject, body, updated_at FROM email_templates ORDER BY id");
            return Results.Json(new { templates = rows.Select(Platform.ToDict), provider = "resend", configured = platform.ResendConfigured });
        }));

        app.MapPut("/api/admin/console/templates/{id}", (HttpContext ctx, string id, JsonElement body) => Run(ctx, platform, "template", async (actor, _, conn) =>
        {
            var subject = Str(body, "subject")?.Trim() ?? "";
            var text = Str(body, "body")?.Trim() ?? "";
            if (subject.Length is < 1 or > 140 || text.Length is < 1 or > 8000) return Results.BadRequest(new { error = "Enter a subject and a body." });
            var n = await conn.ExecuteAsync("UPDATE email_templates SET subject=@subject, body=@text, updated_at=now() WHERE id=@id", new { id, subject, text });
            if (n == 0) return Results.NotFound();
            await platform.Audit(actor.ToString(), "admin.template", null, null, new { id });
            return Results.Json(new { id, subject, provider = "resend", configured = platform.ResendConfigured });
        }));

        app.MapGet("/api/admin/console/support", (HttpContext ctx, CancellationToken _) => Run(ctx, platform, "read", async (_, _, conn) =>
        {
            var tickets = await conn.QueryAsync("SELECT id, email, topic, body, status, staff_note, created_at FROM support_messages ORDER BY created_at DESC LIMIT 100");
            var feedback = await conn.QueryAsync("SELECT f.id, u.username, f.category, f.message, f.created_at FROM feedback f JOIN users u ON u.id=f.owner_user_id ORDER BY f.created_at DESC LIMIT 100");
            var down = await conn.QueryAsync(
                """
                SELECT bf.id, b.name AS bot, bf.emoji, bf.action, bf.created_at
                FROM bot_feedback bf JOIN bots b ON b.id=bf.bot_id
                WHERE bf.emoji IN ('👎', '-1', 'thumbs_down', 'thumbdown')
                ORDER BY bf.created_at DESC LIMIT 100
                """);
            return Results.Json(new { tickets = tickets.Select(Platform.ToDict), feedback = feedback.Select(Platform.ToDict), thumbsDown = down.Select(Platform.ToDict) });
        }));

        app.MapPost("/api/admin/console/support/{id:guid}", (HttpContext ctx, Guid id, JsonElement body) => Run(ctx, platform, "ticket", async (actor, _, conn) =>
        {
            var status = Str(body, "status") ?? "open";
            var note = Str(body, "staffNote")?.Trim() ?? "";
            if (status is not ("open" or "closed") || note.Length > 4000) return Results.BadRequest(new { error = "Status is open or closed." });
            var n = await conn.ExecuteAsync("UPDATE support_messages SET status=@status, staff_note=@note WHERE id=@id", new { id, status, note });
            if (n == 0) return Results.NotFound();
            await platform.Audit(actor.ToString(), "admin.ticket", null, null, new { id, status });
            return Results.Json(new { id, status });
        }));

        app.MapGet("/api/admin/console/security", (HttpContext ctx, CancellationToken _) => Run(ctx, platform, "read", async (_, _, conn) =>
        {
            var sessions = await conn.QueryAsync(
                """
                SELECT s.id, u.username, u.role, s.ip, s.created_at, s.expires_at
                FROM sessions s JOIN users u ON u.id=s.user_id
                WHERE u.role IN ('owner','admin','support','readonly')
                ORDER BY s.created_at DESC LIMIT 100
                """);
            var keys = await conn.QueryAsync("SELECT id, name, prefix, created_at, revoked_at FROM admin_api_keys ORDER BY created_at DESC");
            var allow = await conn.QueryAsync("SELECT id, cidr, note, created_at FROM admin_ip_allowlist ORDER BY created_at");
            var secrets = await conn.QueryAsync(
                """
                SELECT s.id, s.name, s.provider, s.masked_suffix, s.rotated_at, u.username
                FROM secrets s JOIN users u ON u.id=s.owner_user_id
                WHERE s.revoked_at IS NULL
                ORDER BY s.updated_at DESC LIMIT 100
                """);
            var totp = await conn.QueryAsync(
                """
                SELECT u.username, u.role, coalesce(t.enabled, false) AS enrolled
                FROM users u LEFT JOIN admin_totp t ON t.user_id=u.id
                WHERE u.role IN ('owner','admin')
                ORDER BY u.username
                """);
            return Results.Json(new
            {
                sessions = sessions.Select(Platform.ToDict),
                apiKeys = keys.Select(Platform.ToDict),
                allowlist = allow.Select(Platform.ToDict),
                secrets = secrets.Select(Platform.ToDict),
                totp = totp.Select(Platform.ToDict),
                totpRequired = true
            });
        }));

        app.MapPost("/api/admin/console/totp/start", (HttpContext ctx, CancellationToken _) => Run(ctx, platform, "totp", async (id, _, conn) =>
        {
            var secret = AdminTotp.GenerateSecret();
            var stored = AdminTotp.Protect(platform.MasterKey, id, secret);
            await conn.ExecuteAsync(
                """
                INSERT INTO admin_totp (user_id, secret, enabled) VALUES (@id, @stored, false)
                ON CONFLICT (user_id) DO UPDATE SET secret=EXCLUDED.secret, enabled=false, confirmed_at=NULL
                """, new { id, stored });
            var username = await conn.ExecuteScalarAsync<string>("SELECT username FROM users WHERE id=@id", new { id });
            await platform.Audit(id.ToString(), "admin.totp.start", null, null, new { });
            return Results.Json(new { secret, otpauth = $"otpauth://totp/AI%20Teammates:{Uri.EscapeDataString(username ?? "staff")}?secret={secret}&issuer=AI%20Teammates" });
        }));

        app.MapPost("/api/admin/console/totp/confirm", (HttpContext ctx, JsonElement body) => Run(ctx, platform, "totp", async (id, _, conn) =>
        {
            var stored = await conn.ExecuteScalarAsync<string>("SELECT secret FROM admin_totp WHERE user_id=@id", new { id });
            if (string.IsNullOrEmpty(stored)) return Results.BadRequest(new { error = "Start enrollment first." });
            var secret = AdminTotp.Unprotect(platform.MasterKey, id, stored);
            if (!AdminTotp.Verify(secret, Str(body, "code"), DateTimeOffset.UtcNow)) return Results.BadRequest(new { error = "That code was not accepted." });
            await conn.ExecuteAsync("UPDATE admin_totp SET enabled=true, confirmed_at=now() WHERE user_id=@id", new { id });
            await platform.Audit(id.ToString(), "admin.totp.confirm", null, null, new { });
            return Results.Json(new { enrolled = true });
        }));

        app.MapPost("/api/admin/console/api-keys", (HttpContext ctx, JsonElement body) => Run(ctx, platform, "apikey", async (actor, _, conn) =>
        {
            var name = Str(body, "name")?.Trim() ?? "";
            if (name.Length is < 1 or > 60) return Results.BadRequest(new { error = "Name the key." });
            var secret = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
            var prefix = secret[..8];
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(secret))).ToLowerInvariant();
            var id = await conn.ExecuteScalarAsync<Guid>("INSERT INTO admin_api_keys (name, prefix, secret_hash, created_by) VALUES (@name, @prefix, @hash, @actor) RETURNING id", new { name, prefix, hash, actor });
            await platform.Audit(actor.ToString(), "admin.apikey.create", null, null, new { id, prefix });
            return Results.Json(new { id, prefix, secret }, statusCode: 201);
        }));

        app.MapPost("/api/admin/console/api-keys/{id:guid}/rotate", (HttpContext ctx, Guid id) => Run(ctx, platform, "apikey", async (actor, _, conn) =>
        {
            var secret = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
            var prefix = secret[..8];
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(secret))).ToLowerInvariant();
            var n = await conn.ExecuteAsync("UPDATE admin_api_keys SET prefix=@prefix, secret_hash=@hash, revoked_at=NULL WHERE id=@id", new { id, prefix, hash });
            if (n == 0) return Results.NotFound();
            await platform.Audit(actor.ToString(), "admin.apikey.rotate", null, null, new { id, prefix });
            return Results.Json(new { id, prefix, secret });
        }));

        app.MapDelete("/api/admin/console/api-keys/{id:guid}", (HttpContext ctx, Guid id) => Run(ctx, platform, "apikey", async (actor, _, conn) =>
        {
            var n = await conn.ExecuteAsync("UPDATE admin_api_keys SET revoked_at=now() WHERE id=@id AND revoked_at IS NULL", new { id });
            if (n == 0) return Results.NotFound();
            await platform.Audit(actor.ToString(), "admin.apikey.revoke", null, null, new { id });
            return Results.Json(new { id, revoked = true });
        }));

        app.MapPost("/api/admin/console/allowlist", (HttpContext ctx, JsonElement body) => Run(ctx, platform, "apikey", async (actor, _, conn) =>
        {
            var cidr = Str(body, "cidr")?.Trim() ?? "";
            var note = Str(body, "note")?.Trim() ?? "";
            if (!AdminNet.ValidCidr(cidr) || note.Length > 120) return Results.BadRequest(new { error = "Enter a CIDR." });
            var id = await conn.ExecuteScalarAsync<Guid>("INSERT INTO admin_ip_allowlist (cidr, note) VALUES (@cidr, @note) ON CONFLICT (cidr) DO UPDATE SET note=EXCLUDED.note RETURNING id", new { cidr, note });
            await platform.Audit(actor.ToString(), "admin.allowlist.add", null, null, new { cidr });
            return Results.Json(new { id, cidr });
        }));

        app.MapDelete("/api/admin/console/allowlist/{id:guid}", (HttpContext ctx, Guid id) => Run(ctx, platform, "apikey", async (actor, _, conn) =>
        {
            var n = await conn.ExecuteAsync("DELETE FROM admin_ip_allowlist WHERE id=@id", new { id });
            if (n == 0) return Results.NotFound();
            await platform.Audit(actor.ToString(), "admin.allowlist.remove", null, null, new { id });
            return Results.Json(new { deleted = true });
        }));

        app.MapDelete("/api/admin/console/sessions/{id:guid}", (HttpContext ctx, Guid id) => Run(ctx, platform, "secret", async (actor, _, conn) =>
        {
            var n = await conn.ExecuteAsync("DELETE FROM sessions WHERE id=@id", new { id });
            if (n == 0) return Results.NotFound();
            await platform.Audit(actor.ToString(), "admin.session.revoke", null, null, new { id });
            return Results.Json(new { deleted = true });
        }));

        app.MapPost("/api/admin/console/secrets/{id:guid}/rotate", (HttpContext ctx, Guid id) => Run(ctx, platform, "secret", async (actor, _, conn) =>
        {
            var row = await conn.QuerySingleOrDefaultAsync<(Guid Owner, string Type, string Name)>("SELECT owner_user_id, type, name FROM secrets WHERE id=@id AND revoked_at IS NULL", new { id });
            if (row.Owner == Guid.Empty) return Results.NotFound();
            var fresh = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
            var (cipher, nonce) = KeyEncryption.Encrypt(platform.MasterKey, id, row.Owner, row.Type, KeyEncryption.KeyVersion, Encoding.UTF8.GetBytes(fresh));
            var suffix = fresh[^4..];
            await conn.ExecuteAsync("UPDATE secrets SET ciphertext=@cipher, nonce=@nonce, masked_suffix=@suffix, rotated_at=now(), updated_at=now(), key_version=@version WHERE id=@id", new { id, cipher, nonce, suffix, version = KeyEncryption.KeyVersion });
            await platform.Audit(actor.ToString(), "admin.secret.rotate", null, null, new { id, name = row.Name });
            return Results.Json(new { id, secret = fresh, masked = "••••" + suffix });
        }));

        app.MapGet("/api/admin/console/audit", async (HttpContext ctx, CancellationToken _) =>
        {
            var format = ctx.Request.Query["format"].ToString();
            return await Run(ctx, platform, "read", async (_, _, conn) =>
            {
                var action = ctx.Request.Query["action"].ToString().Trim();
                var actor = ctx.Request.Query["actor"].ToString().Trim();
                var limit = format == "csv" ? 5000 : 200;
                var rows = (await conn.QueryAsync<(long Id, DateTime At, string Actor, string Action, string Detail)>(
                    """
                    SELECT id, at, actor, action, detail::text
                    FROM audit_events
                    WHERE (@action = '' OR action ILIKE @actionLike)
                      AND (@actor = '' OR actor ILIKE @actorLike)
                    ORDER BY id DESC
                    LIMIT @limit
                    """, new { action, actionLike = "%" + action + "%", actor, actorLike = "%" + actor + "%", limit })).ToList();
                if (format == "csv")
                {
                    var csv = new StringBuilder("id,at,actor,action,detail\n");
                    foreach (var row in rows)
                        csv.Append(row.Id).Append(',').Append(row.At.ToString("o")).Append(',').Append(Csv(row.Actor)).Append(',').Append(Csv(row.Action)).Append(',').Append(Csv(row.Detail)).Append('\n');
                    return Results.Text(csv.ToString(), "text/csv");
                }
                return Results.Json(new { events = rows.Select(row => new { row.Id, row.At, row.Actor, row.Action, row.Detail }) });
            });
        });

        app.MapGet("/api/admin/console/health", (HttpContext ctx, CancellationToken _) => Run(ctx, platform, "read", async (_, _, conn) =>
        {
            var postgres = await conn.ExecuteScalarAsync<int>("SELECT 1") == 1;
            var queues = await conn.QueryAsync("SELECT status, count(*) AS count FROM tasks GROUP BY status ORDER BY status");
            var errors = await conn.QueryAsync("SELECT id, title, error, updated_at FROM tasks WHERE status='failed' ORDER BY updated_at DESC LIMIT 30");
            var modelErrors = await conn.QueryAsync("SELECT id, provider, model, created_at FROM model_calls WHERE ok=false ORDER BY created_at DESC LIMIT 30");
            var alerts = await conn.QueryAsync("SELECT id, enabled, threshold, channel FROM alert_rules ORDER BY id");
            object uptime;
            try { uptime = await UptimeBoard.Load(conn); }
            catch (Exception ex) { uptime = new { error = ex.GetType().Name }; }
            return Results.Json(new
            {
                postgres,
                isolation = platform.Compute.ComputerIsolationHealthy,
                uptime,
                queues = queues.Select(Platform.ToDict),
                errors = errors.Select(Platform.ToDict),
                modelErrors = modelErrors.Select(Platform.ToDict),
                alerts = alerts.Select(Platform.ToDict)
            });
        }));

        app.MapPut("/api/admin/console/alerts/{id}", (HttpContext ctx, string id, JsonElement body) => Run(ctx, platform, "alert", async (actor, _, conn) =>
        {
            var enabled = Bool(body, "enabled");
            var threshold = Str(body, "threshold")?.Trim() ?? "";
            var channel = Str(body, "channel")?.Trim() ?? "audit";
            if (threshold.Length is < 1 or > 160 || channel is not ("audit" or "email")) return Results.BadRequest(new { error = "Enter a threshold. Channel is audit or email." });
            var n = await conn.ExecuteAsync("UPDATE alert_rules SET enabled=@enabled, threshold=@threshold, channel=@channel, updated_at=now() WHERE id=@id", new { id, enabled, threshold, channel });
            if (n == 0) return Results.NotFound();
            await platform.Audit(actor.ToString(), "admin.alert", null, null, new { id, enabled, channel });
            return Results.Json(new { id, enabled, threshold, channel });
        }));

        app.MapGet("/api/admin/console/settings", (HttpContext ctx, CancellationToken _) => Run(ctx, platform, "read", async (_, _, conn) =>
        {
            var keys = new[] { "brand_name", "support_email", "app_domain", "admin_domain", "legal_terms", "legal_privacy", "maintenance_message" };
            var values = new Dictionary<string, string>();
            foreach (var key in keys)
                values[key] = await conn.ExecuteScalarAsync<string>("SELECT value FROM platform_settings WHERE key=@key", new { key }) ?? "";
            return Results.Json(values);
        }));

        app.MapPut("/api/admin/console/settings", (HttpContext ctx, JsonElement body) => Run(ctx, platform, "maintenance", async (actor, _, conn) =>
        {
            foreach (var key in new[] { "brand_name", "support_email", "app_domain", "admin_domain", "legal_terms", "legal_privacy" })
            {
                var value = Str(body, ToCamel(key))?.Trim() ?? "";
                if (value.Length > 20000) return Results.BadRequest(new { error = "That value is too long." });
                await UpsertSetting(conn, key, value);
            }
            await platform.Audit(actor.ToString(), "admin.settings", null, null, new { });
            return Results.Json(new { ok = true });
        }));

        app.MapGet("/api/admin/console/gdpr/{id:guid}", (HttpContext ctx, Guid id) => Run(ctx, platform, "export", async (actor, _, conn) =>
        {
            var user = await conn.QuerySingleOrDefaultAsync("SELECT id, username, display_name, email, role, status, created_at FROM users WHERE id=@id", new { id });
            if (user == null) return Results.NotFound();
            var billing = await conn.QuerySingleOrDefaultAsync("SELECT plan_id, credit_balance, credit_allowance, provider FROM billing_accounts WHERE user_id=@id", new { id });
            var invoices = await conn.QueryAsync("SELECT number, plan_id, amount_cents, status, issued_at FROM invoices WHERE user_id=@id", new { id });
            var bots = await conn.QueryAsync("SELECT id, name, status FROM bots WHERE owner_id=@id", new { id });
            await platform.Audit(actor.ToString(), "admin.gdpr.export", null, null, new { userId = id });
            return Results.Json(new { user = Platform.ToDict(user), billing = billing == null ? null : Platform.ToDict(billing), invoices = invoices.Select(Platform.ToDict), bots = bots.Select(Platform.ToDict) });
        }));

        app.MapDelete("/api/admin/console/gdpr/{id:guid}", (HttpContext ctx, Guid id, [Microsoft.AspNetCore.Mvc.FromBody] JsonElement body) => Run(ctx, platform, "gdpr", async (actor, _, conn) =>
        {
            var username = await conn.ExecuteScalarAsync<string>("SELECT username FROM users WHERE id=@id", new { id });
            if (string.IsNullOrEmpty(username)) return Results.NotFound();
            if (!string.Equals(Str(body, "confirm"), username, StringComparison.Ordinal))
                return Results.BadRequest(new { error = "Type the username to confirm." });
            if (id == actor) return Results.Json(new { error = "you cannot delete yourself" }, statusCode: 403);
            var role = await conn.ExecuteScalarAsync<string>("SELECT role FROM users WHERE id=@id", new { id });
            if (role == "owner" && await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM users WHERE role='owner'") <= 1)
                return Results.BadRequest(new { error = "The last owner stays." });
            await platform.Audit(actor.ToString(), "admin.gdpr.delete", null, null, new { userId = id });
            await conn.ExecuteAsync("DELETE FROM users WHERE id=@id", new { id });
            return Results.Json(new { deleted = true });
        }));
    }

    static async Task<decimal[]> Daily(NpgsqlConnection conn, string sql)
    {
        var rows = (await conn.QueryAsync<(DateTime Day, decimal Value)>(sql)).ToDictionary(row => row.Day.Date, row => row.Value);
        var start = DateTime.UtcNow.Date.AddDays(-6);
        var values = new decimal[7];
        for (var i = 0; i < 7; i++)
        {
            values[i] = rows.TryGetValue(start.AddDays(i), out var value) ? value : 0;
        }
        return values;
    }

    static string StatusAction(string? status) => status == "banned" ? "ban" : "suspend";

    static string FlagAction(string key) => key is "maintenance_mode" ? "maintenance" : "flag";

    static string ToCamel(string key)
    {
        var parts = key.Split('_');
        return parts[0] + string.Concat(parts.Skip(1).Select(part => char.ToUpperInvariant(part[0]) + part[1..]));
    }

    static async Task<object> Maintenance(NpgsqlConnection conn)
    {
        var enabled = await Flag(conn, "maintenance_mode");
        var message = await conn.ExecuteScalarAsync<string>("SELECT value FROM platform_settings WHERE key='maintenance_message'") ?? "";
        return new { enabled, message };
    }

    static async Task<bool> Flag(NpgsqlConnection conn, string key) =>
        await conn.ExecuteScalarAsync<bool>("SELECT coalesce((SELECT enabled FROM feature_flags WHERE key=@key), false)", new { key });

    static async Task UpsertSetting(NpgsqlConnection conn, string key, string value) =>
        await conn.ExecuteAsync(
            """
            INSERT INTO platform_settings (key, value, updated_at) VALUES (@key, @value, now())
            ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()
            """, new { key, value });

    static async Task<NpgsqlConnection> Open(Platform platform) => await platform.Data.OpenConnectionAsync();

    static async Task<IResult> Run(HttpContext ctx, Platform platform, string action, Func<Guid, string, NpgsqlConnection, Task<IResult>> handle)
    {
        ctx.Request.Cookies.TryGetValue("teammates_session", out var token);
        var id = await platform.UserForSession(token);
        if (id == null) return Results.Unauthorized();
        await using var conn = await Open(platform);
        var role = await conn.ExecuteScalarAsync<string>("SELECT role FROM users WHERE id=@id AND status='active'", new { id });
        if (!Access.Allows(role, action)) return Results.Json(new { error = "forbidden" }, statusCode: 403);
        var enrolled = await conn.ExecuteScalarAsync<bool>("SELECT coalesce((SELECT enabled FROM admin_totp WHERE user_id=@id), false)", new { id });
        if (Access.BlocksUntilTotp(role, action, enrolled)) return Results.Json(new { error = "totp_required" }, statusCode: 403);
        return await handle(id.Value, role!, conn);
    }

    static string? Str(JsonElement body, string name) =>
        body.ValueKind == JsonValueKind.Object && body.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    static int? Int(JsonElement body, string name) =>
        body.ValueKind == JsonValueKind.Object && body.TryGetProperty(name, out var value) && value.TryGetInt32(out var number) ? number : null;

    static int? Optional(JsonElement body, string name)
    {
        if (body.ValueKind != JsonValueKind.Object || !body.TryGetProperty(name, out var value) || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return null;
        return value.TryGetInt32(out var number) ? number : -1;
    }

    static bool Bool(JsonElement body, string name) =>
        body.ValueKind == JsonValueKind.Object && body.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;

    static string Csv(string value) => "\"" + value.Replace("\"", "\"\"") + "\"";
}
