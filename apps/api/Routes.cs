using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Amazon.S3.Model;
using Dapper;
using Microsoft.Extensions.Logging;
using Npgsql;
using Teammates.Compute;

namespace Teammates.Api;

public static class Routes
{
    private static bool ValidAvatar(string shape, string color) =>
        (shape.Length == 0 || System.Text.RegularExpressions.Regex.IsMatch(shape, @"^blob(1[0-5]|[1-9])$")) &&
        (color.Length == 0 || System.Text.RegularExpressions.Regex.IsMatch(color, @"^#[0-9a-fA-F]{6}$"));

    public static void Map(WebApplication app, Platform platform, Runtime runtime)
    {
        app.MapGet("/health", async () =>
        {
            var postgres = false;
            try
            {
                await using var conn = await platform.Data.OpenConnectionAsync();
                postgres = await conn.ExecuteScalarAsync<int>("SELECT 1") == 1;
            }
            catch { /* health reports the dependency */ }
            return Results.Json(new { ok = postgres, llmProvider = platform.LlmProvider, postgres });
        });

        app.MapGet("/metrics", async (HttpContext ctx) =>
        {
            if (!await AllowedMetrics(ctx, platform)) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var calls = await conn.ExecuteScalarAsync<long>("SELECT count(*) FROM model_calls");
            var cost = await conn.ExecuteScalarAsync<decimal>("SELECT coalesce(sum(cost_usd),0) FROM model_calls");
            var latency = await conn.ExecuteScalarAsync<double>("SELECT coalesce(avg(latency_ms),0)::float8 FROM model_calls");
            var done = await conn.ExecuteScalarAsync<long>("SELECT count(*) FROM tasks WHERE status='completed'");
            var sum = Interlocked.Read(ref platform.HttpMicros) / 1_000_000.0;
            var count = Interlocked.Read(ref platform.HttpCount);
            var text = $"""
                # HELP teammates_http_request_duration_seconds Request latency
                # TYPE teammates_http_request_duration_seconds summary
                teammates_http_request_duration_seconds_sum {sum.ToString(System.Globalization.CultureInfo.InvariantCulture)}
                teammates_http_request_duration_seconds_count {count}
                # TYPE teammates_model_calls_total counter
                teammates_model_calls_total {calls}
                # TYPE teammates_model_cost_usd_total counter
                teammates_model_cost_usd_total {cost.ToString(System.Globalization.CultureInfo.InvariantCulture)}
                # TYPE teammates_model_latency_ms_avg gauge
                teammates_model_latency_ms_avg {latency.ToString(System.Globalization.CultureInfo.InvariantCulture)}
                # TYPE teammates_computer_memory_bytes gauge
                teammates_computer_memory_bytes {platform.ComputerMemory}
                # TYPE teammates_computer_chrome_processes gauge
                teammates_computer_chrome_processes {platform.ChromeProcesses}
                # TYPE teammates_tasks_completed_total counter
                teammates_tasks_completed_total {done}
                """;
            return Results.Text(text, "text/plain");
        });

        app.MapPost("/api/auth/login", async (HttpContext ctx, JsonElement body) =>
        {
            var ip = ClientAddress.From(ctx);
            if (platform.LoginBlocked(ip)) return Results.StatusCode(429);
            platform.NoteLoginAttempt(ip);
            var username = body.GetProperty("username").GetString() ?? "";
            var password = body.GetProperty("password").GetString() ?? "";
            await using var conn = await platform.Data.OpenConnectionAsync();
            var row = await conn.QuerySingleOrDefaultAsync<(Guid Id, string Hash, string Status)>("SELECT id, password_hash, coalesce(status, 'active') FROM users WHERE username=@username", new { username });
            if (row.Id == Guid.Empty || !Passwords.Verify(password, row.Hash ?? ""))
            {
                platform.NoteLoginFailure(ip);
                return Results.Json(new { error = "invalid credentials" }, statusCode: 401);
            }
            if (row.Status == "disabled") return Results.Json(new { error = "disabled" }, statusCode: 403);
            var token = await platform.CreateSession(row.Id);
            ctx.Response.Cookies.Append("teammates_session", token, Cookie(ctx));
            return Results.Json(new { username });
        });

        app.MapPost("/api/auth/logout", async (HttpContext ctx) =>
        {
            ctx.Response.Cookies.Delete("teammates_session");
            return Results.Json(new { ok = true });
        });

        app.MapGet("/api/auth/me", async (HttpContext ctx) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var me = await conn.QuerySingleAsync<(string Username, string Role, string Status, string DisplayName)>("SELECT username, role, status, display_name FROM users WHERE id=@id", new { id = user });
            return Results.Json(new { id = user, username = me.Username, role = me.Role, status = me.Status, displayName = me.DisplayName });
        });

        app.MapGet("/api/bots", async (HttpContext ctx) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync(
                """
                SELECT b.id, b.name, b.role, b.instructions, b.status, b.created_at, b.section, b.avatar, b.avatar_shape, b.avatar_color, b.model, b.notifications_enabled,
                       (EXISTS (SELECT 1 FROM approvals a WHERE a.bot_id=b.id AND a.status='pending')
                        OR EXISTS (SELECT 1 FROM tasks t WHERE t.bot_id=b.id AND t.status IN ('waiting_human','waiting_approval'))) AS attention
                FROM bots b WHERE b.owner_id=@id ORDER BY b.created_at
                """,
                new { id = user });
            return Results.Json(rows.Select(Platform.ToDict));
        });

        app.MapPost("/api/bots", async (HttpContext ctx, JsonElement body, CancellationToken ct) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var name = body.GetProperty("name").GetString() ?? "Teammate";
            var role = body.TryGetProperty("role", out var roleEl) ? roleEl.GetString() ?? "" : "";
            if (string.IsNullOrWhiteSpace(role)) role = "Teammate";
            var instructions = body.TryGetProperty("instructions", out var ins) ? ins.GetString() ?? "" : "";
            var avatarShape = body.TryGetProperty("avatarShape", out var shapeEl) ? shapeEl.GetString() ?? "" : "";
            var avatarColor = body.TryGetProperty("avatarColor", out var colorEl) ? colorEl.GetString() ?? "" : "";
            if (!ValidAvatar(shape: avatarShape, color: avatarColor)) return Results.BadRequest(new { error = "invalid avatar" });
            var id = Guid.NewGuid();
            var botToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(botToken))).ToLowerInvariant();
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var quota = await conn.QuerySingleOrDefaultAsync<(int MaxBots, int Cpu, long Memory, long Disk)>("SELECT max_bots, cpu_millis, memory_bytes, disk_bytes FROM user_quotas WHERE user_id=@id", new { id = user });
            var maxBots = quota.MaxBots == 0 ? 8 : quota.MaxBots;
            var existingBots = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM bots WHERE owner_id=@id", new { id = user });
            if (existingBots >= maxBots) return Results.Json(new { error = "quota", reason = "max_bots" }, statusCode: 403);
            var shared = await conn.QuerySingleOrDefaultAsync<Guid?>("SELECT computer_id FROM user_computers WHERE user_id=@id", new { id = user });
            await conn.ExecuteAsync("INSERT INTO bots (id, owner_id, name, role, instructions, token_hash, avatar_shape, avatar_color) VALUES (@id, @owner, @name, @role, @instructions, @hash, @avatarShape, @avatarColor)", new { id, owner = user, name, role, instructions, hash, avatarShape, avatarColor });
            var conversation = await conn.ExecuteScalarAsync<Guid>("INSERT INTO conversations (bot_id, title) VALUES (@id, 'Desk') RETURNING id", new { id });
            await conn.ExecuteAsync("INSERT INTO control_locks (bot_id, holder, epoch) VALUES (@id, 'agent', 1)", new { id });
            try
            {
                if (shared == null)
                {
            var cpu = quota.Cpu == 0 ? 400u : (uint)quota.Cpu;
            var memory = quota.Memory <= 0 ? 640UL * 1024 * 1024 : (ulong)quota.Memory;
            var disk = (ulong)(quota.Disk <= 0 ? (long)DiskQuota.DefaultBytes : quota.Disk);
                    var computerId = new ComputerId(id.ToString());
                    await platform.Compute.CreateComputerAsync(new CreateComputerSpec(computerId, "local", user.Value.ToString(), Environment.GetEnvironmentVariable("COMPUTE_IMAGE") ?? "teammates-computer:dev", IsolationClass.Docker, new ResourceLimits(cpu, memory, disk, 256), "", new Dictionary<string, string> { ["name"] = name }), IdempotencyKey.Require("create-" + id.ToString("n")), ct);
                    await conn.ExecuteAsync(
                        "INSERT INTO user_computers (user_id, computer_id, desktop_bot_id, status) VALUES (@user, @computer, @desktop, 'running') ON CONFLICT (user_id) DO NOTHING",
                        new { user, computer = id, desktop = id });
                    var deadline = DateTimeOffset.UtcNow.AddSeconds(45);
                    while (DateTimeOffset.UtcNow < deadline && !ct.IsCancellationRequested)
                    {
                        var status = await platform.Compute.GetStatusAsync(computerId, ct);
                        if (status.Components.Any(component => component.Name == "chrome" && component.Healthy)) break;
                        await Task.Delay(1000, ct);
                    }
                }
            }
            catch (ComputeException ex) when (ex.IsIsolationMissing)
            {
                ctx.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("Compute").LogError("computer isolation alert: computer was not created");
                return Results.Json(new
                {
                    error = ComputeException.IsolationMissingMessage,
                    message = "Computer isolation rules are missing and could not be reinstalled. No computer was started."
                }, statusCode: 503);
            }
            catch (ComputeException ex)
            {
                ctx.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("Compute").LogWarning("computer create failed {Code}: {Message}", ex.Code, ex.Message);
                return Results.Json(new { error = ex.Code.ToString(), id, conversationId = conversation }, statusCode: 503);
            }
            return Results.Json(new { id, name, role, instructions, conversationId = conversation, avatarShape, avatarColor, botToken });
        });

        app.MapGet("/api/bots/{id:guid}/workspace", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var bot = Platform.ToDict(await conn.QuerySingleAsync("SELECT id, name, role, instructions, status, model, avatar, avatar_shape, avatar_color, section, notifications_enabled FROM bots WHERE id=@id", new { id }));
            var conversationId = await conn.ExecuteScalarAsync<Guid>("SELECT id FROM conversations WHERE bot_id=@id ORDER BY created_at LIMIT 1", new { id });
            var tasks = (await conn.QueryAsync("SELECT id, title, instruction, status, kind, model_calls, waiting_reason, error, error_code, result::text AS result FROM tasks WHERE bot_id=@id ORDER BY created_at DESC LIMIT 50", new { id })).Select(Platform.ToDict);
            var messages = (await conn.QueryAsync("SELECT id, role, content, created_at FROM messages WHERE conversation_id=@conversation ORDER BY created_at LIMIT 200", new { conversation = conversationId })).Select(Platform.ToDict).ToList();
            var reactionRows = (await conn.QueryAsync("SELECT r.id, r.message_id, r.actor_type::text AS actor_type, r.actor_id, r.emoji, r.created_at FROM message_reactions r JOIN messages m ON m.id=r.message_id WHERE m.conversation_id=@conversation ORDER BY r.created_at", new { conversation = conversationId })).Select(Platform.ToDict).ToList();
            foreach (var message in messages)
            {
                var idText = message["id"]?.ToString();
                message["reactions"] = reactionRows.Where(row => row["messageId"]?.ToString() == idText).Select(row => new { id = row["id"], actorType = row["actorType"], actorId = row["actorId"], emoji = row["emoji"], createdAt = row["createdAt"] }).ToList();
            }
            var approvals = (await conn.QueryAsync("SELECT id, action, target, reason, status, risk_class, summary FROM approvals WHERE bot_id=@id AND status='pending' ORDER BY created_at", new { id })).Select(Platform.ToDict);
            var pages = (await conn.QueryAsync("SELECT target_id, url, title FROM browser_pages WHERE bot_id=@id ORDER BY updated_at", new { id })).Select(Platform.ToDict);
            var holder = await conn.ExecuteScalarAsync<string>("SELECT holder FROM control_locks WHERE bot_id=@id", new { id }) ?? "agent";
            var connected = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM secrets WHERE owner_user_id=@owner AND provider='openrouter' AND name='default' AND revoked_at IS NULL", new { owner = user }) > 0;
            var secretRequests = (await conn.QueryAsync("SELECT id, suggested_ref, type, reason, status FROM secret_requests WHERE bot_id=@id AND status='pending' ORDER BY created_at", new { id })).Select(Platform.ToDict);
            var loginRequests = (await conn.QueryAsync("SELECT id, domain, url, fields::text AS fields, status, expires_at FROM login_prompts WHERE bot_id=@id AND status='pending' AND expires_at > now() ORDER BY created_at", new { id })).Select(row =>
            {
                var dict = Platform.ToDict((object)row);
                if (dict.TryGetValue("fields", out var raw) && raw is string fieldJson && fieldJson.Length > 0)
                    dict["fields"] = JsonSerializer.Deserialize<JsonElement>(fieldJson);
                return dict;
            });
            return Results.Json(new { bot, conversationId, tasks, messages, approvals, pages, holder, secretRequests, loginRequests, llmProvider = platform.LlmProvider, openrouterConnected = connected });
        });

        app.MapPost("/api/conversations/{id:guid}/messages", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var botId = await conn.ExecuteScalarAsync<Guid?>("SELECT c.bot_id FROM conversations c JOIN bots b ON b.id=c.bot_id WHERE c.id=@id AND b.owner_id=@owner", new { id, owner = user });
            if (botId == null) return Results.NotFound();
            var content = body.GetProperty("content").GetString() ?? "";
            if (Dlp.HasStrict(content))
                return Results.Json(new { error = "Blocked by the data policy. Card numbers, IDs, and secrets are not sent." }, statusCode: 422);
            var asTask = body.TryGetProperty("asTask", out var flag) && flag.ValueKind == JsonValueKind.True;
            var messageId = await conn.ExecuteScalarAsync<Guid>("INSERT INTO messages (conversation_id, role, content) VALUES (@id, 'user', @content) RETURNING id", new { id, content });
            var kind = asTask ? "work" : "chat";
            var priority = asTask ? 0 : 10;
            var taskId = await conn.ExecuteScalarAsync<Guid>(
                "INSERT INTO tasks (bot_id, conversation_id, title, instruction, kind, priority, status, source_message_id) VALUES (@bot, @conversation, @title, @instruction, @kind, @priority, 'queued', @message) RETURNING id",
                new { bot = botId, conversation = id, title = content.Length > 80 ? content[..80] : content, instruction = content, kind, priority, message = messageId });
            await platform.Publish(new { type = "task", taskId });
            platform.Tasks.Pulse();
            return Results.Json(new { messageId, taskId, status = "queued" });
        });

        app.MapPost("/api/messages/{id:guid}/answer", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            return await runtime.AnswerQuestion(user.Value, id, body);
        });
        app.MapPost("/api/messages/{id:guid}/reactions", (HttpContext ctx, Guid id, JsonElement body) => Reactions.Post(ctx, platform, id, body));
        app.MapDelete("/api/messages/{id:guid}/reactions", (HttpContext ctx, Guid id) => Reactions.Delete(ctx, platform, id));

        app.MapGet("/api/tasks/{id:guid}/log", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            if (!await conn.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE t.id=@id AND b.owner_id=@owner)", new { id, owner = user })) return Results.NotFound();
            return Results.Json((await conn.QueryAsync("SELECT id,type,detail,created_at FROM task_run_events WHERE task_id=@id ORDER BY id", new { id })).Select(Platform.ToDict));
        });

        app.MapGet("/api/system/llm-status", async (HttpContext ctx) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var secretId = await conn.ExecuteScalarAsync<Guid?>("SELECT id FROM secrets WHERE owner_user_id=@owner AND provider='openrouter' AND name='default' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())", new { owner = user });
            return Results.Json(new { hasKey = secretId != null, provider = platform.LlmProvider, model = platform.ModelName, secretId });
        });

        app.MapGet("/api/bots/{id:guid}/tasks", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null || !await Owns(platform, user.Value, id)) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync("SELECT id, title, instruction, status, kind, model_calls, waiting_reason, error, error_code, result::text AS result, created_at FROM tasks WHERE bot_id=@id ORDER BY created_at DESC", new { id });
            return Results.Json(rows.Select(Platform.ToDict));
        });

        app.MapPost("/api/tasks/{id:guid}/cancel", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var n = await conn.ExecuteAsync("UPDATE tasks SET status='cancelled', updated_at=now(), finished_at=now(), lease_owner=NULL FROM bots b WHERE tasks.id=@id AND tasks.bot_id=b.id AND b.owner_id=@owner", new { id, owner = user });
            return n == 0 ? Results.NotFound() : Results.Json(new { ok = true });
        });

        app.MapPost("/api/tasks/{id:guid}/attention/resolve", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var n = await conn.ExecuteAsync("UPDATE tasks SET status='queued', waiting_reason=NULL, lease_owner=NULL, lease_until=NULL, lease_epoch=lease_epoch+1, updated_at=now() FROM bots b WHERE tasks.id=@id AND tasks.bot_id=b.id AND b.owner_id=@owner AND tasks.status='waiting_human'", new { id, owner = user });
            if (n > 0) platform.Tasks.Pulse();
            return Results.Json(new { ok = n > 0 });
        });

        app.MapPost("/api/approvals/{id:guid}/decide", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var decision = body.GetProperty("decision").GetString();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var taskId = await conn.ExecuteScalarAsync<Guid?>("SELECT a.task_id FROM approvals a JOIN bots b ON b.id=a.bot_id WHERE a.id=@id AND b.owner_id=@owner AND a.status='pending'", new { id, owner = user });
            if (taskId == null) return Results.NotFound();
            if (decision is "allow_once" or "allow_domain")
            {
                if (decision == "allow_domain")
                {
                    var row = await conn.QuerySingleOrDefaultAsync<(string Target, string RiskClass)>("SELECT target, risk_class FROM approvals WHERE id=@id", new { id });
                    var host = CredentialGrants.Host(row.Target);
                    if (row.RiskClass != ActionClasses.CredentialUse || host.Length == 0 || CredentialSites.IsLookAlike(host))
                        return Results.Json(new { error = "domain_grant_unavailable" }, statusCode: 400);
                    await conn.ExecuteAsync(
                        "INSERT INTO credential_domain_grants (owner_id, domain) VALUES (@owner, @domain) ON CONFLICT DO NOTHING",
                        new { owner = user, domain = host });
                    await platform.Audit(user.Value.ToString(), "credential.domain_grant", null, taskId, new { domain = host });
                }
                await conn.ExecuteAsync("UPDATE approvals SET status='approved', decided_at=now() WHERE id=@id", new { id });
                await conn.ExecuteAsync("UPDATE tasks SET status='queued', waiting_reason=NULL, lease_owner=NULL, lease_until=NULL, lease_epoch=lease_epoch+1, updated_at=now() WHERE id=@id AND status='waiting_approval'", new { id = taskId });
                platform.Tasks.Pulse();
            }
            else if (decision == "deny")
            {
                await conn.ExecuteAsync("UPDATE approvals SET status='denied', decided_at=now() WHERE id=@id", new { id });
                await conn.ExecuteAsync("UPDATE tasks SET status='failed', error_code='denied', error='The requested action was denied.', finished_at=now(), updated_at=now() WHERE id=@id", new { id = taskId });
                await Reliability.Event(platform, taskId.Value, "error", new { error_code = "denied", error = "The requested action was denied." });
            }
            else
            {
                return Results.BadRequest(new { error = "decision required" });
            }
            return Results.Json(new { ok = true });
        });

        app.MapPost("/api/bots/{id:guid}/computer/view-token", (HttpContext ctx, Guid id, CancellationToken ct) => Desktop(ctx, platform, id, false, ct));
        app.MapPost("/api/bots/{id:guid}/computer/take-control", (HttpContext ctx, Guid id, CancellationToken ct) => Desktop(ctx, platform, id, true, ct));
        app.MapPost("/api/bots/{id:guid}/computer/hand-back", async (HttpContext ctx, Guid id, CancellationToken ct) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null || !await Owns(platform, user.Value, id)) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var epoch = await conn.ExecuteScalarAsync<long>("UPDATE control_locks SET holder='agent', epoch=epoch+1, updated_at=now() WHERE bot_id=@id RETURNING epoch", new { id });
            var placement = await platform.PlacementForBot(id, ct);
            await platform.Compute.SetHolderAsync(placement.Computer, "agent", (ulong)epoch, ct);
            await conn.ExecuteAsync("UPDATE tasks SET status='queued', waiting_reason=NULL, lease_owner=NULL, lease_until=NULL, lease_epoch=lease_epoch+1, updated_at=now() WHERE bot_id=@id AND status='waiting_human' AND waiting_reason IN ('takeover', 'captcha_or_mfa')", new { id });
            platform.Tasks.Pulse();
            return Results.Json(new { ok = true, epoch });
        });

        app.MapPost("/api/bots/{id:guid}/computer/human-input", async (HttpContext ctx, Guid id, JsonElement body, CancellationToken ct) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null || !await Owns(platform, user.Value, id)) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var holder = await conn.ExecuteScalarAsync<string>("SELECT holder FROM control_locks WHERE bot_id=@id", new { id });
            if (holder != "human") return Results.Json(new { error = "human control is not held" }, statusCode: 403);
            var selector = body.TryGetProperty("selector", out var sel) ? sel.GetString() : "#human-check";
            var target = body.TryGetProperty("targetId", out var tid) ? tid.GetString() : "";
            var placement = await platform.PlacementForBot(id, ct);
            var json = await platform.Compute.ControlAsync(placement.Computer, $"/desktops/{placement.Desktop}/human-input", JsonSerializer.Serialize(new { selector, targetId = target }), ct);
            return Results.Text(json, "application/json");
        });

        app.MapGet("/api/bots/{id:guid}/files", async (HttpContext ctx, Guid id, string? path, CancellationToken ct) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null || !await Owns(platform, user.Value, id)) return Results.Unauthorized();
            var folder = string.IsNullOrWhiteSpace(path) ? "/workspace" : path;
            var placement = await platform.PlacementForBot(id, ct);
            var (code, stdout, _) = await runtime.Run(placement.Computer, id, ["python3", "-c", BotFs.Script("list_dir(sys.argv[1])"), folder], null, ct);
            var entries = code == 0 && !string.IsNullOrWhiteSpace(stdout) ? stdout.Trim() : "[]";
            return Results.Text("{\"path\":" + JsonSerializer.Serialize(folder) + ",\"entries\":" + entries + "}", "application/json");
        });

        app.MapPut("/api/bots/{id:guid}/files", async (HttpContext ctx, Guid id, CancellationToken ct) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null || !await Owns(platform, user.Value, id)) return Results.Unauthorized();
            var path = ctx.Request.Headers["x-path"].ToString();
            if (string.IsNullOrWhiteSpace(path)) path = "/workspace/upload.bin";
            using var memory = new MemoryStream();
            await ctx.Request.Body.CopyToAsync(memory, ct);
            var b64 = Convert.ToBase64String(memory.ToArray());
            var placement = await platform.PlacementForBot(id, ct);
            var (code, _, _) = await runtime.Run(placement.Computer, id, ["python3", "-c", BotFs.Script("write_b64(sys.argv[1], sys.argv[2])"), path, b64], null, ct);
            if (code != 0) return Results.Json(new { error = code == 4 ? "path_escapes_workspace" : "write_failed" }, statusCode: code == 4 ? 400 : 500);
            return Results.Json(new { ok = true, path, size = memory.Length });
        });

        app.MapGet("/api/bots/{id:guid}/files/raw", async (HttpContext ctx, Guid id, string path, CancellationToken ct) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null || !await Owns(platform, user.Value, id)) return Results.Unauthorized();
            var placement = await platform.PlacementForBot(id, ct);
            var (code, stdout, _) = await runtime.Run(placement.Computer, id, ["python3", "-c", BotFs.Script("read_b64(sys.argv[1])"), path], null, ct);
            if (code != 0 || string.IsNullOrWhiteSpace(stdout)) return Results.NotFound();
            var bytes = Convert.FromBase64String(stdout.Trim());
            return Results.File(bytes, "application/octet-stream", Path.GetFileName(path));
        });

        app.MapGet("/api/bots/{id:guid}/memories", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null || !await Owns(platform, user.Value, id)) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync("SELECT id, content, source, created_at FROM memories WHERE bot_id=@id ORDER BY created_at DESC", new { id });
            return Results.Json(rows.Select(Platform.ToDict));
        });

        app.MapPost("/api/bots/{id:guid}/memories", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null || !await Owns(platform, user.Value, id)) return Results.Unauthorized();
            var content = body.GetProperty("content").GetString() ?? "";
            if (Dlp.HasStrict(content)) return Results.BadRequest(new { error = "credential shaped" });
            await using var conn = await platform.Data.OpenConnectionAsync();
            var memoryId = await conn.ExecuteScalarAsync<Guid>("INSERT INTO memories (bot_id, content, source, embedding) VALUES (@id, @content, 'user', @emb::vector) RETURNING id", new { id, content, emb = Embedder.VectorLiteral(content) });
            return Results.Json(new { id = memoryId });
        });

        app.MapPost("/api/bots/{id:guid}/skills/from-task", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null || !await Owns(platform, user.Value, id)) return Results.Unauthorized();
            var taskId = body.GetProperty("taskId").GetGuid();
            var name = body.GetProperty("name").GetString() ?? "Skill";
            await using var conn = await platform.Data.OpenConnectionAsync();
            var steps = (await conn.QueryAsync("SELECT tool, args::text AS args FROM task_steps WHERE task_id=@task AND ok ORDER BY seq", new { task = taskId })).ToList();
            var vault = await conn.ExecuteScalarAsync<string>("SELECT vault_refs::text FROM login_prompts WHERE task_id=@task AND vault_refs <> '{}'::jsonb ORDER BY created_at DESC LIMIT 1", new { task = taskId });
            var definition = JsonSerializer.Serialize(new
            {
                steps = steps.Select(row =>
                {
                    var tool = (string)((IDictionary<string, object>)row)["tool"];
                    var raw = (string)((IDictionary<string, object>)row)["args"];
                    using var parsed = JsonDocument.Parse(string.IsNullOrWhiteSpace(raw) ? "{}" : raw);
                    if (tool == "request_login" && !string.IsNullOrWhiteSpace(vault))
                    {
                        using var refs = JsonDocument.Parse(vault);
                        using var stream = new MemoryStream();
                        using (var writer = new Utf8JsonWriter(stream))
                        {
                            writer.WriteStartObject();
                            foreach (var prop in parsed.RootElement.EnumerateObject()) prop.WriteTo(writer);
                            writer.WritePropertyName("vaultRefs");
                            refs.RootElement.WriteTo(writer);
                            writer.WriteEndObject();
                        }
                        using var merged = JsonDocument.Parse(stream.ToArray());
                        return new { tool, args = merged.RootElement.Clone() };
                    }
                    return new { tool, args = parsed.RootElement.Clone() };
                })
            });
            var skillId = await conn.ExecuteScalarAsync<Guid>("INSERT INTO skills (bot_id, name, definition, deterministic) VALUES (@id, @name, @definition::jsonb, true) RETURNING id", new { id, name, definition });
            return Results.Json(new { id = skillId });
        });

        app.MapGet("/api/bots/{id:guid}/skills", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null || !await Owns(platform, user.Value, id)) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync("SELECT id, name, description, deterministic FROM skills WHERE bot_id=@id ORDER BY created_at", new { id });
            return Results.Json(rows.Select(Platform.ToDict));
        });

        app.MapPost("/api/skills/{id:guid}/replay", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var skill = await conn.QuerySingleOrDefaultAsync<(Guid BotId, string Name)>("SELECT s.bot_id, s.name FROM skills s JOIN bots b ON b.id=s.bot_id WHERE s.id=@id AND b.owner_id=@owner", new { id, owner = user });
            if (skill.BotId == Guid.Empty) return Results.NotFound();
            var conversation = await conn.ExecuteScalarAsync<Guid>("SELECT id FROM conversations WHERE bot_id=@id ORDER BY created_at LIMIT 1", new { id = skill.BotId });
            var taskId = await conn.ExecuteScalarAsync<Guid>("INSERT INTO tasks (bot_id, conversation_id, title, instruction, kind, skill_id, status) VALUES (@bot, @conversation, @title, @instruction, 'work', @skill, 'queued') RETURNING id", new { bot = skill.BotId, conversation, title = "Replay " + skill.Name, instruction = "Replay skill " + skill.Name, skill = id });
            platform.Tasks.Pulse();
            return Results.Json(new { taskId, status = "queued" });
        });

        app.MapGet("/api/bots/{id:guid}/routines", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null || !await Owns(platform, user.Value, id)) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync("SELECT id, name, cron, instruction, next_run_at, enabled, watch_kind, watch_ref FROM routines WHERE bot_id=@id ORDER BY created_at", new { id });
            return Results.Json(rows.Select(Platform.ToDict));
        });

        app.MapPost("/api/bots/{id:guid}/routines", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null || !await Owns(platform, user.Value, id)) return Results.Unauthorized();
            var name = body.GetProperty("name").GetString() ?? "Routine";
            var cron = body.GetProperty("cron").GetString() ?? "0 * * * *";
            var instruction = body.GetProperty("instruction").GetString() ?? "";
            var watchKind = body.TryGetProperty("watchKind", out var watchKindEl) && watchKindEl.ValueKind == JsonValueKind.String ? watchKindEl.GetString() ?? "" : "";
            var watchRef = body.TryGetProperty("watchRef", out var watchRefEl) && watchRefEl.ValueKind == JsonValueKind.String ? watchRefEl.GetString() ?? "" : "";
            if (watchKind is not ("" or "http" or "memory")) watchKind = "";
            if (watchRef.Length > 500) watchRef = watchRef[..500];
            var next = Cron.Next(cron, DateTimeOffset.UtcNow, TimeZoneInfo.Utc);
            await using var conn = await platform.Data.OpenConnectionAsync();
            var routineId = await conn.ExecuteScalarAsync<Guid>("INSERT INTO routines (bot_id, name, cron, instruction, next_run_at, watch_kind, watch_ref) VALUES (@id, @name, @cron, @instruction, @next, @watchKind, @watchRef) RETURNING id", new { id, name, cron, instruction, next, watchKind, watchRef });
            return Results.Json(new { id = routineId, nextRunAt = next });
        });

        app.MapPatch("/api/routines/{id:guid}", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            if (body.TryGetProperty("nextRunAt", out var next))
                await conn.ExecuteAsync("UPDATE routines SET next_run_at=@next FROM bots b WHERE routines.id=@id AND routines.bot_id=b.id AND b.owner_id=@owner", new { id, owner = user, next = next.GetDateTimeOffset() });
            return Results.Json(new { ok = true });
        });

        app.MapGet("/api/bots/{id:guid}/artifacts", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null || !await Owns(platform, user.Value, id)) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync("SELECT id, name, mime, size_bytes, created_at FROM artifacts WHERE bot_id=@id ORDER BY created_at DESC", new { id });
            return Results.Json(rows.Select(Platform.ToDict));
        });

        app.MapGet("/api/artifacts/{id:guid}/download", async (HttpContext ctx, Guid id, CancellationToken ct) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var row = await conn.QuerySingleOrDefaultAsync<(string Name, string Key)>("SELECT a.name, a.object_key FROM artifacts a JOIN bots b ON b.id=a.bot_id WHERE a.id=@id AND b.owner_id=@owner", new { id, owner = user });
            if (string.IsNullOrEmpty(row.Key)) return Results.NotFound();
            using var obj = await platform.S3.GetObjectAsync(platform.Bucket, row.Key, ct);
            using var memory = new MemoryStream();
            await obj.ResponseStream.CopyToAsync(memory, ct);
            return Results.File(memory.ToArray(), "application/octet-stream", row.Name);
        });

        app.MapGet("/api/usage", async (HttpContext ctx) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var calls = await conn.ExecuteScalarAsync<long>("SELECT count(*) FROM model_calls WHERE owner_id=@id", new { id = user });
            var cost = await conn.ExecuteScalarAsync<decimal>("SELECT coalesce(sum(cost_usd),0) FROM model_calls WHERE owner_id=@id", new { id = user });
            var latency = await conn.ExecuteScalarAsync<double>("SELECT coalesce(avg(latency_ms),0)::float8 FROM model_calls WHERE owner_id=@id", new { id = user });
            return Results.Json(new { modelCalls = calls, costUsd = cost, latencyMs = latency, llmProvider = platform.LlmProvider, computerMemoryBytes = platform.ComputerMemory, chromeProcesses = platform.ChromeProcesses });
        });

        app.MapGet("/api/model-requests", async (HttpContext ctx) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync("SELECT id, model, prompt_json::text AS prompt, created_at FROM model_requests WHERE owner_id=@id ORDER BY created_at DESC LIMIT 30", new { id = user });
            return Results.Json(rows.Select(Platform.ToDict));
        });

        MapSecrets(app, platform);
        PluginModel.Map(app, platform);
        PluginCatalog.Map(app, platform);
        Beta.Map(app, platform);
        MapInternal(app, platform, runtime);

        app.Map("/vnc/websockify", async (HttpContext ctx) =>
        {
            if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = 400; return; }
            var token = ctx.Request.Query["token"].ToString();
            DesktopEndpoint endpoint;
            try { endpoint = platform.Compute.RequireSession(token, DateTimeOffset.UtcNow); }
            catch (ComputeException) { ctx.Response.StatusCode = 401; return; }
            await platform.Compute.EnsureAwakeAsync(endpoint.ComputerId, ctx.RequestAborted);
            platform.Compute.NoteViewer(endpoint.ComputerId);
            using var socket = await ctx.WebSockets.AcceptWebSocketAsync();
            using var tcp = new System.Net.Sockets.TcpClient();
            await tcp.ConnectAsync(endpoint.Host, endpoint.Port);
            await using var stream = tcp.GetStream();
            var toTcp = Task.Run(async () =>
            {
                var buffer = new byte[8192];
                while (socket.State == WebSocketState.Open)
                {
                    var result = await socket.ReceiveAsync(buffer, ctx.RequestAborted);
                    if (result.MessageType == WebSocketMessageType.Close) break;
                    await stream.WriteAsync(buffer.AsMemory(0, result.Count), ctx.RequestAborted);
                }
            });
            var toWs = Task.Run(async () =>
            {
                var buffer = new byte[8192];
                while (socket.State == WebSocketState.Open)
                {
                    var read = await stream.ReadAsync(buffer, ctx.RequestAborted);
                    if (read <= 0) break;
                    await socket.SendAsync(buffer.AsMemory(0, read), WebSocketMessageType.Binary, true, ctx.RequestAborted);
                }
            });
            await Task.WhenAny(toTcp, toWs);
            // Finish the RFB connection while x11vnc is still reading, then stop the
            // viewer, and only then complete the websocket close. The browser waits
            // on that close before it opens another socket, so a pane toggle cannot
            // leave a CLOSE_WAIT backlog behind a process that ignores SIGTERM.
            try { tcp.Close(); } catch { /* already closed */ }
            try { await Task.WhenAll(toTcp, toWs).WaitAsync(TimeSpan.FromSeconds(2)); } catch { /* copy loops end once the sockets close */ }
            try { await platform.Compute.ReleaseViewerAsync(token, CancellationToken.None); } catch { /* the view server stops on its own */ }
            try { await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None); } catch { /* already closed */ }
        });

        app.MapGet("/api/events", async (HttpContext ctx) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) { ctx.Response.StatusCode = 401; return; }
            ctx.Response.Headers.ContentType = "text/event-stream";
            ctx.Response.Headers.CacheControl = "no-cache";
            ctx.Response.Headers["X-Accel-Buffering"] = "no";
            long? resume = null;
            if (ctx.Request.Headers.TryGetValue("Last-Event-ID", out var lastHeader) && long.TryParse(lastHeader.ToString(), out var lastId) && lastId > 0)
                resume = lastId;
            var id = Guid.NewGuid();
            var channel = System.Threading.Channels.Channel.CreateUnbounded<string>();
            platform.Sinks[id] = channel;
            try
            {
                // Flush a comment immediately so proxies and clients know the
                // stream is open before the first real event.
                await ctx.Response.WriteAsync(": connected\n\n", ctx.RequestAborted);
                await ctx.Response.Body.FlushAsync(ctx.RequestAborted);
                var seen = resume ?? 0L;
                if (resume != null)
                {
                    foreach (var frame in platform.Events.After(resume.Value))
                    {
                        await ctx.Response.WriteAsync(frame.Format(), ctx.RequestAborted);
                        seen = frame.Id;
                    }
                    await ctx.Response.Body.FlushAsync(ctx.RequestAborted);
                }
                await foreach (var message in channel.Reader.ReadAllAsync(ctx.RequestAborted))
                {
                    if (SseEventId(message) is long eventId && eventId <= seen) continue;
                    if (SseEventId(message) is long written) seen = written;
                    await ctx.Response.WriteAsync(message, ctx.RequestAborted);
                    await ctx.Response.Body.FlushAsync(ctx.RequestAborted);
                }
            }
            finally { platform.Sinks.TryRemove(id, out _); }
        });
    }

    private static void MapSecrets(WebApplication app, Platform platform)
    {
        app.MapGet("/api/secrets", async (HttpContext ctx) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync("SELECT id, name, provider, type, masked_suffix, validation_status, last_used_at, revoked_at FROM secrets WHERE owner_user_id=@id ORDER BY created_at", new { id = user });
            return Results.Json(rows.Select(row =>
            {
                var dict = Platform.ToDict(row);
                dict["ref"] = "secret://" + dict["provider"] + "/" + dict["name"];
                return dict;
            }));
        });

        app.MapPost("/api/secrets/test", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var value = body.GetProperty("value").GetString() ?? "";
            var probe = await platform.ProbeOpenRouter(value);
            return Results.Json(new { ok = probe.Ok, limitRemaining = probe.Limit });
        });

        app.MapPost("/api/secrets", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var provider = body.TryGetProperty("namespace", out var ns) ? ns.GetString() ?? "" : body.GetProperty("provider").GetString() ?? "";
            var name = body.GetProperty("name").GetString() ?? "";
            var type = PluginModel.NormalizeSecretType(body.GetProperty("type").GetString());
            var value = body.GetProperty("value").GetString() ?? "";
            if (!SecretRef.TryParse($"secret://{provider}/{name}", out _, out _))
                return Results.BadRequest(new { error = "invalid reference" });
            var tools = ReadStrings(body, "allowedTools");
            var domains = ReadStrings(body, "allowedDomains");
            if (provider == "openrouter")
            {
                name = "default";
                type = "API_KEY";
                tools = ["model_gateway"];
                var probe = await platform.ProbeOpenRouter(value);
                if (!probe.Ok) return Results.BadRequest(new { error = "invalid key" });
            }
            if (type == "PASSWORD")
            {
                if (domains.Length == 0) return Results.BadRequest(new { error = "allowed domains are required" });
                tools = ["browser.type_secret"];
            }
            DateTimeOffset? expires = null;
            if (body.TryGetProperty("expiresAt", out var expiresEl) && expiresEl.ValueKind == JsonValueKind.String && DateTimeOffset.TryParse(expiresEl.GetString(), out var parsedExpires))
                expires = parsedExpires;
            var grantedBots = ReadGuids(body, "allowedBotIds");
            await using var quotaConn = await platform.Data.OpenConnectionAsync();
            var maxSecrets = await quotaConn.ExecuteScalarAsync<int?>("SELECT max_secrets FROM user_quotas WHERE user_id=@id", new { id = user });
            var held = await quotaConn.ExecuteScalarAsync<int>("SELECT count(*) FROM secrets WHERE owner_user_id=@id AND revoked_at IS NULL", new { id = user });
            if (held >= (maxSecrets ?? 40)) return Results.Json(new { error = "quota", reason = "max_secrets" }, statusCode: 403);
            Guid id;
            try
            {
                id = await platform.InsertSecret(user.Value, provider, name, type, value, body.TryGetProperty("description", out var desc) ? desc.GetString() ?? "" : "", tools, domains, expires, provider == "openrouter" ? "valid" : "unknown", grantedBots);
            }
            catch (PostgresException ex) when (ex.SqlState == "23505")
            {
                await using var existing = await platform.Data.OpenConnectionAsync();
                id = await existing.ExecuteScalarAsync<Guid>("SELECT id FROM secrets WHERE owner_user_id=@owner AND provider=@provider AND name=@name AND scope='USER'", new { owner = user, provider, name });
            }
            if (provider == "openrouter") await Reliability.ResumeKeyWaiters(platform, user.Value);
            var meta = await platform.SecretMeta(user.Value, id);
            return Results.Json(meta);
        });

        app.MapGet("/api/secrets/{id:guid}", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var meta = await platform.SecretMeta(user.Value, id);
            return meta == null ? Results.NotFound() : Results.Json(meta);
        });

        app.MapPost("/api/secrets/{id:guid}/test", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var row = await conn.QuerySingleOrDefaultAsync<(string Provider, string Name)>("SELECT provider, name FROM secrets WHERE id=@id AND owner_user_id=@owner", new { id, owner = user });
            if (string.IsNullOrEmpty(row.Name)) return Results.NotFound();
            var resolved = await platform.ResolveDetailed(user.Value, $"secret://{row.Provider}/{row.Name}", row.Provider == "openrouter" ? "model_gateway" : "secret.test", null, null, null, "owner");
            if (resolved.Value == null) return Results.Json(new { ok = false, reason = resolved.Deny ?? "denied" });
            var value = System.Text.Encoding.UTF8.GetString(resolved.Value);
            System.Security.Cryptography.CryptographicOperations.ZeroMemory(resolved.Value);
            var probe = row.Provider == "openrouter" ? await platform.ProbeOpenRouter(value) : (Ok: true, Limit: (int?)null, Error: (string?)null);
            value = "";
            await platform.SecretEvent(id, "secret.tested", user.Value.ToString(), null, null, "secret.test", null, probe.Ok ? "allow" : "deny", probe.Error);
            return Results.Json(new { ok = probe.Ok, limitRemaining = probe.Limit });
        });

        app.MapPost("/api/secrets/{id:guid}/rotate", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var value = body.GetProperty("value").GetString() ?? "";
            await using var conn = await platform.Data.OpenConnectionAsync();
            var row = await conn.QuerySingleOrDefaultAsync<(string Type, string Provider, string Name)>("SELECT type, provider, name FROM secrets WHERE id=@id AND owner_user_id=@owner AND revoked_at IS NULL", new { id, owner = user });
            if (string.IsNullOrEmpty(row.Type)) return Results.NotFound();
            var plain = System.Text.Encoding.UTF8.GetBytes(value);
            var (cipher, nonce) = KeyEncryption.Encrypt(platform.MasterKey, id, user.Value, row.Type, KeyEncryption.KeyVersion, plain);
            System.Security.Cryptography.CryptographicOperations.ZeroMemory(plain);
            await conn.ExecuteAsync("UPDATE secrets SET ciphertext=@cipher, nonce=@nonce, key_version=@version, masked_suffix=@mask, rotated_at=now(), updated_at=now(), validation_status='unknown' WHERE id=@id", new { id, cipher, nonce, version = KeyEncryption.KeyVersion, mask = Platform.Mask(row.Type, value) });
            await platform.SecretEvent(id, "secret.rotated", user.Value.ToString(), null, null, null, null, "allow", null);
            if (row.Provider == "openrouter") await Reliability.ResumeKeyWaiters(platform, user.Value);
            return Results.Json(await platform.SecretMeta(user.Value, id));
        });

        app.MapPost("/api/secrets/{id:guid}/revoke", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var n = await conn.ExecuteAsync("UPDATE secrets SET revoked_at=now(), updated_at=now() WHERE id=@id AND owner_user_id=@owner AND revoked_at IS NULL", new { id, owner = user });
            if (n == 0) return Results.NotFound();
            await platform.SecretEvent(id, "secret.revoked", user.Value.ToString(), null, null, null, null, "allow", null);
            return Results.Json(new { ok = true });
        });

        app.MapDelete("/api/secrets/{id:guid}", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var n = await conn.ExecuteAsync("UPDATE secrets SET ciphertext=decode('00','hex'), nonce=decode('000000000000000000000000','hex'), revoked_at=coalesce(revoked_at, now()) WHERE id=@id AND owner_user_id=@owner", new { id, owner = user });
            if (n == 0) return Results.NotFound();
            await conn.ExecuteAsync("DELETE FROM secrets WHERE id=@id AND owner_user_id=@owner", new { id, owner = user });
            await platform.SecretEvent(id, "secret.deleted", user.Value.ToString(), null, null, null, null, "allow", null);
            return Results.Json(new { ok = true });
        });

        app.MapGet("/api/secrets/{id:guid}/usage", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var owns = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM secrets WHERE id=@id AND owner_user_id=@owner", new { id, owner = user });
            if (owns == 0)
            {
                var audited = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM secret_usage_events WHERE secret_id=@id", new { id });
                if (audited == 0) return Results.NotFound();
            }
            var rows = await conn.QueryAsync("SELECT event, actor, tool, destination, decision, reason_code, created_at FROM secret_usage_events WHERE secret_id=@id ORDER BY created_at", new { id });
            return Results.Json(rows.Select(Platform.ToDict));
        });
    }

    private static void MapInternal(WebApplication app, Platform platform, Runtime runtime)
    {
        app.MapPost("/internal/recovery/hello", async (HttpContext ctx, JsonElement body) =>
        {
            if (!Worker(ctx, platform)) return Results.Unauthorized();
            var worker = body.GetProperty("workerId").GetString();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var n = await conn.ExecuteAsync("UPDATE tasks SET status='queued', lease_owner=NULL, lease_until=NULL, updated_at=now() WHERE status='running' AND (lease_owner=@worker OR lease_until < now())", new { worker });
            if (n > 0) platform.Tasks.Pulse();
            return Results.Json(new { reclaimed = n });
        });

        app.MapPost("/internal/tasks/lease", async (HttpContext ctx, JsonElement body) =>
        {
            if (!Worker(ctx, platform)) return Results.Unauthorized();
            var worker = body.GetProperty("workerId").GetString();
            var max = body.TryGetProperty("max", out var maxEl) ? maxEl.GetInt32() : 1;

            async Task<List<object>> TryLease()
            {
            await using var conn = await platform.Data.OpenConnectionAsync();
            await using var tx = await conn.BeginTransactionAsync();
            await conn.ExecuteAsync("SELECT pg_advisory_xact_lock(8421504)", transaction: tx);
            var ids = (await conn.QueryAsync<Guid>(
                """
                SELECT t.id FROM tasks t
                JOIN bots b ON b.id=t.bot_id
                WHERE t.status='queued'
                  AND NOT EXISTS (SELECT 1 FROM control_locks l WHERE l.bot_id=t.bot_id AND l.holder='human')
                  AND (SELECT count(*) FROM tasks r JOIN bots rb ON rb.id=r.bot_id WHERE r.status='running' AND rb.owner_id=b.owner_id)
                      < least(@cap, coalesce((SELECT max_parallel_tasks FROM user_quotas q WHERE q.user_id=b.owner_id), @cap))
                ORDER BY t.priority DESC, t.created_at
                FOR UPDATE OF t SKIP LOCKED
                LIMIT @max
                """, new { max, cap = platform.MaxParallel }, tx)).ToArray();
            var rows = new List<object>();
            var wake = new HashSet<string>();
            foreach (var id in ids)
            {
                var task = await conn.QuerySingleAsync<(Guid Id, Guid BotId, string Instruction, string Kind, int Attempt, int Epoch, string? Checkpoint, Guid? SkillId, Guid? ConversationId, Guid? SourceMessageId)>(
                    "UPDATE tasks SET status='running', lease_owner=@worker, lease_until=now()+interval '20 seconds', lease_epoch=lease_epoch+1, attempt=attempt+1, started_at=coalesce(started_at, now()), updated_at=now() WHERE id=@id RETURNING id, bot_id, instruction, kind, attempt, lease_epoch, checkpoint::text, skill_id, conversation_id, source_message_id",
                    new { id, worker }, tx);
                var feedback = (await conn.QueryAsync<(Guid MessageId, string Emoji, string Action)>(
                    """
                    UPDATE bot_feedback SET consumed_at=now(), task_id=@task
                    WHERE id IN (SELECT id FROM bot_feedback WHERE bot_id=@bot AND consumed_at IS NULL ORDER BY created_at FOR UPDATE)
                    RETURNING message_id, emoji, action
                    """,
                    new { task = id, bot = task.BotId }, tx)).Select(note => new { messageId = note.MessageId, emoji = note.Emoji, action = note.Action }).ToList();
                JsonElement? skillJson = null;
                if (task.SkillId != null)
                {
                    var skill = await conn.ExecuteScalarAsync<string>("SELECT definition::text FROM skills WHERE id=@id", new { id = task.SkillId }, tx);
                    if (!string.IsNullOrWhiteSpace(skill))
                    {
                        using var parsedSkill = JsonDocument.Parse(skill);
                        skillJson = parsedSkill.RootElement.Clone();
                    }
                }
                var placement = await platform.PlacementForBot(task.BotId);
                var dns = DockerComputeProvider.ContainerName(placement.Computer);
                rows.Add(new { id = task.Id, botId = task.BotId, computerId = placement.Computer.Value, cdpUrl = $"http://{dns}:9222", instruction = task.Instruction, kind = task.Kind, attempt = task.Attempt, epoch = task.Epoch, checkpoint = task.Checkpoint, conversationId = task.ConversationId, messageId = task.SourceMessageId, feedback, skill = skillJson });
                wake.Add(placement.Computer.Value);
            }
            await tx.CommitAsync();
            foreach (var computerId in wake)
            {
                try { await platform.Compute.EnsureAwakeAsync(new ComputerId(computerId), ctx.RequestAborted); }
                catch { /* The agent reports a computer that will not wake. */ }
            }
            return rows;
            }

            var pending = platform.Tasks.WaitHandle();
            var leased = await TryLease();
            if (leased.Count == 0)
            {
                await Task.WhenAny(pending, Task.Delay(TimeSpan.FromSeconds(20), ctx.RequestAborted));
                leased = await TryLease();
            }
            return Results.Json(leased);
        });

        app.MapPost("/internal/tasks/{id:guid}/heartbeat", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            if (!Worker(ctx, platform)) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var n = await conn.ExecuteAsync("UPDATE tasks SET lease_until=now()+interval '20 seconds', updated_at=now() WHERE id=@id AND lease_owner=@worker AND lease_epoch=@epoch AND status='running'", new { id, worker = body.GetProperty("workerId").GetString(), epoch = body.GetProperty("epoch").GetInt32() });
            return n == 0 ? Results.StatusCode(409) : Results.Json(new { ok = true });
        });

        app.MapGet("/internal/tasks/{id:guid}/transcript", async (HttpContext ctx, Guid id) =>
        {
            if (!Worker(ctx, platform)) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync("SELECT role, content, tool_calls::text AS tool_calls, tool_call_id, name FROM task_transcript WHERE task_id=@id ORDER BY seq", new { id });
            var messages = rows.Select(row =>
            {
                var dict = (IDictionary<string, object>)row;
                object? tools = null;
                if (dict["tool_calls"] is string json && json != "") tools = JsonDocument.Parse(json).RootElement;
                return new { role = dict["role"], content = dict["content"], toolCalls = tools, toolCallId = dict["tool_call_id"], name = dict["name"] };
            });
            return Results.Json(new { messages });
        });

        app.MapPut("/internal/tasks/{id:guid}/transcript", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            if (!Worker(ctx, platform)) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            await using var tx = await conn.BeginTransactionAsync();
            await conn.ExecuteAsync("DELETE FROM task_transcript WHERE task_id=@id", new { id }, tx);
            var seq = 0;
            foreach (var message in body.GetProperty("messages").EnumerateArray())
            {
                var content = message.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString() : "";
                content = OutputRedactor.Redact(content);
                var tools = message.TryGetProperty("toolCalls", out var tc) ? tc.GetRawText() : null;
                await conn.ExecuteAsync(
                    "INSERT INTO task_transcript (task_id, seq, role, content, tool_calls, tool_call_id, name) VALUES (@id, @seq, @role, @content, @tools::jsonb, @toolCallId, @name)",
                    new
                    {
                        id, seq,
                        role = message.GetProperty("role").GetString(),
                        content,
                        tools,
                        toolCallId = message.TryGetProperty("toolCallId", out var tid) ? tid.GetString() : null,
                        name = message.TryGetProperty("name", out var name) ? name.GetString() : null
                    }, tx);
                seq++;
            }
            await tx.CommitAsync();
            return Results.Json(new { ok = true });
        });

        app.MapPost("/internal/tasks/{id:guid}/grounding", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            if (!Worker(ctx, platform)) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            if (!await conn.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=@id AND status='running' AND lease_epoch=@epoch)", new { id, epoch = body.GetProperty("epoch").GetInt32() })) return Results.StatusCode(409);
            await Reliability.Event(platform, id, "grounding", new { verified = body.GetProperty("verified").GetInt32(), removed = body.GetProperty("removed").GetInt32() });
            return Results.Json(new { ok = true });
        });

        app.MapPost("/internal/tasks/{id:guid}/complete", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            if (!Worker(ctx, platform)) return Results.Unauthorized();
            var text = OutputRedactor.Redact(body.GetProperty("text").GetString());
            await using var conn = await platform.Data.OpenConnectionAsync();
            var epoch = body.TryGetProperty("epoch", out var epochEl) ? epochEl.GetInt32() : -1;
            var completed = await conn.QuerySingleOrDefaultAsync<(Guid? ConversationId, int Applied)>("UPDATE tasks SET status='completed', result=@result::jsonb, finished_at=now(), lease_owner=NULL, lease_until=NULL, updated_at=now() WHERE id=@id AND status='running' AND lease_epoch=@epoch RETURNING conversation_id, 1 AS applied", new { id, result = JsonSerializer.Serialize(new { text }), epoch });
            if (completed.Applied == 0) return Results.StatusCode(409);
            var conversation = completed.ConversationId;
            if (conversation != null && !string.IsNullOrWhiteSpace(text))
                await conn.ExecuteAsync("INSERT INTO messages (conversation_id, role, content, task_id) VALUES (@conversation, 'assistant', @text, @id)", new { conversation, text, id });
            var owner = await conn.ExecuteScalarAsync<Guid?>("SELECT b.owner_id FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE t.id=@id", new { id });
            if (owner != null) await platform.Notify(owner.Value, "task.complete", "Task finished", text ?? "");
            await platform.Publish(new { type = "task", taskId = id, status = "completed" });
            return Results.Json(new { ok = true });
        });

        app.MapPost("/internal/tasks/{id:guid}/fail", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            if (!Worker(ctx, platform)) return Results.Unauthorized();
            var failure = TaskErrors.Describe(body.GetProperty("error").GetString());
            var error = failure.Text;
            var errorCode = failure.Code;
            await using var conn = await platform.Data.OpenConnectionAsync();
            var epoch = body.TryGetProperty("epoch", out var epochEl) ? epochEl.GetInt32() : -1;
            var n = await conn.ExecuteAsync("UPDATE tasks SET status='failed', error=@error, error_code=@errorCode, finished_at=now(), lease_owner=NULL, updated_at=now() WHERE id=@id AND status='running' AND lease_epoch=@epoch", new { id, error, errorCode, epoch });
            if (n > 0) await Reliability.Event(platform, id, "error", new { error_code = errorCode, error });
            return n == 0 ? Results.StatusCode(409) : Results.Json(new { ok = true });
        });

        app.MapPost("/internal/tasks/{id:guid}/status", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            if (!Worker(ctx, platform)) return Results.Unauthorized();
            var status = body.GetProperty("status").GetString();
            var reason = body.TryGetProperty("reason", out var why) ? why.GetString() : body.TryGetProperty("waitingReason", out var why2) ? why2.GetString() : null;
            var checkpoint = body.TryGetProperty("checkpoint", out var cp) ? cp.GetRawText() : null;
            await using var conn = await platform.Data.OpenConnectionAsync();
            var epoch = body.TryGetProperty("epoch", out var epochEl) ? epochEl.GetInt32() : -1;
            if (status == "checkpoint")
            {
                var kept = await conn.ExecuteAsync("UPDATE tasks SET checkpoint=coalesce(@checkpoint::jsonb, checkpoint), updated_at=now() WHERE id=@id AND status='running' AND lease_epoch=@epoch", new { id, checkpoint, epoch });
                return kept == 0 ? Results.StatusCode(409) : Results.Json(new { ok = true });
            }
            if (status == "waiting_human" && reason == "ask_user")
            {
                var resumed = await conn.ExecuteAsync(
                    """
                    UPDATE tasks
                    SET status='queued', waiting_reason=NULL, lease_owner=NULL, lease_until=NULL, updated_at=now()
                    WHERE id=@id
                      AND status IN ('running', 'waiting_human')
                      AND EXISTS (
                        SELECT 1 FROM messages
                        WHERE task_id=@id AND kind='question'
                          AND jsonb_typeof(content::jsonb -> 'answer') = 'array'
                          AND jsonb_array_length(content::jsonb -> 'answer') > 0
                      )
                    """,
                    new { id });
                if (resumed > 0)
                {
                    platform.Tasks.Pulse();
                    return Results.Json(new { ok = true, resumed = true });
                }
            }
            var n = await conn.ExecuteAsync(
                """
                UPDATE tasks
                SET status=@status,
                    waiting_reason=coalesce(@reason, waiting_reason),
                    checkpoint=coalesce(@checkpoint::jsonb, checkpoint),
                    lease_owner=CASE WHEN @status IN ('waiting_human','waiting_approval','waiting_resource') THEN NULL ELSE lease_owner END,
                    lease_until=CASE WHEN @status IN ('waiting_human','waiting_approval','waiting_resource') THEN NULL ELSE lease_until END,
                    updated_at=now()
                WHERE id=@id
                  AND status='running'
                  AND lease_epoch=@epoch
                  AND NOT (
                    @status = 'waiting_human' AND coalesce(@reason, '') = 'ask_user' AND EXISTS (
                      SELECT 1 FROM messages
                      WHERE task_id=@id AND kind='question'
                        AND jsonb_typeof(content::jsonb -> 'answer') = 'array'
                        AND jsonb_array_length(content::jsonb -> 'answer') > 0
                    )
                  )
                """,
                new { id, status, reason, checkpoint, epoch });
            if (n > 0 && Reliability.WaitsForKey(status, reason))
            {
                var owner = await conn.ExecuteScalarAsync<Guid>("SELECT b.owner_id FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE t.id=@id", new { id });
                var failure = TaskErrors.Describe(reason);
                await conn.ExecuteAsync("UPDATE tasks SET error_code=@code,error=@text WHERE id=@id AND status='waiting_resource'", new { id, code = failure.Code, text = failure.Text });
                await Reliability.Event(platform, id, "error", new { error_code = failure.Code, error = failure.Text });
                await Reliability.ResumeKeyWaiters(platform, owner);
            }
            return n == 0 ? Results.StatusCode(409) : Results.Json(new { ok = true });
        });

        app.MapPost("/internal/model/complete", (HttpContext ctx, JsonElement body, CancellationToken ct) => Worker(ctx, platform) ? runtime.Model(body, ct) : Task.FromResult<IResult>(Results.Unauthorized()));
        app.MapPost("/internal/tools/authorize", (HttpContext ctx, JsonElement body, CancellationToken ct) => Worker(ctx, platform) ? runtime.Authorize(body, ct) : Task.FromResult<IResult>(Results.Unauthorized()));
        app.MapPost("/internal/tools/execute", (HttpContext ctx, JsonElement body, CancellationToken ct) => Worker(ctx, platform) ? runtime.Execute(body, ct) : Task.FromResult<IResult>(Results.Unauthorized()));
        app.MapPost("/internal/tools/observe", (HttpContext ctx, JsonElement body, CancellationToken ct) => Worker(ctx, platform) ? runtime.Observe(body, ct) : Task.FromResult<IResult>(Results.Unauthorized()));

        app.MapPost("/internal/test/users", async (HttpContext ctx, JsonElement body) =>
        {
            if (!platform.TestHooks || !Worker(ctx, platform)) return Results.NotFound();
            var username = body.GetProperty("username").GetString();
            var password = body.GetProperty("password").GetString() ?? "";
            await using var conn = await platform.Data.OpenConnectionAsync();
            var id = await conn.ExecuteScalarAsync<Guid>("INSERT INTO users (username, password_hash) VALUES (@username, @hash) ON CONFLICT (username) DO UPDATE SET password_hash=EXCLUDED.password_hash RETURNING id", new { username, hash = Passwords.Hash(password) });
            return Results.Json(new { id, username });
        });
    }

    private static async Task<IResult> Desktop(HttpContext ctx, Platform platform, Guid id, bool control, CancellationToken ct)
    {
        var user = await RequireUser(ctx, platform);
        if (user == null || !await Owns(platform, user.Value, id)) return Results.Unauthorized();
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        long hinted;
        if (control)
        {
            hinted = await conn.ExecuteScalarAsync<long>("UPDATE control_locks SET holder='human', epoch=epoch+1, updated_at=now() WHERE bot_id=@id RETURNING epoch", new { id });
            await conn.ExecuteAsync("UPDATE tasks SET status='waiting_human', waiting_reason='takeover', lease_owner=NULL, lease_until=NULL, lease_epoch=lease_epoch+1, updated_at=now() WHERE bot_id=@id AND status='running' AND instruction NOT LIKE 'Terminal:%'", new { id });
        }
        else hinted = await conn.ExecuteScalarAsync<long>("SELECT epoch FROM control_locks WHERE bot_id=@id", new { id });
        var placement = await platform.PlacementForBot(id, ct);
        // Bots on one computer each keep a lock, but the desktop has a single fence.
        // Walk forward until the presented epoch is current, then remember it on this bot.
        var epoch = (ulong)Math.Max(hinted, 1);
        DesktopSession? session = null;
        for (var attempt = 0; attempt < 256; attempt++)
        {
            try
            {
                session = await platform.Compute.GetDesktopSessionAsync(placement.Computer, new DesktopAccess(control ? DesktopMode.Interactive : DesktopMode.View, epoch, TimeSpan.FromMinutes(5), control), ct);
                break;
            }
            catch (ComputeException ex) when (ex.Code == ComputeErrorCode.FailedPrecondition && ex.Message.Contains("stale fencing epoch", StringComparison.Ordinal))
            {
                epoch++;
            }
        }
        if (session == null) throw ComputeException.FailedPrecondition("stale fencing epoch");
        if (control)
            session = await platform.Compute.GetDesktopSessionAsync(placement.Computer, new DesktopAccess(DesktopMode.Interactive, session.FencingEpoch + 1, TimeSpan.FromMinutes(5), true), ct);
        if ((long)session.FencingEpoch != hinted)
            await conn.ExecuteAsync("UPDATE control_locks SET epoch=@epoch, updated_at=now() WHERE bot_id=@id AND epoch < @epoch", new { id, epoch = (long)session.FencingEpoch });
        return Results.Json(new { token = session.Token, mode = control ? "control" : "view", epoch = session.FencingEpoch });
    }

    private static long? SseEventId(string frame)
    {
        var line = frame.Split('\n', 2)[0];
        if (!line.StartsWith("id:", StringComparison.Ordinal)) return null;
        return long.TryParse(line.AsSpan(3).Trim(), out var id) ? id : null;
    }

    private static async Task<Guid?> RequireUser(HttpContext ctx, Platform platform)
    {
        ctx.Request.Cookies.TryGetValue("teammates_session", out var token);
        return await platform.UserForSession(token);
    }

    private static async Task<bool> Owns(Platform platform, Guid user, Guid bot)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        return await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM bots WHERE id=@bot AND owner_id=@user", new { bot, user }) > 0;
    }

    private static bool Worker(HttpContext ctx, Platform platform)
    {
        var header = ctx.Request.Headers.Authorization.ToString();
        var token = header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? header[7..].Trim() : "";
        var expected = Encoding.UTF8.GetBytes(platform.WorkerToken);
        var presented = Encoding.UTF8.GetBytes(token);
        return expected.Length > 0 && presented.Length == expected.Length && CryptographicOperations.FixedTimeEquals(presented, expected);
    }

    private static async Task<bool> AllowedMetrics(HttpContext ctx, Platform platform)
    {
        var header = ctx.Request.Headers.Authorization.ToString();
        if (header == "Bearer " + platform.MetricsToken && platform.MetricsToken.Length > 0) return true;
        return await RequireUser(ctx, platform) != null;
    }

    private static CookieOptions Cookie(HttpContext ctx) => new()
    {
        HttpOnly = true,
        SameSite = SameSiteMode.Lax,
        Secure = ctx.Request.Headers["X-Forwarded-Proto"] == "https",
        Path = "/"
    };

    private static string[] ReadStrings(JsonElement body, string name)
    {
        if (!body.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Array) return [];
        return value.EnumerateArray().Select(item => item.GetString() ?? "").Where(item => item.Length > 0).ToArray();
    }

    private static Guid[] ReadGuids(JsonElement body, string name)
    {
        if (!body.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Array) return [];
        return value.EnumerateArray().Select(item => Guid.TryParse(item.GetString(), out var parsed) ? parsed : Guid.Empty).Where(item => item != Guid.Empty).ToArray();
    }
}
