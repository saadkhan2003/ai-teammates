using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Amazon.S3.Model;
using Dapper;
using Microsoft.Extensions.Logging;
using Npgsql;
using Teammates.Compute;

namespace Teammates.Api;

public static class Routes
{
    internal static bool ValidAvatar(string shape, string color) =>
        (shape.Length == 0 || System.Text.RegularExpressions.Regex.IsMatch(shape, @"^blob(1[0-5]|[1-9])$")) &&
        (color.Length == 0 || System.Text.RegularExpressions.Regex.IsMatch(color, @"^#[0-9a-fA-F]{6}$"));

    public static void Map(WebApplication app, Platform platform, Runtime runtime)
    {
        LibraryRoutes.Map(app, platform);
        SkillLibraryRoutes.Map(app, platform, runtime);
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
            var testLogin = LoginRateLimiter.RelaxFor(platform.TestHooks, ctx.Request.Headers);
            // Keep opted-in test traffic out of the ordinary limiter's bucket.
            if (testLogin) ip = "test-login:" + ip;
            if (await platform.LoginBlocked(ip, testLogin)) return Results.StatusCode(429);
            var loginAttemptId = await platform.NoteLoginAttempt(ip);
            var username = body.GetProperty("username").GetString() ?? "";
            var password = body.GetProperty("password").GetString() ?? "";
            await using var conn = await platform.Data.OpenConnectionAsync();
            var row = await conn.QuerySingleOrDefaultAsync<(Guid Id, string Hash, string Status)>("SELECT id, password_hash, coalesce(status, 'active') FROM users WHERE username=@username", new { username });
            if (row.Id == Guid.Empty || !Passwords.Verify(password, row.Hash ?? ""))
            {
                await platform.NoteLoginFailure(ip, loginAttemptId);
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
            var me = await conn.QuerySingleAsync<(string Username, string Role, string Status, string DisplayName, string Timezone)>("SELECT username, role, status, display_name, timezone FROM users WHERE id=@id", new { id = user });
            return Results.Json(new { id = user, username = me.Username, role = me.Role, status = me.Status, displayName = me.DisplayName, timezone = me.Timezone });
        });

        app.MapPatch("/api/auth/timezone", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var zone = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("timezone", out var zoneEl) && zoneEl.ValueKind == JsonValueKind.String ? zoneEl.GetString() : null;
            if (!RoutineTime.TryZone(zone, out _)) return Results.BadRequest(new { error = "unknown_timezone" });
            await using var conn = await platform.Data.OpenConnectionAsync();
            await conn.ExecuteAsync("UPDATE users SET timezone=@zone WHERE id=@id", new { id = user, zone = zone!.Trim() });
            return Results.Json(new { ok = true, timezone = zone.Trim() });
        });

        app.MapGet("/api/bots", async (HttpContext ctx) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync(
                """
                SELECT b.id, b.name, b.role, b.instructions, b.status, b.created_at, b.section, b.avatar, b.avatar_shape, b.avatar_color, b.model, b.notifications_enabled, b.is_primary, b.bio, b.peer_messaging,
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
            var bio = BotBio.Normalize(body.TryGetProperty("bio", out var bioEl) ? bioEl.GetString() : "");
            if (bio == null) return Results.BadRequest(new { error = "invalid bio" });
            var id = Guid.NewGuid();
            var botToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(botToken))).ToLowerInvariant();
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var quota = await conn.QuerySingleOrDefaultAsync<(int MaxBots, int Cpu, long Memory, long Disk)>("SELECT max_bots, cpu_millis, memory_bytes, disk_bytes FROM user_quotas WHERE user_id=@id", new { id = user });
            var maxBots = quota.MaxBots == 0 ? 8 : quota.MaxBots;
            var existingBots = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM bots WHERE owner_id=@id", new { id = user });
            if (existingBots >= maxBots) return Results.Json(new { error = "quota", reason = "max_bots" }, statusCode: 403);
            var shared = await conn.QuerySingleOrDefaultAsync<Guid?>("SELECT computer_id FROM user_computers WHERE user_id=@id", new { id = user });
            await conn.ExecuteAsync("INSERT INTO bots (id, owner_id, name, role, instructions, token_hash, avatar_shape, avatar_color, is_primary, bio) VALUES (@id, @owner, @name, @role, @instructions, @hash, @avatarShape, @avatarColor, @primary, @bio)", new { id, owner = user, name, role, instructions, hash, avatarShape, avatarColor, primary = existingBots == 0, bio });
            var conversation = await conn.ExecuteScalarAsync<Guid>("INSERT INTO conversations (bot_id, title) VALUES (@id, 'Desk') RETURNING id", new { id });
            await conn.ExecuteAsync("INSERT INTO control_locks (bot_id, holder, epoch) VALUES (@id, 'agent', 1)", new { id });
            try
            {
                if (shared == null)
                {
                    // Legacy 400m is the old default; use the configurable provider CPU budget.
                    var cpu = quota.Cpu is 0 or 400 ? 0u : (uint)quota.Cpu;
                    var memory = quota.Memory <= 0 ? 640UL * 1024 * 1024 : (ulong)quota.Memory;
                    var disk = (ulong)(quota.Disk <= 0 ? (long)DiskQuota.DefaultBytes : quota.Disk);
                    var computerId = new ComputerId(id.ToString());
                    await platform.Compute.CreateComputerAsync(new CreateComputerSpec(computerId, "local", user.Value.ToString(), Environment.GetEnvironmentVariable("COMPUTE_IMAGE") ?? "teammates-computer:dev", IsolationClass.Docker, new ResourceLimits(cpu, memory, disk, 256), "", new Dictionary<string, string> { ["name"] = name }), IdempotencyKey.Require("create-" + id.ToString("n")), ct);
                    await conn.ExecuteAsync(
                        "INSERT INTO user_computers (user_id, computer_id, desktop_bot_id, status) VALUES (@user, @computer, @desktop, 'running') ON CONFLICT (user_id) DO NOTHING",
                        new { user, computer = id, desktop = id });
                    // A new computer starts with the agent holding the display; the migration only seeded computers that existed then.
                    await conn.ExecuteAsync(
                        "INSERT INTO desktop_lease (computer_id, display, holder_kind, holder_user_id, epoch, expires_at, updated_at) " +
                        "SELECT computer_id, 1, 'agent', user_id, 1, clock_timestamp() + interval '90 seconds', clock_timestamp() FROM user_computers WHERE user_id=@user " +
                        "ON CONFLICT (computer_id, display) DO NOTHING",
                        new { user });
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

        app.MapGet("/api/bots/{id:guid}/messages", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            Guid? before = Guid.TryParse(ctx.Request.Query["before"], out var b) ? b : null;
            var limit = int.TryParse(ctx.Request.Query["limit"], out var l) ? Math.Clamp(l, 1, 200) : 100;
            await using var conn = await platform.Data.OpenConnectionAsync();
            var conversationId = await conn.ExecuteScalarAsync<Guid>("SELECT id FROM conversations WHERE bot_id=@id ORDER BY created_at LIMIT 1", new { id });
            var (messages, hasMore) = await LoadMessages(conn, conversationId, before, limit);
            return Results.Json(new { messages, hasMore });
        });

        app.MapGet("/api/bots/{id:guid}/workspace", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var bot = Platform.ToDict(await conn.QuerySingleAsync("SELECT id, name, role, instructions, status, model, avatar, avatar_shape, avatar_color, section, notifications_enabled, is_primary, bio, peer_messaging FROM bots WHERE id=@id", new { id }));
            var conversationId = await conn.ExecuteScalarAsync<Guid>("SELECT id FROM conversations WHERE bot_id=@id ORDER BY created_at LIMIT 1", new { id });
            var tasks = (await conn.QueryAsync("SELECT id, title, instruction, status, kind, model_calls, waiting_reason, error, error_code, result::text AS result FROM tasks WHERE bot_id=@id ORDER BY created_at DESC LIMIT 50", new { id })).Select(Platform.ToDict);
            var (messages, messagesHasMore) = await LoadMessages(conn, conversationId, null, 200);
            var approvals = (await conn.QueryAsync("SELECT a.id, a.action, a.target, a.reason, a.status, a.risk_class, a.summary, th.id AS thread_id, th.title AS thread_title, th.initiator_name AS requested_by, ab.name AS bot_name, (a.bot_id<>@id) AS relayed FROM approvals a LEFT JOIN tasks t ON t.id=a.task_id JOIN bots ab ON ab.id=a.bot_id LEFT JOIN bot_threads th ON th.id=t.origin_thread_id WHERE a.status='pending' AND (a.bot_id=@id OR th.initiator_bot_id=@id) ORDER BY a.created_at", new { id })).Select(Platform.ToDict);
            var botThreads = (await conn.QueryAsync("SELECT th.id, th.title, th.status, th.error_code, th.message_count, th.initiator_bot_id, th.peer_bot_id, th.initiator_name, th.peer_name, th.created_at, th.updated_at, (SELECT left(m.content, 600) FROM bot_thread_messages m WHERE m.thread_id=th.id AND m.kind='reply' ORDER BY m.seq DESC LIMIT 1) AS last_reply, (SELECT left(m.content, 600) FROM bot_thread_messages m WHERE m.thread_id=th.id AND m.kind='request' ORDER BY m.seq LIMIT 1) AS first_request FROM bot_threads th WHERE th.initiator_bot_id=@id OR th.peer_bot_id=@id ORDER BY th.created_at DESC LIMIT 50", new { id })).Select(Platform.ToDict);
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
            return Results.Json(new { bot, conversationId, tasks, messages, messagesHasMore, approvals, botThreads, pages, holder, secretRequests, loginRequests, llmProvider = platform.LlmProvider, openrouterConnected = connected });
        });

        app.MapPost("/api/conversations/{id:guid}/messages", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var botId = await conn.ExecuteScalarAsync<Guid?>("SELECT c.bot_id FROM conversations c JOIN bots b ON b.id=c.bot_id WHERE c.id=@id AND b.owner_id=@owner", new { id, owner = user });
            if (botId == null) return Results.NotFound();
            var asTask = body.TryGetProperty("asTask", out var flag) && flag.ValueKind == JsonValueKind.True;
            string content, instruction, title;
            string metadata = "{}";
            Guid? replyTo = null;
            if (body.TryGetProperty("parts", out var partsEl) && partsEl.ValueKind != JsonValueKind.Null)
            {
                var parsed = MessageParts.Parse(partsEl);
                if (!parsed.Ok) return Results.Json(new { error = parsed.Error }, statusCode: 400);
                var parts = parsed.Parts;
                var ids = parts.Where(p => p.Type == "reply").Select(p => p.MessageId!.Value)
                    .Concat(parts.Where(p => p.SourceMessageId != null).Select(p => p.SourceMessageId!.Value)).Distinct().ToArray();
                var known = ids.Length == 0 ? new List<dynamic>() : (await conn.QueryAsync("SELECT m.id, m.role, m.content, m.deleted_at FROM messages m WHERE m.conversation_id=@id AND m.id = ANY(@ids)", new { id, ids })).ToList();
                var replies = new Dictionary<Guid, MessageParts.ReplyInfo>();
                var botName = await conn.ExecuteScalarAsync<string>("SELECT name FROM bots WHERE id=@botId", new { botId }) ?? "Assistant";
                foreach (var row in known)
                {
                    if (row.deleted_at != null) continue;
                    replies[(Guid)row.id] = new MessageParts.ReplyInfo((Guid)row.id, (string)row.role == "user" ? "You" : botName, MessageParts.PlainText((string)row.content));
                }
                foreach (var part in parts.Where(p => p.Type == "reply"))
                {
                    var target = known.FirstOrDefault(r => (Guid)r.id == part.MessageId);
                    if (target == null) return Results.Json(new { error = "reply_target_not_found" }, statusCode: 400);
                    if (target.deleted_at != null) return Results.Json(new { error = "reply_target_deleted" }, statusCode: 400);
                }
                var knownIds = known.Select(r => (Guid)r.id).ToHashSet();
                parts = parts.Select(p => p.Type == "quote" && p.SourceMessageId != null && !knownIds.Contains(p.SourceMessageId.Value) ? p with { SourceMessageId = null } : p).ToList();
                if (Dlp.HasStrict(MessageParts.Concat(parts, replies.Values.Select(r => r.Text))))
                    return Results.Json(new { error = "Blocked by the data policy. Card numbers, IDs, and secrets are not sent." }, statusCode: 422);
                content = MessageParts.Flatten(parts);
                instruction = MessageParts.BuildInstruction(parts, replies);
                title = MessageParts.Title(parts);
                var stored = parts.Select(p => p.Type switch
                {
                    "quote" => (object)new { type = "quote", text = p.Text, sourceMessageId = p.SourceMessageId },
                    "reply" => new { type = "reply", messageId = p.MessageId, author = replies.TryGetValue(p.MessageId!.Value, out var r) ? r.Author : "", excerpt = replies.TryGetValue(p.MessageId!.Value, out var r2) ? MessageParts.Excerpt(r2.Text) : "" },
                    _ => new { type = "text", text = p.Text },
                }).ToList();
                metadata = JsonSerializer.Serialize(new { parts = stored });
                replyTo = parts.FirstOrDefault(p => p.Type == "reply")?.MessageId;
            }
            else
            {
                content = body.GetProperty("content").GetString() ?? "";
                if (Dlp.HasStrict(content))
                    return Results.Json(new { error = "Blocked by the data policy. Card numbers, IDs, and secrets are not sent." }, statusCode: 422);
                instruction = content;
                title = MessageParts.Clip(content, 80);
                if (body.TryGetProperty("skill", out var skillEl) && skillEl.ValueKind == JsonValueKind.String)
                {
                    var recording = body.TryGetProperty("recording", out var recEl) ? recEl.GetString() : null;
                    if (skillEl.GetString() != DemoSkill.Id || !DemoSkill.ValidRecording(recording)) return Results.Json(new { error = "invalid_skill" }, statusCode: 400);
                    instruction = DemoSkill.Instruction(content, recording!);
                    metadata = DemoSkill.Metadata(recording!);
                    asTask = true;
                }
            }
            if (botId != null && LibraryIngest.HasDeniedAttachment(content))
                return Results.Json(new { error = Dlp.Blocked }, statusCode: 422);
            var messageId = await conn.ExecuteScalarAsync<Guid>("INSERT INTO messages (conversation_id, role, content, metadata, reply_to_message_id) VALUES (@id, 'user', @content, @metadata::jsonb, @replyTo) RETURNING id", new { id, content, metadata, replyTo });
            if (botId is Guid indexedBotId)
                await LibraryIngest.IndexMessageAttachments(platform, runtime, indexedBotId, messageId, content, ctx.RequestAborted);
            var pausedTask = await conn.QuerySingleOrDefaultAsync<(Guid Id, string Reason)>("""
                SELECT t.id,t.waiting_reason FROM tasks t JOIN bots b ON b.id=t.bot_id
                WHERE t.bot_id=@bot AND t.conversation_id=@conversation AND b.owner_id=@owner
                  AND t.status='waiting_human' AND t.waiting_reason IN ('budget_reached','no_progress','resume_exhausted')
                ORDER BY t.updated_at DESC LIMIT 1
                """, new { bot = botId, conversation = id, owner = user });
            if (pausedTask.Id != Guid.Empty)
            {
                var resumed = await conn.ExecuteAsync("""
                    UPDATE tasks t SET status='queued', waiting_reason=NULL,
                        instruction=instruction || E'\\n\\nUser continuation: ' || @instruction,
                        budget_steps=CASE WHEN t.waiting_reason='budget_reached' THEN least(1000,coalesce(t.budget_steps,b.default_budget_steps,200)+200) ELSE t.budget_steps END,
                        budget_seconds=CASE WHEN t.waiting_reason='budget_reached' THEN least(21600,coalesce(t.budget_seconds,b.default_budget_seconds,3600)+3600) ELSE t.budget_seconds END,
                        lease_owner=NULL, lease_until=NULL, resume_after=NULL, lease_epoch=lease_epoch+1, updated_at=now()
                    FROM bots b WHERE t.id=@task AND t.bot_id=@bot AND b.id=t.bot_id AND t.status='waiting_human'
                      AND waiting_reason IN ('budget_reached','no_progress','resume_exhausted')
                    """, new { task = pausedTask.Id, bot = botId, instruction });
                if (resumed > 0)
                {
                    await platform.Audit(user.Value.ToString(), "task.resumed", botId, pausedTask.Id, new { source = "user_message", messageId });
                    if (pausedTask.Reason == "budget_reached")
                        await platform.Audit(user.Value.ToString(), "task.budget_continue", botId, pausedTask.Id, new { source = "user_message", extraSteps = 200, extraSeconds = 3600 });
                    await Reliability.Event(platform, pausedTask.Id, "resumed", new { reason = "user_message", source = "user_message" });
                    await platform.Publish(new { type = "task", taskId = pausedTask.Id, status = "queued" });
                    platform.Tasks.Pulse();
                    return Results.Json(new { messageId, taskId = pausedTask.Id, status = "queued", resumed = true });
                }
            }
            var kind = asTask ? "work" : "chat";
            var priority = asTask ? 0 : 10;
            var taskId = await conn.ExecuteScalarAsync<Guid>(
                "INSERT INTO tasks (bot_id, conversation_id, title, instruction, kind, priority, status, source_message_id) VALUES (@bot, @conversation, @title, @instruction, @kind, @priority, 'queued', @message) RETURNING id",
                new { bot = botId, conversation = id, title, instruction, kind, priority, message = messageId });
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
        app.MapDelete("/api/messages/{id:guid}", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            return await ChatActions.Delete(platform, user.Value, id);
        });
        app.MapPost("/api/messages/{id:guid}/retry", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            return await ChatActions.Retry(platform, user.Value, id);
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

        app.MapGet("/api/tasks/{id:guid}/attempts", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            if (!await conn.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE t.id=@id AND b.owner_id=@owner)", new { id, owner = user })) return Results.NotFound();
            var rows = await conn.QueryAsync("SELECT id,task_id,attempt,started_at,ended_at,wall_seconds,tool_calls,end_reason,progress,worker,api_uptime_seconds FROM task_attempt_log WHERE task_id=@id ORDER BY id", new { id });
            return Results.Json(rows.Select(Platform.ToDict));
        });

        app.MapGet("/api/tasks/{id:guid}/history", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            if (!await conn.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE t.id=@id AND b.owner_id=@owner)", new { id, owner = user })) return Results.NotFound();
            var rows = await conn.QueryAsync("SELECT compaction_id,seq,role,content,tool_calls::text AS tool_calls,tool_call_id,name,archived_at FROM task_transcript_archive WHERE task_id=@id ORDER BY archived_at,compaction_id,seq", new { id });
            return Results.Json(rows.Select(Platform.ToDict));
        });

        app.MapGet("/api/bots/{id:guid}/work-settings", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var settings = await conn.QuerySingleOrDefaultAsync("SELECT coalesce(default_budget_steps,200) AS \"maxSteps\",coalesce(default_budget_seconds,3600) AS \"maxSeconds\",require_tests AS \"requireTests\",pause_on_budget AS \"pauseOnBudget\" FROM bots WHERE id=@id AND owner_id=@owner", new { id, owner = user });
            return settings == null ? Results.NotFound() : Results.Json(settings);
        });
        app.MapPatch("/api/bots/{id:guid}/work-settings", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            if (!await conn.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM bots WHERE id=@id AND owner_id=@owner)", new { id, owner = user })) return Results.NotFound();
            if (body.ValueKind != JsonValueKind.Object || body.EnumerateObject().Any(p => p.Name is not ("maxSteps" or "maxSeconds" or "requireTests" or "pauseOnBudget"))) return Results.BadRequest(new { error = "invalid work settings" });
            if (body.TryGetProperty("maxSteps", out var stepValue) && (stepValue.ValueKind != JsonValueKind.Number || !stepValue.TryGetInt32(out _))) return Results.BadRequest(new { error = "maxSteps must be an integer" });
            if (body.TryGetProperty("maxSeconds", out var secondsValue) && (secondsValue.ValueKind != JsonValueKind.Number || !secondsValue.TryGetInt32(out _))) return Results.BadRequest(new { error = "maxSeconds must be an integer" });
            if (body.TryGetProperty("requireTests", out var requireValue) && requireValue.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return Results.BadRequest(new { error = "requireTests must be a boolean" });
            if (!RunBudget.TryParsePauseOnBudget(body, out var pause)) return Results.BadRequest(new { error = "pauseOnBudget must be a boolean" });
            var steps = body.TryGetProperty("maxSteps", out var se) && se.ValueKind == JsonValueKind.Number ? Math.Clamp(se.GetInt32(), 4, 1000) : (int?)null;
            var seconds = body.TryGetProperty("maxSeconds", out var te) && te.ValueKind == JsonValueKind.Number ? Math.Clamp(te.GetInt32(), 30, 21600) : (int?)null;
            var tests = body.TryGetProperty("requireTests", out var re) && re.ValueKind is JsonValueKind.True or JsonValueKind.False ? re.GetBoolean() : (bool?)null;
            await conn.ExecuteAsync("UPDATE bots SET default_budget_steps=coalesce(@steps,default_budget_steps),default_budget_seconds=coalesce(@seconds,default_budget_seconds),require_tests=coalesce(@tests,require_tests),pause_on_budget=coalesce(@pause,pause_on_budget),updated_at=now() WHERE id=@id", new { id, steps, seconds, tests, pause });
            return Results.Json(new { ok = true });
        });
        app.MapPatch("/api/tasks/{id:guid}/budget", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var owns = await conn.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE t.id=@id AND b.owner_id=@owner)", new { id, owner = user });
            if (!owns) return Results.NotFound();
            if (body.ValueKind != JsonValueKind.Object || body.EnumerateObject().Any(p => p.Name is not ("maxSteps" or "maxSeconds" or "pauseOnBudget"))) return Results.BadRequest(new { error = "invalid task budget" });
            if (body.TryGetProperty("maxSteps", out var stepValue) && (stepValue.ValueKind != JsonValueKind.Number || !stepValue.TryGetInt32(out _))) return Results.BadRequest(new { error = "maxSteps must be an integer" });
            if (body.TryGetProperty("maxSeconds", out var secondsValue) && (secondsValue.ValueKind != JsonValueKind.Number || !secondsValue.TryGetInt32(out _))) return Results.BadRequest(new { error = "maxSeconds must be an integer" });
            if (!RunBudget.TryParsePauseOnBudget(body, out var pause)) return Results.BadRequest(new { error = "pauseOnBudget must be a boolean" });
            var steps = body.TryGetProperty("maxSteps", out var se) && se.ValueKind == JsonValueKind.Number ? Math.Clamp(se.GetInt32(), 4, 1000) : (int?)null;
            var seconds = body.TryGetProperty("maxSeconds", out var te) && te.ValueKind == JsonValueKind.Number ? Math.Clamp(te.GetInt32(), 30, 21600) : (int?)null;
            await conn.ExecuteAsync("UPDATE tasks SET budget_steps=coalesce(@steps,budget_steps),budget_seconds=coalesce(@seconds,budget_seconds),pause_on_budget=coalesce(@pause,pause_on_budget) WHERE id=@id", new { id, steps, seconds, pause });
            return Results.Json(new { ok = true });
        });
        app.MapPost("/api/tasks/{id:guid}/continue", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var row = await conn.QuerySingleOrDefaultAsync<(Guid BotId, string Status, string? Reason, int? Steps, int? Seconds, int? BotSteps, int? BotSeconds)>("""
                SELECT t.bot_id,t.status,t.waiting_reason,t.budget_steps,t.budget_seconds,b.default_budget_steps,b.default_budget_seconds
                FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE t.id=@id AND b.owner_id=@owner
                """, new { id, owner = user });
            if (row.BotId == Guid.Empty) return Results.NotFound();
            if (row.Status != "waiting_human" || row.Reason is not ("budget_reached" or "no_progress" or "resume_exhausted" or "context_exhausted"))
                return Results.Conflict(new { error = "task_not_continuable" });
            var current = RunBudget.Resolve(row.Steps, row.Seconds, row.BotSteps, row.BotSeconds);
            var contextExhausted = row.Reason == "context_exhausted";
            var extraSteps = contextExhausted ? 0 : body.ValueKind == JsonValueKind.Object && body.TryGetProperty("extraSteps", out var se) && se.TryGetInt32(out var s) ? Math.Clamp(s, 1, 1000) : 200;
            var extraSeconds = contextExhausted ? 0 : body.ValueKind == JsonValueKind.Object && body.TryGetProperty("extraSeconds", out var te) && te.TryGetInt32(out var t) ? Math.Clamp(t, 1, 21600) : 3600;
            var nextSteps = Math.Clamp(current.MaxSteps + extraSteps, 4, 1000);
            var nextSeconds = Math.Clamp(current.MaxSeconds + extraSeconds, 30, 21600);
            var n = await conn.ExecuteAsync("""
                UPDATE tasks SET status='queued',waiting_reason=NULL,budget_steps=@steps,budget_seconds=@seconds,
                    lease_owner=NULL,lease_until=NULL,resume_after=NULL,lease_epoch=lease_epoch+1,updated_at=now()
                WHERE id=@id AND status='waiting_human' AND waiting_reason IN ('budget_reached','no_progress','resume_exhausted','context_exhausted')
                """, new { id, steps = nextSteps, seconds = nextSeconds });
            if (n == 0) return Results.Conflict(new { error = "task_not_continuable" });
            await platform.Audit(user.Value.ToString(), "task.budget_continue", row.BotId, id, new { extraSteps, extraSeconds, maxSteps = nextSteps, maxSeconds = nextSeconds });
            await Reliability.Event(platform, id, "budget_continued", new { maxSteps = nextSteps, maxSeconds = nextSeconds });
            platform.Tasks.Pulse();
            return Results.Json(new { ok = true, maxSteps = nextSteps, maxSeconds = nextSeconds });
        });
        app.MapPost("/api/tasks/{id:guid}/raise-budget", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (body.ValueKind != JsonValueKind.Object || body.EnumerateObject().Any(p => p.Name is not ("maxSteps" or "maxSeconds"))) return Results.BadRequest(new { error = "invalid task budget" });
            if (body.TryGetProperty("maxSteps", out var se) && (se.ValueKind != JsonValueKind.Number || !se.TryGetInt32(out _))) return Results.BadRequest(new { error = "maxSteps must be an integer" });
            if (body.TryGetProperty("maxSeconds", out var te) && (te.ValueKind != JsonValueKind.Number || !te.TryGetInt32(out _))) return Results.BadRequest(new { error = "maxSeconds must be an integer" });
            await using var conn = await platform.Data.OpenConnectionAsync();
            var row = await conn.QuerySingleOrDefaultAsync<(Guid BotId, string Status, string? Reason)>("SELECT t.bot_id,t.status,t.waiting_reason FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE t.id=@id AND b.owner_id=@owner", new { id, owner = user });
            if (row.BotId == Guid.Empty) return Results.NotFound();
            if (row.Status != "waiting_human" || row.Reason != "budget_reached") return Results.Conflict(new { error = "budget_not_reached" });
            var steps = body.TryGetProperty("maxSteps", out var stepValue) ? Math.Clamp(stepValue.GetInt32(), 4, 1000) : (int?)null;
            var seconds = body.TryGetProperty("maxSeconds", out var secondValue) ? Math.Clamp(secondValue.GetInt32(), 30, 21600) : (int?)null;
            var raised = await conn.ExecuteAsync("UPDATE tasks SET budget_steps=coalesce(@steps,budget_steps),budget_seconds=coalesce(@seconds,budget_seconds),status='queued',waiting_reason=NULL,lease_owner=NULL,lease_until=NULL,resume_after=NULL,lease_epoch=lease_epoch+1,updated_at=now() WHERE id=@id AND status='waiting_human' AND waiting_reason='budget_reached'", new { id, steps, seconds });
            if (raised == 0) return Results.Conflict(new { error = "budget_not_reached" });
            await platform.Audit(user.Value.ToString(), "task.budget_raise", row.BotId, id, new { maxSteps = steps, maxSeconds = seconds });
            await Reliability.Event(platform, id, "budget_raised", new { maxSteps = steps, maxSeconds = seconds });
            platform.Tasks.Pulse();
            return Results.Json(new { ok = true });
        });
        app.MapGet("/api/tasks/{id:guid}/plan", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var task = await conn.QuerySingleOrDefaultAsync<(Guid BotId, string Title, string Status, bool? Required, DateTimeOffset? Passed, bool Override, bool? BotRequired, DateTimeOffset? Started, string Instruction, string? Blocked, Guid Owner, string Kind)>("SELECT t.bot_id,t.title,t.status,t.require_tests,t.tests_passed_at,t.tests_override,b.require_tests,t.started_at,t.instruction,t.blocked_reason,b.owner_id,t.kind FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE t.id=@id AND b.owner_id=@owner", new { id, owner = user });
            if (task.BotId == Guid.Empty) return Results.NotFound();
            var budgetRow = await conn.QuerySingleAsync<(int? Steps, int? Seconds, int? BotSteps, int? BotSeconds)>("SELECT t.budget_steps,t.budget_seconds,b.default_budget_steps,b.default_budget_seconds FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE t.id=@id", new { id });
            var budget = RunBudget.Resolve(budgetRow.Steps,budgetRow.Seconds,budgetRow.BotSteps,budgetRow.BotSeconds);
            var items = await conn.QueryAsync("SELECT position,title,status,updated_at AS \"updatedAt\" FROM task_plan_items WHERE task_id=@id ORDER BY position", new { id });
            var usage = await conn.QuerySingleAsync<(int Steps, double Elapsed)>("SELECT (SELECT count(*)::int FROM task_steps WHERE task_id=@id),coalesce(extract(epoch from now()-started_at),0)::float8 FROM tasks WHERE id=@id", new { id });
            var lengthBucket = task.Instruction.Length < 200 ? 0 : task.Instruction.Length < 800 ? 1 : 2;
            var durations = await conn.QueryAsync<double>("SELECT extract(epoch from finished_at-started_at)::float8 FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE b.owner_id=@owner AND t.kind=@kind AND t.status='completed' AND t.started_at IS NOT NULL AND t.finished_at IS NOT NULL AND CASE WHEN length(t.instruction)<200 THEN 0 WHEN length(t.instruction)<800 THEN 1 ELSE 2 END=@bucket ORDER BY t.finished_at DESC LIMIT 30", new { owner = task.Owner, kind = task.Kind, bucket = lengthBucket });
            var range = DurationEstimate.Range(durations.AsList());
            object? estimate = range is null ? null : new { low = range.Value.LowSeconds, high = range.Value.HighSeconds, n = range.Value.Count, label = "estimate" };
            var planPayload = new { taskId = id, title = task.Title, status = task.Status, items, budget = new { maxSteps = budget.MaxSteps, maxSeconds = budget.MaxSeconds, label = budget.Label }, stepsUsed = usage.Steps, elapsedSeconds = usage.Elapsed, tests = new { required = task.Required ?? task.BotRequired ?? false, passedAt = task.Passed, @override = task.Override }, blocked = task.Blocked != null, blockedReason = task.Blocked, estimate, evidence = Array.Empty<object>() };
            return Results.Json(planPayload);
        });
        app.MapGet("/api/tasks/{id:guid}/evidence", async (HttpContext ctx, Guid id, CancellationToken ct) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var owns = await conn.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE t.id=@id AND b.owner_id=@owner)", new { id, owner = user });
            if (!owns) return Results.NotFound();
            var rows = await conn.QueryAsync("SELECT a.id,a.name,a.mime,a.size_bytes AS bytes,a.created_at AS \"createdAt\" FROM artifacts a WHERE a.task_id=@id AND a.name LIKE 'evidence-%' ORDER BY a.created_at", new { id });
            return Results.Json(rows.Select(Platform.ToDict));
        });
        app.MapPost("/api/tasks/{id:guid}/override-tests", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var row = await conn.QuerySingleOrDefaultAsync<(Guid BotId,string Status,string? Reason)>("SELECT t.bot_id,t.status,t.waiting_reason FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE t.id=@id AND b.owner_id=@owner", new { id, owner=user });
            if (row.BotId==Guid.Empty) return Results.NotFound();
            await conn.ExecuteAsync("UPDATE tasks SET tests_override=true,status=CASE WHEN status='waiting_human' AND waiting_reason='tests_required' THEN 'queued' ELSE status END,waiting_reason=CASE WHEN waiting_reason='tests_required' THEN NULL ELSE waiting_reason END,lease_epoch=lease_epoch+1 WHERE id=@id", new { id });
            await platform.Audit("task", "tests.override", row.BotId, id, new { taskId=id });
            if (row.Status=="waiting_human" && row.Reason=="tests_required") platform.Tasks.Pulse();
            return Results.Json(new { ok=true });
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
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync("SELECT id, title, instruction, status, kind, model_calls, waiting_reason, error, error_code, result::text AS result, created_at FROM tasks WHERE bot_id=@id ORDER BY created_at DESC", new { id });
            return Results.Json(rows.Select(Platform.ToDict));
        });

        app.MapPost("/api/tasks/{id:guid}/cancel", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var attempt = await conn.QuerySingleOrDefaultAsync<(string? Checkpoint, int Number, int Steps, string? Worker)>("SELECT checkpoint::text,attempt,(SELECT count(*)::int FROM task_steps WHERE task_id=@id),lease_owner FROM tasks WHERE id=@id AND status='running'", new { id });
            var n = await conn.ExecuteAsync("UPDATE tasks SET status='cancelled', updated_at=now(), finished_at=now(), lease_owner=NULL,lease_until=NULL,lease_epoch=lease_epoch+1 FROM bots b WHERE tasks.id=@id AND tasks.bot_id=b.id AND b.owner_id=@owner", new { id, owner = user });
            if (n > 0)
            {
                if (attempt.Checkpoint != null)
                {
                    var ledger = TaskCheckpoint.Read(attempt.Checkpoint);
                    var start = DateTimeOffset.TryParse((string?)ledger["attemptStartedAt"], out var started) ? started : DateTimeOffset.UtcNow;
                    var progress = DateTimeOffset.TryParse((string?)ledger["lastProgressAt"], out var at) && at > start;
                    await AttemptLog.Record(conn, null, id, attempt.Number, start, DateTimeOffset.UtcNow, Math.Max(0, attempt.Steps - ((int?)ledger["attemptStepsAtStart"] ?? 0)), "cancelled", progress, attempt.Worker);
                }
                await platform.Audit(user.Value.ToString(), "task.cancelled", null, id, new { taskId = id });
                await Reliability.Event(platform, id, "task_stopped", new { reason = "cancelled" });
            }
            return n == 0 ? Results.NotFound() : Results.Json(new { ok = true });
        });

        app.MapPost("/api/tasks/{id:guid}/attention/resolve", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var n = await conn.ExecuteAsync("UPDATE tasks SET status='queued', waiting_reason=NULL, lease_owner=NULL, lease_until=NULL, lease_epoch=lease_epoch+1, updated_at=now() FROM bots b WHERE tasks.id=@id AND tasks.bot_id=b.id AND b.owner_id=@owner AND tasks.status='waiting_human' AND tasks.waiting_reason NOT IN ('budget_reached','no_progress','resume_exhausted')", new { id, owner = user });
            if (n > 0) platform.Tasks.Pulse();
            return Results.Json(new { ok = n > 0 });
        });

        app.MapGet("/api/approval-rules", async (HttpContext ctx) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync("""
                SELECT r.id, r.bot_id AS "botId", b.name AS "botName", r.action_class AS "actionClass", r.tool,
                       r.matcher::text AS matcher, r.created_at AS "createdAt", r.last_used_at AS "lastUsedAt", r.use_count AS "useCount"
                FROM approval_rules r LEFT JOIN bots b ON b.id=r.bot_id
                WHERE r.owner_id=@owner AND r.revoked_at IS NULL ORDER BY r.created_at DESC
                """, new { owner = user });
            var result = new List<Dictionary<string, object?>>();
            foreach (var row in rows)
            {
                var item = Platform.ToDict((object)row);
                if (item.TryGetValue("matcher", out object? raw) && raw is string json) item["matcher"] = JsonSerializer.Deserialize<JsonElement>(json);
                result.Add(item.ToDictionary(pair => pair.Key, pair => (object?)pair.Value, StringComparer.Ordinal));
            }
            return Results.Json(result);
        });

        app.MapPatch("/api/approval-rules/{id:guid}", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var existing = await conn.QuerySingleOrDefaultAsync<(string ActionClass, string Tool, string Matcher, Guid? BotId)>("SELECT action_class, tool, matcher::text, bot_id FROM approval_rules WHERE id=@id AND owner_id=@owner AND revoked_at IS NULL", new { id, owner = user });
            if (existing.Tool == null) return Results.NotFound();
            Guid? bot = existing.BotId;
            if (body.TryGetProperty("botId", out var botNode))
            {
                bot = botNode.ValueKind == JsonValueKind.String ? botNode.GetGuid() : null;
            }
            if (bot != null && !await conn.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM bots WHERE id=@bot AND owner_id=@owner)", new { bot, owner = user })) return Results.NotFound();
            var matcher = existing.Matcher;
            if (body.TryGetProperty("matcher", out var newMatcher) && newMatcher.ValueKind == JsonValueKind.Object)
            {
                matcher = newMatcher.GetRawText();
                if (!ApprovalRules.IsNarrowerOrEqual(existing.ActionClass, existing.Tool, existing.Matcher, matcher))
                    return Results.Json(new { error = "scope_must_be_narrower_or_equal" }, statusCode: 400);
            }
            if (!ApprovalRules.AllowedClass(existing.ActionClass, existing.Tool)) return Results.Json(new { error = "not_allowed_for_class" }, statusCode: 400);
            var n = await conn.ExecuteAsync("UPDATE approval_rules SET bot_id=@bot, matcher=@matcher::jsonb WHERE id=@id AND owner_id=@owner AND revoked_at IS NULL", new { bot, matcher, id, owner = user });
            if (n == 0) return Results.NotFound();
            await platform.Audit(user.Value.ToString(), "approval_rule.edited", null, null, new { id, actionClass = existing.ActionClass, tool = existing.Tool, changedScope = true, changedMatcher = matcher != existing.Matcher });
            return Results.Json(new { ok = true });
        });

        app.MapDelete("/api/approval-rules/{id:guid}", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var row = await conn.QuerySingleOrDefaultAsync<(string ActionClass, string Tool)>("UPDATE approval_rules SET revoked_at=now() WHERE id=@id AND owner_id=@owner AND revoked_at IS NULL RETURNING action_class, tool", new { id, owner = user });
            if (row.Tool == null) return Results.NotFound();
            await platform.Audit(user.Value.ToString(), "approval_rule.revoked", null, null, new { id, actionClass = row.ActionClass, tool = row.Tool });
            return Results.Json(new { ok = true });
        });

        app.MapPost("/api/approvals/{id:guid}/decide", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var decision = body.GetProperty("decision").GetString();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var approval = await conn.QuerySingleOrDefaultAsync<(Guid? TaskId, Guid BotId, string Action, string RiskClass, string Proposed)>("SELECT a.task_id, a.bot_id, a.action, a.risk_class, a.proposed::text FROM approvals a JOIN bots b ON b.id=a.bot_id WHERE a.id=@id AND b.owner_id=@owner AND a.status='pending'", new { id, owner = user });
            var taskId = approval.TaskId;
            if (taskId == null) return Results.NotFound();
            if (decision is "allow_once" or "allow_domain" or "allow_always")
            {
                if (decision == "allow_always")
                {
                    if (!ApprovalRules.AllowedClass(approval.RiskClass, approval.Action))
                        return Results.Json(new { error = "not_allowed_for_class" }, statusCode: 400);
                    if (string.IsNullOrWhiteSpace(approval.Proposed)) return Results.Json(new { error = "not_allowed_for_class" }, statusCode: 400);
                    var peer = await conn.ExecuteScalarAsync<bool>("SELECT (origin_thread_id IS NOT NULL OR origin_depth > 0 OR kind IN ('peer','peer_reply','peer_notice')) FROM tasks WHERE id=@task", new { task = taskId });
                    if (peer) return Results.Json(new { error = "not_allowed_for_class" }, statusCode: 400);
                    JsonDocument proposed;
                    try { proposed = JsonDocument.Parse(approval.Proposed); }
                    catch (JsonException) { return Results.Json(new { error = "not_allowed_for_class" }, statusCode: 400); }
                    using (proposed)
                    {
                    var taskInstruction = await conn.ExecuteScalarAsync<string>("SELECT instruction FROM tasks WHERE id=@task", new { task = taskId }) ?? "";
                    if (HardDeny.Match(approval.Action, approval.Action + " " + proposed.RootElement.GetRawText(), await SecurityRoutes.DenyRules(platform)) != null ||
                        Dlp.AssessArgs(approval.Action, proposed.RootElement, taskInstruction, approval.RiskClass).Block)
                        return Results.Json(new { error = "not_allowed_for_class" }, statusCode: 400);
                    var built = ApprovalRules.Build(approval.RiskClass, approval.Action, proposed.RootElement);
                    if (built == null) return Results.Json(new { error = "not_allowed_for_class" }, statusCode: 400);
                    var ruleId = await conn.ExecuteScalarAsync<Guid>("INSERT INTO approval_rules(owner_id,bot_id,action_class,tool,matcher,created_from_approval_id) VALUES(@owner,@bot,@class,@tool,@matcher::jsonb,@approval) RETURNING id", new { owner = user, bot = approval.BotId, @class = built.Value.Class, tool = built.Value.Tool, matcher = built.Value.Matcher, approval = id });
                    await platform.Audit(user.Value.ToString(), "approval_rule.created", approval.BotId, taskId, new { id = ruleId, actionClass = approval.RiskClass, tool = approval.Action, scope = Dlp.Redact(built.Value.Display) });
                    }
                }
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
                var resumed = await conn.ExecuteAsync("UPDATE tasks SET status='queued', waiting_reason=NULL, lease_owner=NULL, lease_until=NULL, resume_after=NULL, lease_epoch=lease_epoch+1, updated_at=now() WHERE id=@id AND status IN ('waiting_approval','queued','running')", new { id = taskId });
                if (resumed > 0)
                {
                    await platform.Audit(user.Value.ToString(), "task.resumed", null, taskId, new { source = "approval", approvalId = id });
                    await Reliability.Event(platform, taskId.Value, "resumed", new { reason = "approval", source = "approval" });
                    platform.Tasks.Pulse();
                }
                await platform.Audit(user.Value.ToString(), "approval.allowed", null, taskId, new { decision = decision == "allow_always" ? "always_narrow" : decision });
            }
            else if (decision == "deny")
            {
                await conn.ExecuteAsync("UPDATE approvals SET status='denied', decided_at=now() WHERE id=@id", new { id });
                await conn.ExecuteAsync("UPDATE tasks SET status='failed', error_code='denied', error='The requested action was denied.', finished_at=now(), updated_at=now() WHERE id=@id", new { id = taskId });
                await platform.Audit(user.Value.ToString(), "approval.denied", null, taskId, new { decision = "deny" });
                await Reliability.Event(platform, taskId.Value, "error", new { error_code = "denied", error = "The requested action was denied." });
            }
            else
            {
                return Results.BadRequest(new { error = "decision required" });
            }
            try { await BotMessaging.OnApprovalDecided(platform, taskId.Value, decision != "deny"); }
            catch (Exception) { /* thread note is best effort */ }
            return Results.Json(new { ok = true });
        });

        app.MapPost("/api/bots/{id:guid}/computer/view-token", (HttpContext ctx, Guid id, CancellationToken ct) => Desktop(ctx, platform, id, false, ct));
        app.MapPost("/api/bots/{id:guid}/computer/take-control", (HttpContext ctx, Guid id, CancellationToken ct) => Desktop(ctx, platform, id, true, ct));
        app.MapPost("/api/bots/{id:guid}/computer/hand-back", async (HttpContext ctx, Guid id, CancellationToken ct) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            if (!ctx.Request.HasJsonContentType()) return Results.BadRequest(new { error = "desktop tab required" });
            JsonElement request;
            try
            {
                request = await ctx.Request.ReadFromJsonAsync<JsonElement>(ct);
            }
            catch (System.Text.Json.JsonException)
            {
                return Results.BadRequest(new { error = "desktop tab required" });
            }
            var tabId = request.ValueKind == JsonValueKind.Object && request.TryGetProperty("tabId", out var tab) ? tab.GetString() : null;
            var expectedEpoch = request.ValueKind == JsonValueKind.Object && request.TryGetProperty("epoch", out var ep) && ep.TryGetInt64(out var parsed) ? parsed : -1;
            if (string.IsNullOrWhiteSpace(tabId) || tabId.Length > 128) return Results.BadRequest(new { error = "desktop tab required" });
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var placement = await platform.PlacementForBot(id, ct);
            if (!Guid.TryParse(placement.Computer.Value, out var computerId)) return Results.Conflict(new { error = "computer unavailable" });
            var row = await DesktopLeaseRepository.ReleaseAsync(conn, computerId, 1, user.Value, tabId, expectedEpoch, ct);
            if (row == null) return Results.Conflict(new { error = "lease changed" });
            var epoch = row.Epoch;
            await VncTicketStore.InvalidateLeaseAsync(platform, id, epoch, ct);
            await conn.ExecuteAsync("UPDATE control_locks SET holder='agent', epoch=@epoch, updated_at=now() WHERE bot_id=@id", new { id, epoch });
            await platform.Compute.SetHolderAsync(placement.Computer, "fenced", (ulong)epoch, ct);
            await conn.ExecuteAsync("UPDATE tasks SET waiting_reason='await_continue', lease_owner=NULL, lease_until=NULL, updated_at=now() WHERE bot_id IN (SELECT id FROM bots WHERE owner_id=@owner) AND status='waiting_human' AND waiting_reason IN ('takeover', 'captcha_or_mfa', 'You''re in control — tell me when to continue')", new { owner = user.Value });
            await platform.Audit(user.Value.ToString(), "desktop.lease.release", id, null, new { });
            await platform.Publish(new { type = "computer.mode", botId = id, mode = "watching" });
            return Results.Json(new { ok = true, epoch, continueRequired = true });
        });

        app.MapPost("/api/computers/{id:guid}/continue", async (HttpContext ctx, Guid id, CancellationToken ct) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var placement = await platform.PlacementForBot(id, ct);
            if (!Guid.TryParse(placement.Computer.Value, out var computerId)) return Results.Conflict(new { error = "computer unavailable" });
            var current = await DesktopLeaseRepository.StateAsync(conn, computerId, 1, ct);
            if (current == null) return Results.Conflict(new { error = "lease missing" });
            var agentEpoch = current.HolderKind == "agent" && current.ExpiresAt > DateTime.UtcNow
                ? current.Epoch
                : (await DesktopLeaseRepository.ResumeAgentAsync(conn, computerId, 1, user.Value, current.Epoch, ct))?.Epoch;
            if (agentEpoch == null) return Results.Conflict(new { error = "lease changed" });
            await conn.ExecuteAsync("UPDATE control_locks SET holder='agent', epoch=@epoch, updated_at=now() WHERE bot_id=@id", new { id, epoch = agentEpoch.Value });
            await platform.Compute.SetHolderAsync(placement.Computer, "agent", (ulong)agentEpoch.Value, ct);
            var resumed = await conn.ExecuteAsync("UPDATE tasks SET status='queued', waiting_reason=NULL, lease_epoch=lease_epoch+1, updated_at=now() WHERE bot_id IN (SELECT id FROM bots WHERE owner_id=@owner) AND status='waiting_human' AND waiting_reason='await_continue'", new { owner = user.Value });
            await platform.Audit(user.Value.ToString(), "desktop.lease.continue", id, null, new { resumed });
            if (resumed > 0) platform.Tasks.Pulse();
            return Results.Json(new { ok = true, resumed });
        });

        app.MapPost("/api/bots/{id:guid}/computer/human-input", async (HttpContext ctx, Guid id, JsonElement body, CancellationToken ct) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var tabId = body.TryGetProperty("tabId", out var tab) ? tab.GetString() : null;
            var epoch = body.TryGetProperty("epoch", out var epochValue) && epochValue.TryGetInt64(out var parsedEpoch) ? parsedEpoch : -1;
            if (string.IsNullOrWhiteSpace(tabId)) return Results.Json(new { error = "human control is not held" }, statusCode: 403);
            var placement = await platform.PlacementForBot(id, ct);
            if (!Guid.TryParse(placement.Computer.Value, out var computerId)) return Results.Conflict(new { error = "computer unavailable" });
            var lease = await DesktopLeaseRepository.StateAsync(conn, computerId, 1, ct);
            var dbNow = await DbClock.NowAsync(conn, ct);
            if (!DesktopLeaseRepository.IsActiveFor(lease, user.Value, tabId, epoch, dbNow)) return Results.Json(new { error = "human control is not held" }, statusCode: 403);
            var selector = body.TryGetProperty("selector", out var sel) ? sel.GetString() : "#human-check";
            var target = body.TryGetProperty("targetId", out var tid) ? tid.GetString() : "";
            var json = await platform.Compute.ControlAsync(placement.Computer, $"/desktops/{placement.Desktop}/human-input", JsonSerializer.Serialize(new { selector, targetId = target, epoch }), ct);
            return Results.Text(json, "application/json");
        });

        app.MapGet("/api/bots/{id:guid}/files", async (HttpContext ctx, Guid id, string? path, CancellationToken ct) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            var folder = string.IsNullOrWhiteSpace(path) ? "/workspace" : path;
            var placement = await platform.PlacementForBot(id, ct);
            var (code, stdout, _) = await runtime.Run(placement.Computer, id, ["python3", "-c", BotFs.Script("list_dir(sys.argv[1])"), folder], null, ct);
            var entries = code == 0 && !string.IsNullOrWhiteSpace(stdout) ? stdout.Trim() : "[]";
            return Results.Text("{\"path\":" + JsonSerializer.Serialize(folder) + ",\"entries\":" + entries + "}", "application/json");
        });

        app.MapPut("/api/bots/{id:guid}/files", async (HttpContext ctx, Guid id, CancellationToken ct) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            var path = ctx.Request.Headers["x-path"].ToString();
            if (string.IsNullOrWhiteSpace(path)) path = "/workspace/upload.bin";
            if (!BotFileTransfer.IsSafePathHeader(path)) return Results.BadRequest(new { error = "invalid_path" });
            byte[] bytes;
            try { bytes = await BotFileTransfer.ReadBoundedAsync(ctx.Request.Body, BotFileTransfer.MaximumBytes, ct); }
            catch (FileTransferTooLargeException) { return Results.StatusCode(StatusCodes.Status413PayloadTooLarge); }
            var b64 = Convert.ToBase64String(bytes);
            var placement = await platform.PlacementForBot(id, ct);
            var (code, _, _) = await runtime.Run(placement.Computer, id, ["python3", "-c", BotFs.Script(ctx.Request.Headers["x-append"] == "1" ? "append_b64(sys.argv[1], sys.argv[2])" : "write_b64(sys.argv[1], sys.argv[2])"), path, b64], null, ct);
            if (code != 0) return Results.Json(new { error = code == 4 ? "path_escapes_workspace" : "write_failed" }, statusCode: code == 4 ? 400 : 500);
            return Results.Json(new { ok = true, path, size = bytes.Length, contentType = BotFileTransfer.SniffContentType(path, bytes) });
        });

        app.MapGet("/api/bots/{id:guid}/files/raw", async (HttpContext ctx, Guid id, string path, CancellationToken ct) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            if (!BotFileTransfer.IsSafePathHeader(path)) return Results.BadRequest(new { error = "invalid_path" });
            var placement = await platform.PlacementForBot(id, ct);
            var (code, stdout, _) = await runtime.Run(placement.Computer, id, ["python3", "-c", BotFs.Script("read_b64(sys.argv[1])"), path], null, ct);
            if (code != 0 || string.IsNullOrWhiteSpace(stdout)) return Results.NotFound();
            byte[] bytes;
            try { bytes = Convert.FromBase64String(stdout.Trim()); }
            catch (FormatException) { return Results.StatusCode(StatusCodes.Status502BadGateway); }
            if (bytes.LongLength > BotFileTransfer.MaximumBytes) return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
            var content = BotFileTransfer.SniffContentType(path, bytes);
            if (content.StartsWith("text/", StringComparison.Ordinal) && BotFileTransfer.BlockedByDlp(System.Text.Encoding.UTF8.GetString(bytes)))
                return Results.Json(new { error = Dlp.Blocked }, statusCode: StatusCodes.Status403Forbidden);
            return Results.File(bytes, content, Path.GetFileName(path));
        });

        app.MapGet("/api/bots/{id:guid}/memories", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var limit = int.TryParse(ctx.Request.Query["limit"], out var requested) ? Math.Clamp(requested, 1, 100) : 50;
            var kind = ctx.Request.Query["kind"].ToString();
            var status = ctx.Request.Query["status"].ToString();
            var visibility = ctx.Request.Query["visibility"].ToString();
            var query = ctx.Request.Query["q"].ToString();
            var cursor = Guid.TryParse(ctx.Request.Query["cursor"], out var parsedCursor) ? parsedCursor : (Guid?)null;
            var rows = (await conn.QueryAsync("""
                SELECT id, bot_id, content, source, kind, visibility, status, author, sensitive, pinned,
                       source_message_id, source_task_id, supersedes_id, created_at, updated_at, last_confirmed_at, deleted_at
                FROM memories WHERE owner_id=@owner AND (bot_id=@id OR visibility='owner')
                  AND status IN ('active','pending') AND deleted_at IS NULL
                  AND (@kind='' OR kind=@kind) AND (@status='' OR status=@status)
                  AND (@visibility='' OR visibility=@visibility) AND (@q='' OR content ILIKE @contains)
                  AND (@cursor::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM memories WHERE id=@cursor))
                ORDER BY created_at DESC,id DESC LIMIT @limitPlusOne
                """, new { owner = user, id, kind, status, visibility, q = query, contains = "%" + query + "%", cursor, limitPlusOne = limit + 1 })).ToList();
            var next = rows.Count > limit ? rows[limit - 1].id.ToString() : null;
            if (rows.Count > limit) rows.RemoveAt(limit);
            var counts = await conn.QuerySingleAsync("""
                SELECT count(*) FILTER(WHERE kind='profile') profile, count(*) FILTER(WHERE kind='journal') journal,
                       count(*) FILTER(WHERE kind='rule') rule, count(*) FILTER(WHERE kind='fact') fact,
                       count(*) FILTER(WHERE status='pending') pending, count(*) total
                FROM memories WHERE owner_id=@owner AND (bot_id=@id OR visibility='owner') AND status IN ('active','pending')
                """, new { owner = user, id });
            return Results.Json(new { items = rows.Select(Platform.ToDict), nextCursor = next, counts = Platform.ToDict(counts) });
        });

        app.MapPost("/api/bots/{id:guid}/memories", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            if (!MemoryWriteLimits.Allow(user.Value)) return Results.StatusCode(429);
            var content = body.TryGetProperty("content", out var contentEl) ? contentEl.GetString() ?? "" : "";
            var kind = body.TryGetProperty("kind", out var kindEl) ? kindEl.GetString() ?? "profile" : "profile";
            var visibility = body.TryGetProperty("visibility", out var visibilityEl) ? visibilityEl.GetString() ?? "" : "";
            var ruleScope = body.TryGetProperty("scope", out var scopeEl) && scopeEl.ValueKind == JsonValueKind.String ? scopeEl.GetString() : null;
            var result = await new MemoryStore(platform).Save(id, user.Value, null, content, kind, "user", visibility, content, explicitRequest: true, maxChars: 1000, notice: false, ruleScope: ruleScope);
            var encoded = JsonSerializer.SerializeToElement(result);
            if (encoded.TryGetProperty("saved", out var saved) && saved.ValueKind == JsonValueKind.True || encoded.TryGetProperty("duplicate", out var duplicate) && duplicate.ValueKind == JsonValueKind.True) return Results.Json(result);
            return Results.Json(new { error = encoded.TryGetProperty("reason", out var reason) ? reason.GetString() : "not_saved" }, statusCode: 400);
        });

        app.MapPatch("/api/bots/{id:guid}/memories/{mid:guid}", async (HttpContext ctx, Guid id, Guid mid, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            if (!MemoryWriteLimits.Allow(user.Value)) return Results.StatusCode(429);
            await using var conn = await platform.Data.OpenConnectionAsync();
            var row = await conn.QuerySingleOrDefaultAsync<(string Content, string Kind, string Visibility, string Status, Guid? ConversationId, string? Scope)>("SELECT content,kind,visibility,status,conversation_id, rule_scope AS scope FROM memories WHERE id=@mid AND bot_id=@id AND owner_id=@owner", new { mid, id, owner = user });
            if (row.Content == null || row.Status is "deleted" or "superseded") return Results.NotFound();
            if (body.TryGetProperty("content", out var contentEl))
            {
                var content = contentEl.GetString() ?? "";
                var kind = body.TryGetProperty("kind", out var kindEl) ? kindEl.GetString() ?? row.Kind : row.Kind;
                var visibility = body.TryGetProperty("visibility", out var visibilityEl) ? visibilityEl.GetString() ?? row.Visibility : row.Visibility;
                var result = await new MemoryStore(platform).Save(id, user.Value, null, content, kind, "user", visibility, content, explicitRequest: true, maxChars: 1000, supersedesId: mid, notice: false, conversationId: row.ConversationId, ruleScope: row.Scope);
                var encoded = JsonSerializer.SerializeToElement(result);
                if ((!encoded.TryGetProperty("saved", out var saved) || saved.ValueKind != JsonValueKind.True) && (!encoded.TryGetProperty("duplicate", out var duplicate) || duplicate.ValueKind != JsonValueKind.True))
                    return Results.Json(new { error = encoded.TryGetProperty("reason", out var reason) ? reason.GetString() : "not_saved" }, statusCode: 400);
                return Results.Json(result);
            }
            if (body.TryGetProperty("pinned", out var pinned)) await conn.ExecuteAsync("UPDATE memories SET pinned=@value WHERE id=@mid AND bot_id=@id AND owner_id=@owner", new { value = pinned.GetBoolean(), mid, id, owner = user });
            if (body.TryGetProperty("visibility", out var visibilityOnly))
            {
                var visibility = visibilityOnly.GetString() ?? "bot";
                if (row.Kind == "rule") visibility = "bot";
                if (visibility is not ("bot" or "owner")) return Results.BadRequest(new { error = "invalid_visibility" });
                if (visibility == "owner" && row.Kind != "profile") visibility = "bot";
                var sharing = await conn.ExecuteScalarAsync<bool?>("SELECT share_owner FROM bot_memory_settings WHERE bot_id=@id", new { id });
                if (visibility == "owner" && sharing == false) visibility = "bot";
                await conn.ExecuteAsync("UPDATE memories SET visibility=@visibility WHERE id=@mid AND bot_id=@id AND owner_id=@owner", new { visibility, mid, id, owner = user });
                await platform.Audit("memory", "memory.visibility_changed", id, null, new { memoryId = mid, visibility });
            }
            var updated = await conn.QuerySingleAsync("SELECT id,content,kind,visibility,status,pinned,updated_at FROM memories WHERE id=@mid", new { mid });
            return Results.Json(Platform.ToDict(updated));
        });

        app.MapDelete("/api/bots/{id:guid}/memories/{mid:guid}", async (HttpContext ctx, Guid id, Guid mid) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            if (!MemoryWriteLimits.Allow(user.Value)) return Results.StatusCode(429);
            await using var conn = await platform.Data.OpenConnectionAsync();
            var row = await conn.QuerySingleOrDefaultAsync<(string Kind, string Hash)>("UPDATE memories SET status='deleted',deleted_at=now() WHERE id=@mid AND bot_id=@id AND owner_id=@owner AND status IN ('active','pending') RETURNING kind,content_hash", new { mid, id, owner = user });
            if (row.Kind == null) return Results.NotFound();
            await conn.ExecuteAsync("INSERT INTO memory_events(memory_id,bot_id,owner_id,actor,action,before_hash) VALUES(@mid,@id,@owner,'user','delete',@hash)", new { mid, id, owner = user, hash = row.Hash });
            await platform.Audit("memory", "memory.deleted", id, null, new { id = mid, kind = row.Kind, hash = row.Hash });
            return Results.Json(new { ok = true, id = mid, undoUntil = DateTimeOffset.UtcNow.AddMinutes(10) });
        });

        app.MapPost("/api/bots/{id:guid}/memories/{mid:guid}/restore", async (HttpContext ctx, Guid id, Guid mid) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            if (!MemoryWriteLimits.Allow(user.Value)) return Results.StatusCode(429);
            await using var conn = await platform.Data.OpenConnectionAsync();
            var restored = await conn.ExecuteAsync("UPDATE memories SET status='active',deleted_at=NULL WHERE id=@mid AND bot_id=@id AND owner_id=@owner AND status='deleted' AND deleted_at>now()-interval '10 minutes'", new { mid, id, owner = user });
            if (restored == 0) return Results.NotFound();
            await conn.ExecuteAsync("INSERT INTO memory_events(memory_id,bot_id,owner_id,actor,action) VALUES(@mid,@id,@owner,'user','restore')", new { mid, id, owner = user });
            return Results.Json(new { ok = true, id = mid });
        });

        app.MapPost("/api/bots/{id:guid}/memories/{mid:guid}/accept", async (HttpContext ctx, Guid id, Guid mid) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            if (!MemoryWriteLimits.Allow(user.Value)) return Results.StatusCode(429);
            await using var conn = await platform.Data.OpenConnectionAsync();
            var changed = await conn.ExecuteAsync("UPDATE memories SET status='active',author='user',last_confirmed_at=now() WHERE id=@mid AND bot_id=@id AND owner_id=@owner AND status='pending'", new { mid, id, owner = user });
            if (changed == 0) return Results.NotFound();
            await conn.ExecuteAsync("INSERT INTO memory_events(memory_id,bot_id,owner_id,actor,action) VALUES(@mid,@id,@owner,'user','accept')", new { mid, id, owner = user });
            return Results.Json(new { ok = true, id = mid });
        });

        app.MapPost("/api/bots/{id:guid}/memories/{mid:guid}/dismiss", async (HttpContext ctx, Guid id, Guid mid) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            if (!MemoryWriteLimits.Allow(user.Value)) return Results.StatusCode(429);
            await using var conn = await platform.Data.OpenConnectionAsync();
            var changed = await conn.ExecuteAsync("UPDATE memories SET status='deleted',deleted_at=now() WHERE id=@mid AND bot_id=@id AND owner_id=@owner AND status='pending'", new { mid, id, owner = user });
            if (changed == 0) return Results.NotFound();
            await conn.ExecuteAsync("INSERT INTO memory_events(memory_id,bot_id,owner_id,actor,action) VALUES(@mid,@id,@owner,'user','dismiss')", new { mid, id, owner = user });
            return Results.Json(new { ok = true, id = mid });
        });

        app.MapGet("/api/bots/{id:guid}/memories/{mid:guid}/history", async (HttpContext ctx, Guid id, Guid mid) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync("SELECT m.id,m.content,m.kind,m.status,m.author,m.created_at,e.at,e.action,e.before_hash,e.after_hash FROM memories m LEFT JOIN memory_events e ON e.memory_id=m.id WHERE m.id=@mid AND m.bot_id=@id AND m.owner_id=@owner ORDER BY e.at", new { mid, id, owner = user });
            return Results.Json(rows.Select(Platform.ToDict));
        });

        app.MapGet("/api/bots/{id:guid}/memory-settings", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var settings = await conn.QuerySingleOrDefaultAsync<(string Mode, bool ShareOwner)>("SELECT mode,share_owner FROM bot_memory_settings WHERE bot_id=@id", new { id });
            return Results.Json(new { mode = settings.Mode ?? "auto", shareOwner = settings.Mode == null || settings.ShareOwner });
        });

        app.MapPut("/api/bots/{id:guid}/memory-settings", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            if (!MemoryWriteLimits.Allow(user.Value)) return Results.StatusCode(429);
            var mode = body.TryGetProperty("mode", out var modeEl) ? modeEl.GetString() ?? "auto" : "auto";
            if (mode is not ("auto" or "ask" or "off")) return Results.BadRequest(new { error = "invalid_mode" });
            var shareOwner = !body.TryGetProperty("shareOwner", out var shareEl) || shareEl.GetBoolean();
            await using var conn = await platform.Data.OpenConnectionAsync();
            await conn.ExecuteAsync("INSERT INTO bot_memory_settings(bot_id,mode,share_owner) VALUES(@id,@mode,@share) ON CONFLICT(bot_id) DO UPDATE SET mode=EXCLUDED.mode,share_owner=EXCLUDED.share_owner,updated_at=now()", new { id, mode, share = shareOwner });
            await platform.Audit("memory", "memory.settings_changed", id, null, new { mode, shareOwner });
            return Results.Json(new { mode, shareOwner });
        });

        app.MapGet("/api/bots/{id:guid}/memories/export", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync("SELECT id,content,kind,visibility,status,author,sensitive,pinned,created_at,updated_at FROM memories WHERE owner_id=@owner AND (bot_id=@id OR visibility='owner') AND status IN ('active','pending') ORDER BY created_at", new { owner = user, id });
            await platform.Audit("memory", "memory.exported", id, null, new { count = rows.Count() });
            return Results.Json(new { items = rows.Select(Platform.ToDict) });
        });

        app.MapPost("/api/bots/{id:guid}/memories/forget-all", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            if (!MemoryWriteLimits.Allow(user.Value)) return Results.StatusCode(429);
            if (!body.TryGetProperty("confirm", out var confirm) || confirm.GetString() != "forget all") return Results.BadRequest(new { error = "confirmation_required" });
            await using var conn = await platform.Data.OpenConnectionAsync();
            var count = await conn.ExecuteAsync("""
                WITH deleted AS (
                    UPDATE memories SET status='deleted',deleted_at=now()
                    WHERE bot_id=@id AND owner_id=@owner AND status IN ('active','pending')
                    RETURNING id,bot_id,owner_id,content_hash
                )
                INSERT INTO memory_events(memory_id,bot_id,owner_id,actor,action,before_hash)
                SELECT id,bot_id,owner_id,'user','forget_all',content_hash FROM deleted
                """, new { id, owner = user });
            await platform.Audit("memory", "memory.forget_all", id, null, new { count });
            return Results.Json(new { ok = true, count });
        });

        app.MapPost("/api/bots/{id:guid}/memories/undo-task", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            if (!MemoryWriteLimits.Allow(user.Value)) return Results.StatusCode(429);
            if (!body.TryGetProperty("taskId", out var taskEl) || !Guid.TryParse(taskEl.GetString(), out var taskId)) return Results.BadRequest(new { error = "invalid_task" });
            await using var conn = await platform.Data.OpenConnectionAsync();
            await using var tx = await conn.BeginTransactionAsync();
            var created = await conn.QueryAsync<(Guid Id, Guid? SupersedesId, string Hash)>("SELECT id,supersedes_id,content_hash FROM memories WHERE bot_id=@id AND owner_id=@owner AND source_task_id=@task AND status IN ('active','pending') AND created_at>now()-interval '10 minutes' FOR UPDATE", new { id, owner = user, task = taskId }, tx);
            foreach (var item in created)
            {
                await conn.ExecuteAsync("UPDATE memories SET status='deleted',deleted_at=now() WHERE id=@id", new { id = item.Id }, tx);
                if (item.SupersedesId is { } previous)
                    await conn.ExecuteAsync("UPDATE memories SET status='active',deleted_at=NULL WHERE id=@id AND bot_id=@bot AND owner_id=@owner AND status='superseded'", new { id = previous, bot = id, owner = user }, tx);
                await conn.ExecuteAsync("INSERT INTO memory_events(memory_id,bot_id,owner_id,actor,action,before_hash) VALUES(@memory,@bot,@owner,'user','undo_task',@hash)", new { memory = item.Id, bot = id, owner = user, hash = item.Hash }, tx);
            }
            await tx.CommitAsync();
            await platform.Audit("memory", "memory.undo_task", id, taskId, new { count = created.Count() });
            return Results.Json(new { ok = true, count = created.Count() });
        });

        app.MapPost("/api/bots/{id:guid}/skills/from-task", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
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
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
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

        static string? Str(JsonElement body, string name) =>
            body.ValueKind == JsonValueKind.Object && body.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.String ? el.GetString() : null;
        static DateTimeOffset? When(JsonElement body, string name) =>
            Str(body, name) is { } text && DateTimeOffset.TryParse(text, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal, out var parsed) ? parsed : null;
        static RoutineSpec SpecOf(JsonElement body) => new(
            Str(body, "name"), Str(body, "instruction"), Str(body, "cron"), When(body, "runAt"), Str(body, "timezone"), When(body, "expiresAt"),
            Str(body, "quietRule"), body.ValueKind == JsonValueKind.Object && body.TryGetProperty("exact", out var exact) && exact.ValueKind == JsonValueKind.True, Str(body, "watchKind"), Str(body, "watchRef"));
        static IResult Refused(RoutineOutcome outcome) =>
            Results.Json(new { error = outcome.Error, message = RoutineService.Sentence(outcome.Error ?? "") }, statusCode: outcome.Error == "routine_not_found" ? 404 : 400);

        app.MapGet("/api/bots/{id:guid}/routines", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            await using var conn = await platform.Data.OpenConnectionAsync();
            return Results.Json(await RoutineService.List(conn, id));
        });

        app.MapPost("/api/bots/{id:guid}/routines", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null || !await Owns(platform, user.Value, id)) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var spec = SpecOf(body);
            var outcome = await RoutineService.Create(conn, id, user.Value, spec with { Name = spec.Name ?? "Routine" });
            if (!outcome.Ok) return Refused(outcome);
            var shaped = outcome.Data!;
            return Results.Json(new { id = outcome.Id, nextRunAt = shaped.GetType().GetProperty("nextRunAt")?.GetValue(shaped), routine = shaped });
        });

        app.MapGet("/api/routines/{id:guid}", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var outcome = await RoutineService.Get(conn, id, user.Value);
            return outcome.Ok ? Results.Json(outcome.Data) : Refused(outcome);
        });

        app.MapPost("/api/routines/{id:guid}/test", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var owner = await conn.ExecuteScalarAsync<bool?>("SELECT true FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=@id AND b.owner_id=@owner", new { id, owner = user.Value });
            if (owner != true) return Results.NotFound();
            if (await conn.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM tasks WHERE routine_id=@id AND status IN ('queued','running','planning','waiting_approval','waiting_human')) OR EXISTS(SELECT 1 FROM routine_runs WHERE routine_id=@id AND status IN ('queued','running'))", new { id }))
                return Results.Json(new { error = "routine_busy" }, statusCode: 409);
            await conn.ExecuteAsync("UPDATE routines SET force_once=true, next_run_at=now(), nominal_next_at=now() WHERE id=@id", new { id });
            await platform.Audit("user", "routine.test", null, null, new { routine = id });
            return Results.Json(new { ok = true });
        });

        app.MapDelete("/api/routines/{id:guid}", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var outcome = await RoutineService.Delete(conn, id, user.Value);
            if (outcome.Ok) await platform.Audit("user", "routine.delete", null, null, new { routine = id });
            return outcome.Ok ? Results.Json(new { ok = true }) : Refused(outcome);
        });

        app.MapPatch("/api/routines/{id:guid}", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            if (body.TryGetProperty("nextRunAt", out var next))
                await conn.ExecuteAsync("UPDATE routines SET next_run_at=@next, nominal_next_at=GREATEST(@next, now() - interval '1 minute') FROM bots b WHERE routines.id=@id AND routines.bot_id=b.id AND b.owner_id=@owner", new { id, owner = user, next = next.GetDateTimeOffset() });
            if (body.TryGetProperty("enabled", out var enabledEl) && enabledEl.ValueKind is JsonValueKind.True or JsonValueKind.False)
            {
                var enabled = enabledEl.GetBoolean();
                var outcome = await RoutineService.SetEnabled(conn, id, user.Value, enabled);
                if (!outcome.Ok) return Refused(outcome);
                var shaped = outcome.Data!;
                return Results.Json(new { ok = true, enabled, nextRunAt = shaped.GetType().GetProperty("nextRunAt")?.GetValue(shaped) });
            }
            var spec = SpecOf(body);
            if (spec.Name != null || spec.Instruction != null || spec.Cron != null || spec.RunAt != null || spec.Timezone != null || spec.QuietRule != null || spec.ExpiresAt != null)
            {
                var outcome = await RoutineService.Update(conn, id, user.Value, spec);
                return outcome.Ok ? Results.Json(new { ok = true, routine = outcome.Data }) : Refused(outcome);
            }
            return Results.Json(new { ok = true });
        });

        app.MapGet("/api/bots/{id:guid}/artifacts", async (HttpContext ctx, Guid id) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Owns(platform, user.Value, id)) return Results.NotFound();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync("SELECT id, name, mime, size_bytes, created_at FROM artifacts WHERE bot_id=@id ORDER BY created_at DESC", new { id });
            return Results.Json(rows.Select(Platform.ToDict));
        });

        app.MapGet("/api/artifacts/{id:guid}/download", async (HttpContext ctx, Guid id, CancellationToken ct) =>
        {
            var user = await RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var row = await conn.QuerySingleOrDefaultAsync<(string Name, string Key, string Mime)>("SELECT a.name, a.object_key, a.mime FROM artifacts a JOIN bots b ON b.id=a.bot_id WHERE (a.id=@id OR EXISTS (SELECT 1 FROM library_items li WHERE li.id=@id AND li.artifact_id=a.id AND li.deleted_at IS NULL)) AND b.owner_id=@owner ORDER BY (a.id=@id) DESC LIMIT 1", new { id, owner = user });
            if (string.IsNullOrEmpty(row.Key)) return Results.NotFound();
            using var obj = await platform.S3.GetObjectAsync(platform.Bucket, row.Key, ct);
            using var memory = new MemoryStream();
            await obj.ResponseStream.CopyToAsync(memory, ct);
            return Results.File(memory.ToArray(), string.IsNullOrWhiteSpace(row.Mime) ? "application/octet-stream" : row.Mime, row.Name, enableRangeProcessing: row.Mime?.StartsWith("video/", StringComparison.OrdinalIgnoreCase) == true);
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
        TerminalTickets.Map(app, platform);
        PluginModel.Map(app, platform);
        PluginCatalog.Map(app, platform);
        Beta.Map(app, platform);
        Templates.Map(app, platform);
        CodingItems.Map(app, platform);
        MapInternal(app, platform, runtime);
        Reliability.MapComputerDoctor(app, platform);
        ComputerWindows.Map(app, platform);

        app.Map("/vnc/websockify", async (HttpContext ctx) =>
        {
            if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = 400; return; }
            var token = ctx.Request.Query["token"].ToString();
            if (!Guid.TryParse(ctx.Request.Query["window"], out var windowId)) { ctx.Response.StatusCode = 401; return; }
            var user = await RequireUser(ctx, platform);
            var ipHash = VncTicketStore.ClientIpHash(platform.MasterKey, ctx.Connection.RemoteIpAddress);
            var consumed = await VncTicketStore.ConsumeAsync(platform, token, windowId, user ?? Guid.Empty, ipHash, ctx.RequestAborted);
            var ticket = consumed.Ticket;
            if (ticket == null) { ctx.Response.StatusCode = consumed.FailureStatus; return; }
            var endpoint = ticket.Endpoint;
            if (ticket.Role == "control")
            {
                await using var leaseConn = await platform.Data.OpenConnectionAsync(ctx.RequestAborted);
                var lease = await DesktopLeaseRepository.StateAsync(leaseConn, ticket.LeaseId, 1, ctx.RequestAborted);
                var dbNow = await DbClock.NowAsync(leaseConn, ctx.RequestAborted);
                if (!DesktopLeaseRepository.IsActiveFor(lease, ticket.UserId, ticket.TabId, ticket.Epoch, dbNow))
                { ctx.Response.StatusCode = 409; return; }
            }
            await platform.Compute.EnsureAwakeAsync(endpoint.ComputerId, ctx.RequestAborted);
            platform.Compute.NoteViewer(endpoint.ComputerId);
            var isControl = ticket.Role == "control";
            var leaseLogger = ctx.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("DesktopLease");
            using var socket = await ctx.WebSockets.AcceptWebSocketAsync();
            using var tcp = new System.Net.Sockets.TcpClient();
            await tcp.ConnectAsync(endpoint.Host, endpoint.Port);
            var rwConnectionId = Guid.NewGuid();
            if (isControl) await DesktopRwConnections.RegisterAsync(platform.Data, ticket.LeaseId, ticket.Epoch, rwConnectionId, ctx.RequestAborted);
            await using var stream = tcp.GetStream();
            var toTcp = Task.Run(async () =>
            {
                var buffer = new byte[8192];
                var filter = endpoint.Mode == DesktopMode.View ? new RfbClientStreamFilter("watch") : null;
                while (socket.State == WebSocketState.Open)
                {
                    var result = await socket.ReceiveAsync(buffer, ctx.RequestAborted);
                    if (result.MessageType == WebSocketMessageType.Close) break;
                    if (endpoint.Mode == DesktopMode.Interactive)
                    {
                        await using var leaseConn = await platform.Data.OpenConnectionAsync(ctx.RequestAborted);
                        var lease = await DesktopLeaseRepository.StateAsync(leaseConn, ticket.LeaseId, 1, ctx.RequestAborted);
                        var dbNow = await DbClock.NowAsync(leaseConn, ctx.RequestAborted);
                        if (!DesktopLeaseRepository.IsActiveFor(lease, ticket.UserId, ticket.TabId, ticket.Epoch, dbNow)) break;
                    }
                    var forwarded = filter?.Feed(buffer.AsSpan(0, result.Count)) ?? buffer.AsSpan(0, result.Count).ToArray();
                    if (forwarded.Length > 0) await stream.WriteAsync(forwarded, ctx.RequestAborted);
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
            var leaseMonitor = isControl ? Task.Run(async () =>
            {
                while (socket.State == WebSocketState.Open && !ctx.RequestAborted.IsCancellationRequested)
                {
                    await Task.Delay(TimeSpan.FromSeconds(1), ctx.RequestAborted);
                    await DesktopRwConnections.HeartbeatAsync(platform.Data, ticket.LeaseId, ticket.Epoch, rwConnectionId, ctx.RequestAborted);
                    await using var leaseConn = await platform.Data.OpenConnectionAsync(ctx.RequestAborted);
                    var lease = await DesktopLeaseRepository.StateAsync(leaseConn, ticket.LeaseId, 1, ctx.RequestAborted);
                    var dbNow = await DbClock.NowAsync(leaseConn, ctx.RequestAborted);
                    if (!DesktopLeaseRepository.IsActiveFor(lease, ticket.UserId, ticket.TabId, ticket.Epoch, dbNow))
                    {
                        socket.Abort();
                        tcp.Close();
                        break;
                    }
                }
            }) : Task.CompletedTask;
            Task[] forwarders = isControl ? [toTcp, toWs, leaseMonitor] : [toTcp, toWs];
            await Task.WhenAny(forwarders);
            // Finish the RFB connection while x11vnc is still reading, then stop the
            // viewer, and only then complete the websocket close. The browser waits
            // on that close before it opens another socket, so a pane toggle cannot
            // leave a CLOSE_WAIT backlog behind a process that ignores SIGTERM.
            try { tcp.Close(); } catch { /* already closed */ }
            try { await Task.WhenAll(toTcp, toWs).WaitAsync(TimeSpan.FromSeconds(2)); } catch { /* copy loops end once the sockets close */ }
            if (isControl)
            {
                try { await DesktopRwConnections.DisconnectedAsync(platform.Data, ticket.LeaseId, ticket.Epoch, rwConnectionId); }
                catch (Exception ex) { leaseLogger.LogDebug("desktop websocket close registration failed {Type}", ex.GetType().Name); }
            }
            else try { await platform.Compute.ReleaseViewerAsync(ticket.SessionToken, CancellationToken.None); } catch { /* viewer session closes with its websocket */ }
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
                await ctx.Response.WriteAsync(": connected\n\nevent: ready\ndata: {}\n\n", ctx.RequestAborted);
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
                    if (Random.Shared.Next(10) == 0 && SseEventId(message) is long delivered && platform.Events.PublishedAt(delivered) is long published)
                        ctx.RequestServices.GetRequiredService<PerfRecorder>().Record("sse_fanout_ms", System.Diagnostics.Stopwatch.GetElapsedTime(published).TotalMilliseconds);
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
            if (provider.Equals("web_bot_auth", StringComparison.OrdinalIgnoreCase))
                return Results.Json(new { error = "reserved namespace" }, statusCode: 403);
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
            var n = await conn.ExecuteAsync("UPDATE tasks SET lease_until=now(),updated_at=now() WHERE status='running' AND lease_owner=@worker", new { worker });
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
                WHERE t.status='queued' AND (t.resume_after IS NULL OR t.resume_after<=now())
                  AND NOT EXISTS (SELECT 1 FROM control_locks l WHERE l.bot_id=t.bot_id AND l.holder='human')
                  AND (SELECT count(*) FROM tasks r JOIN bots rb ON rb.id=r.bot_id WHERE r.status='running' AND rb.owner_id=b.owner_id)
                      < least(@cap, coalesce((SELECT max_parallel_tasks FROM user_quotas q WHERE q.user_id=b.owner_id), @cap))
                ORDER BY t.priority DESC, t.created_at
                FOR UPDATE OF t SKIP LOCKED
                LIMIT @max
                """, new { max, cap = platform.MaxParallel }, tx)).ToArray();
            var rows = new List<object>();
            var resumedEvents = new List<(Guid Id, int Attempt, string Reason, int Steps)>();
            var wake = new HashSet<string>();
            foreach (var id in ids)
            {
                var task = await conn.QuerySingleAsync<(Guid Id, Guid BotId, string Instruction, string Kind, int Attempt, int Epoch, string? Checkpoint, Guid? SkillId, Guid? ConversationId, Guid? SourceMessageId, string? PreviousReason, bool ForceCompact)>(
                "UPDATE tasks SET status='running', lease_owner=@worker, lease_until=now()+interval '20 seconds', lease_epoch=lease_epoch+1, attempt=attempt+1, started_at=coalesce(started_at, now()), last_progress_at=now(), resume_after=NULL, updated_at=now() WHERE id=@id RETURNING id, bot_id, instruction, kind, attempt, lease_epoch, checkpoint::text, skill_id, conversation_id, source_message_id, waiting_reason AS previous_reason, force_compact",
                    new { id, worker }, tx);
                var budget = await conn.QuerySingleAsync<(int? TaskSteps, int? TaskSeconds, int? BotSteps, int? BotSeconds, bool? TaskPause, bool? BotPause)>("SELECT t.budget_steps,t.budget_seconds,b.default_budget_steps,b.default_budget_seconds,t.pause_on_budget,b.pause_on_budget FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE t.id=@id", new { id }, tx);
                var resolvedBudget = RunBudget.Resolve(budget.TaskSteps, budget.TaskSeconds, budget.BotSteps, budget.BotSeconds);
                var pauseOnBudget = RunBudget.ResolvePauseOnBudget(budget.TaskPause, budget.BotPause, platform.PauseOnBudget);
                var ledger = TaskCheckpoint.Read(task.Checkpoint);
                var previousReason = task.PreviousReason;
                var priorSteps = await conn.ExecuteScalarAsync<int>("SELECT count(*)::int FROM task_steps WHERE task_id=@id", new { id }, tx);
                var modelRounds = await conn.ExecuteScalarAsync<int>("SELECT model_calls FROM tasks WHERE id=@id", new { id }, tx);
                ledger["v"] = 1;
                ledger["secondsBeforeAttempt"] = (int?)ledger["secondsUsed"] ?? 0;
                ledger["attemptStepsAtStart"] = priorSteps;
                ledger["stepsUsed"] = priorSteps;
                ledger["modelRounds"] = modelRounds;
                ledger["attemptStartedAt"] = DateTimeOffset.UtcNow.ToString("O");
                var checkpointJson = TaskCheckpoint.Bounded(ledger);
                await conn.ExecuteAsync("UPDATE tasks SET checkpoint=@checkpoint::jsonb WHERE id=@id AND lease_epoch=@epoch", new { id, checkpoint = checkpointJson, epoch = task.Epoch }, tx);
                if (previousReason is "lease_expired" or "computer_recovered" or "network_interrupted" or "attempt_limit" or "stalled") resumedEvents.Add((id, task.Attempt, previousReason, priorSteps));
                var botPrompt = await conn.QuerySingleAsync<(string Role, string Instructions)>("SELECT role, instructions FROM bots WHERE id=@id", new { id = task.BotId }, tx);
                var memoryMode = await conn.ExecuteScalarAsync<string?>("SELECT mode FROM bot_memory_settings WHERE bot_id=@bot", new { bot = task.BotId }, tx) ?? "auto";
                var notesFlag = (platform.Configuration["MEMORY_NOTES"] ?? platform.Configuration["Memory:Notes"] ?? "shadow").ToLowerInvariant();
                var rules = notesFlag != "off" && memoryMode != "off"
                    ? (await conn.QueryAsync<(Guid Id, string Content)>("SELECT id, content FROM memories WHERE bot_id=@bot AND owner_id=(SELECT owner_id FROM bots WHERE id=@bot) AND kind='rule' AND rule_scope IS NULL AND status='active' AND deleted_at IS NULL AND sensitive=false AND author NOT IN ('peer','routine') AND (conversation_id IS NULL OR conversation_id=@conversation) ORDER BY created_at DESC", new { bot = task.BotId, conversation = task.ConversationId }, tx)).Select(r => new { id = r.Id, content = r.Content }).ToArray()
                    : [];
                if (rules.Length > 0) await conn.ExecuteAsync("UPDATE memories SET last_used_at=now(),use_count=use_count+1 WHERE id=ANY(@ids)", new { ids = rules.Select(rule => rule.id).ToArray() }, tx);
                var ruleTokens = int.TryParse(platform.Configuration["Memory:RuleTokens"], out var configuredRuleTokens) ? Math.Clamp(configuredRuleTokens, 1, 6000) : 600;
                var scopedRules = notesFlag != "off" && memoryMode != "off"
                    ? (await conn.QueryAsync<(Guid Id, string Scope, string Content)>("SELECT id, rule_scope AS scope, content FROM memories WHERE bot_id=@bot AND owner_id=(SELECT owner_id FROM bots WHERE id=@bot) AND kind='rule' AND rule_scope IS NOT NULL AND status='active' AND deleted_at IS NULL AND sensitive=false AND author NOT IN ('peer','routine') AND (conversation_id IS NULL OR conversation_id=@conversation) ORDER BY created_at DESC", new { bot = task.BotId, conversation = task.ConversationId }, tx)).Select(r => new { id = r.Id, scope = r.Scope, content = r.Content }).ToArray()
                    : [];
                var injectRole = bool.TryParse(platform.Configuration["Memory:InjectRole"], out var configuredInjectRole) ? configuredInjectRole : true;
                var feedback = (await conn.QueryAsync<(Guid MessageId, string Emoji, string Action)>(
                    """
                    UPDATE bot_feedback SET task_id=@task
                    WHERE id IN (
                        SELECT f.id FROM bot_feedback f
                        WHERE f.bot_id=@bot AND f.consumed_at IS NULL
                          AND (f.task_id IS NULL OR f.task_id=@task
                               OR NOT EXISTS (SELECT 1 FROM tasks o WHERE o.id=f.task_id AND o.status NOT IN ('completed','failed','cancelled')))
                        ORDER BY f.created_at FOR UPDATE)
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
                var modelRoundBudget = RunBudget.ResolveModelRounds(task.Kind, resolvedBudget, platform.ChatRounds, platform.CodingRounds, platform.CodingRoundsCumulative);
                object? resume = null;
                if (previousReason is "lease_expired" or "computer_recovered" or "network_interrupted" or "attempt_limit" or "stalled")
                {
                    var planRows = (await conn.QueryAsync<(int Position, string Title, string Status)>("SELECT position,title,status FROM task_plan_items WHERE task_id=@id ORDER BY position", new { id }, tx)).Select(p => (p.Position, p.Title, p.Status)).ToArray();
                    var lastCommit = (string?)ledger["lastCommit"]?["sha"];
                    var brief = ResumeBrief.Build(task.Attempt, previousReason, priorSteps, resolvedBudget.MaxSteps, task.Instruction, planRows, lastCommit,
                        (string?)ledger["snapshotRef"], (string?)ledger["snapshotAt"]);
                    resume = new { brief, interrupted = previousReason is "lease_expired" or "computer_recovered" or "network_interrupted" or "stalled" };
                }
                rows.Add(new { id = task.Id, botId = task.BotId, computerId = placement.Computer.Value, cdpUrl = $"http://{dns}:9222", instruction = task.Instruction, kind = task.Kind, attempt = task.Attempt, epoch = task.Epoch, checkpoint = checkpointJson, force_compact = task.ForceCompact, conversationId = task.ConversationId, messageId = task.SourceMessageId, role = injectRole ? botPrompt.Role : "", botInstructions = injectRole ? botPrompt.Instructions : "", memoryMode = notesFlag, botMemoryMode = memoryMode, standingRules = rules, scopedRules, ruleTokens, feedback, skill = skillJson, resume, budget = new { maxSteps = resolvedBudget.MaxSteps, maxSeconds = resolvedBudget.MaxSeconds, maxAttemptSteps = Math.Min(400, resolvedBudget.MaxSteps), maxAttemptSeconds = Math.Min(1800, resolvedBudget.MaxSeconds), maxRounds = modelRoundBudget.PerAttempt, maxRoundsCumulative = modelRoundBudget.Cumulative, pauseOnBudget, label = resolvedBudget.Label } });
                wake.Add(placement.Computer.Value);
            }
            await tx.CommitAsync();
            foreach (var resumed in resumedEvents)
            {
                await Reliability.Event(platform, resumed.Id, "resumed", new { attempt = resumed.Attempt, reason = resumed.Reason, stepsUsed = resumed.Steps });
                await platform.Audit("system", "task.resumed", null, resumed.Id, new { attempt = resumed.Attempt, reason = resumed.Reason, stepsUsed = resumed.Steps });
            }
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
            await using var tx = await conn.BeginTransactionAsync();
            var row = await conn.QuerySingleOrDefaultAsync<(bool Nudge, bool ForceCompact, string? Checkpoint, int Rounds, int Steps)>("""
                UPDATE tasks SET lease_until=now()+interval '20 seconds', updated_at=now()
                WHERE id=@id AND lease_owner=@worker AND lease_epoch=@epoch AND status='running'
                RETURNING nudge_pending, force_compact, checkpoint::text, model_calls,
                    (SELECT count(*)::int FROM task_steps WHERE task_id=@id)
                """, new { id, worker = body.GetProperty("workerId").GetString(), epoch = body.GetProperty("epoch").GetInt32() }, tx);
            if (row.Checkpoint == null) return Results.StatusCode(409);
            var ledger = TaskCheckpoint.Read(row.Checkpoint);
            var now = DateTimeOffset.UtcNow;
            var attemptStarted = DateTimeOffset.TryParse((string?)ledger["attemptStartedAt"], out var started) ? started : now;
            ledger["v"] = 1;
            ledger["stepsUsed"] = row.Steps;
            ledger["modelRounds"] = row.Rounds;
            ledger["secondsUsed"] = (int?)ledger["secondsBeforeAttempt"] + Math.Max(0, (int)(now - attemptStarted).TotalSeconds);
            if (body.TryGetProperty("lastToolCallId", out var callId) && callId.ValueKind == JsonValueKind.String)
                ledger["lastToolCallId"] = TaskCheckpoint.Id(callId.GetString());
            if (body.TryGetProperty("lastProgressAt", out var progress) && progress.ValueKind == JsonValueKind.String && DateTimeOffset.TryParse(progress.GetString(), out var progressAt))
                ledger["lastProgressAt"] = progressAt.ToString("O");
            if (body.TryGetProperty("snapshotRef", out var snapshotRef) && snapshotRef.ValueKind == JsonValueKind.String && snapshotRef.GetString() is { Length: <= 120 } snapshot)
                ledger["snapshotRef"] = snapshot;
            if (body.TryGetProperty("snapshotAt", out var snapshotAt) && snapshotAt.ValueKind == JsonValueKind.String && DateTimeOffset.TryParse(snapshotAt.GetString(), out var snapshotTime))
                ledger["snapshotAt"] = snapshotTime.ToString("O");
            if (body.TryGetProperty("inFlightToolStartedAt", out var inFlight) && inFlight.ValueKind == JsonValueKind.String && DateTimeOffset.TryParse(inFlight.GetString(), out var inFlightAt))
            {
                ledger["inFlightToolStartedAt"] = inFlightAt.ToString("O");
                if (body.TryGetProperty("inFlightToolTimeoutSeconds", out var inFlightTimeout) && inFlightTimeout.TryGetInt32(out var seconds))
                    ledger["inFlightToolTimeoutSeconds"] = Math.Clamp(seconds, 1, 600);
            }
            else if (body.TryGetProperty("inFlightToolStartedAt", out inFlight) && inFlight.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            {
                ledger.Remove("inFlightToolStartedAt");
                ledger.Remove("inFlightToolTimeoutSeconds");
            }
            var bounded = TaskCheckpoint.Bounded(ledger);
            await conn.ExecuteAsync("UPDATE tasks SET checkpoint=@checkpoint::jsonb,nudge_pending=false WHERE id=@id AND lease_epoch=@epoch", new { id, checkpoint = bounded, epoch = body.GetProperty("epoch").GetInt32() }, tx);
            await tx.CommitAsync();
            return Results.Json(new { ok = true, nudge = row.Nudge, force_compact = row.ForceCompact });
        });

        app.MapGet("/internal/tasks/{id:guid}/transcript", async (HttpContext ctx, Guid id) =>
        {
            if (!Worker(ctx, platform)) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync("SELECT role, content, tool_calls::text AS tool_calls, tool_call_id, name FROM task_transcript WHERE task_id=@id ORDER BY seq", new { id });
            var lastPromptTokens = await conn.ExecuteScalarAsync<int>("SELECT coalesce((SELECT prompt_tokens FROM model_calls WHERE task_id=@id AND role='planner' ORDER BY created_at DESC LIMIT 1),0)", new { id });
            var messages = rows.Select(row =>
            {
                var dict = (IDictionary<string, object>)row;
                object? tools = null;
                if (dict["tool_calls"] is string json && json != "") tools = JsonDocument.Parse(json).RootElement;
                return new { role = dict["role"], content = dict["content"], toolCalls = tools, toolCallId = dict["tool_call_id"], name = dict["name"] };
            });
            var videoCard = await conn.ExecuteScalarAsync<string?>("SELECT analysis::text FROM video_tool_sessions WHERE task_id=@id AND analysis IS NOT NULL ORDER BY created_at DESC LIMIT 1", new { id });
            JsonElement? videoAnalysis = videoCard == null ? null : JsonSerializer.Deserialize<JsonElement>(videoCard);
            return Results.Json(new { messages, lastPromptTokens, videoAnalysis });
        });

        app.MapPut("/internal/tasks/{id:guid}/transcript", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            if (!Worker(ctx, platform)) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            await using var tx = await conn.BeginTransactionAsync();
            var hasEpoch = body.TryGetProperty("epoch", out var epochElement);
            var epoch = hasEpoch && epochElement.TryGetInt32(out var parsedEpoch) ? parsedEpoch : -1;
            if (hasEpoch)
            {
                var fence = await conn.QuerySingleOrDefaultAsync<(int Epoch, string Status)>("SELECT lease_epoch,status FROM tasks WHERE id=@id FOR UPDATE", new { id }, tx);
                if (fence.Status == null || !EpochFence.Accepts(true, epoch, fence.Epoch, fence.Status)) return Results.StatusCode(409);
            }
            var stored = (await conn.QueryAsync<(int Seq, string Role, string Content, string? ToolCalls, string? ToolCallId, string? Name)>(
                "SELECT seq, role, content, tool_calls::text AS ToolCalls, tool_call_id AS ToolCallId, name FROM task_transcript WHERE task_id=@id ORDER BY seq FOR UPDATE",
                new { id }, tx)).ToArray();
            var incoming = body.GetProperty("messages").EnumerateArray().Select(message =>
            {
                var content = message.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString() : "";
                content = OutputRedactor.Redact(content);
                var tools = message.TryGetProperty("toolCalls", out var tc) ? tc.GetRawText() : null;
                var role = message.GetProperty("role").GetString();
                var toolCallId = message.TryGetProperty("toolCallId", out var tid) ? tid.GetString() : null;
                var name = message.TryGetProperty("name", out var nameElement) ? nameElement.GetString() : null;
                return (Role: role, Content: content, Tools: tools, ToolCallId: toolCallId, Name: name,
                    Digest: TranscriptAppend.Digest(role, content, tools, toolCallId, name));
            }).ToArray();
            var storedDigests = stored.Select(row => TranscriptAppend.Digest(row.Role, row.Content, row.ToolCalls, row.ToolCallId, row.Name)).ToArray();
            var decision = stored.Where((row, index) => row.Seq != index).Any()
                ? TranscriptWriteDecision.Rewrite
                : TranscriptAppend.Decide(storedDigests, incoming.Select(message => message.Digest).ToArray());
            if (decision.Kind == TranscriptWriteKind.Rewrite)
            {
                await conn.ExecuteAsync("DELETE FROM task_transcript WHERE task_id=@id", new { id }, tx);
                decision = TranscriptWriteDecision.Append(0);
            }
            for (var seq = decision.FromIndex; seq < incoming.Length; seq++)
            {
                var message = incoming[seq];
                await conn.ExecuteAsync(
                    "INSERT INTO task_transcript (task_id, seq, role, content, tool_calls, tool_call_id, name) VALUES (@id, @seq, @role, @content, @tools::jsonb, @toolCallId, @name)",
                    new
                    {
                        id, seq, role = message.Role, content = message.Content, tools = message.Tools,
                        toolCallId = message.ToolCallId, name = message.Name
                    }, tx);
            }
            await tx.CommitAsync();
            if (hasEpoch)
                await conn.ExecuteAsync("UPDATE tasks SET last_progress_at=now(),blocked_reason=NULL WHERE id=@id AND status='running' AND lease_epoch=@epoch", new { id, epoch });
            else await conn.ExecuteAsync("UPDATE tasks SET last_progress_at=now(),blocked_reason=NULL WHERE id=@id", new { id });
            return Results.Json(new { ok = true });
        });

        app.MapPost("/internal/tasks/{id:guid}/compact", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            if (!Worker(ctx, platform)) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            await using var tx = await conn.BeginTransactionAsync();
            var epoch = body.TryGetProperty("epoch", out var ep) ? ep.GetInt32() : -1;
            var task = await conn.QuerySingleOrDefaultAsync<(int Epoch, string Status, string? Checkpoint, Guid? ConversationId, Guid BotId, Guid OwnerId)>(
                "SELECT t.lease_epoch,t.status,t.checkpoint::text,t.conversation_id,t.bot_id,b.owner_id FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE t.id=@id FOR UPDATE OF t", new { id }, tx);
            if (task.Status == null || !EpochFence.Accepts(true, epoch, task.Epoch, task.Status)) return Results.StatusCode(409);
            var compactionId = body.GetProperty("compactionId").GetString();
            if (string.IsNullOrWhiteSpace(compactionId) || compactionId.Length > 80) return Results.BadRequest();
            var from = Math.Max(0, body.GetProperty("archivedFromSeq").GetInt32());
            var to = Math.Max(from, body.GetProperty("archivedToSeq").GetInt32());
            var archived = await conn.ExecuteAsync("""
                INSERT INTO task_transcript_archive(task_id,compaction_id,seq,role,content,tool_calls,tool_call_id,name)
                SELECT task_id,@compactionId,seq,role,content,tool_calls,tool_call_id,name
                FROM task_transcript WHERE task_id=@id AND seq BETWEEN @from AND @to
                ON CONFLICT(task_id,compaction_id,seq) DO NOTHING
                """, new { id, compactionId, from, to }, tx);
            var incoming = body.GetProperty("messages").EnumerateArray().Select((message, seq) => new {
                Seq = seq,
                Role = message.GetProperty("role").GetString() ?? "user",
                Content = message.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.String ? OutputRedactor.Redact(content.GetString()) : "",
                Tools = message.TryGetProperty("toolCalls", out var calls) ? calls.GetRawText() : null,
                ToolCallId = message.TryGetProperty("toolCallId", out var callId) ? callId.GetString() : null,
                Name = message.TryGetProperty("name", out var name) ? name.GetString() : null
            }).ToArray();
            await conn.ExecuteAsync("DELETE FROM task_transcript WHERE task_id=@id", new { id }, tx);
            foreach (var message in incoming)
                await conn.ExecuteAsync("INSERT INTO task_transcript(task_id,seq,role,content,tool_calls,tool_call_id,name) VALUES(@id,@Seq,@Role,@Content,@Tools::jsonb,@ToolCallId,@Name)", new { id, message.Seq, message.Role, message.Content, message.Tools, message.ToolCallId, message.Name }, tx);

            var stats = body.TryGetProperty("stats", out var statsEl) ? statsEl : default;
            int Stat(string key) => stats.ValueKind == JsonValueKind.Object && stats.TryGetProperty(key, out var value) && value.TryGetInt32(out var number) ? Math.Clamp(number, 0, 10_000_000) : 0;
            var stage = stats.ValueKind == JsonValueKind.Object && stats.TryGetProperty("stage", out var stageEl) && stageEl.GetString() == "summary" ? "summary" : "mask";
            var detail = InjectionFilter.ScrubJson(JsonSerializer.Serialize(new { kept = incoming.Length, archived, stage, estimateBefore = Stat("estimateBefore"), estimateAfter = Stat("estimateAfter") }));
            await conn.ExecuteAsync("INSERT INTO task_run_events(task_id,type,detail) VALUES(@id,'compacted',@detail::jsonb)", new { id, detail }, tx);
            var ledger = TaskCheckpoint.Read(task.Checkpoint);
            var count = (int?)ledger["compactions"] ?? 0;
            ledger["compactions"] = Math.Min(10000, count + 1);
            ledger["lastCompactionAt"] = DateTimeOffset.UtcNow.ToString("O");
            if (stats.ValueKind == JsonValueKind.Object && stats.TryGetProperty("compactionsWithoutRelief", out var streak) && streak.TryGetInt32(out var streakCount))
                ledger["compactionsWithoutRelief"] = Math.Clamp(streakCount, 0, 2);
            await conn.ExecuteAsync("UPDATE tasks SET checkpoint=@checkpoint::jsonb,last_progress_at=now(),force_compact=false,updated_at=now() WHERE id=@id AND status='running' AND lease_epoch=@epoch", new { id, epoch, checkpoint = TaskCheckpoint.Bounded(ledger) }, tx);
            if (task.ConversationId != null)
            {
                var notice = ResumeNotices.BuildCompactedNotice(id, archived, Math.Min(20, incoming.Length));
                await conn.ExecuteAsync("INSERT INTO messages(conversation_id,role,kind,content,task_id) VALUES(@conversation,'assistant','text',@notice,@id)", new { conversation = task.ConversationId, notice, id }, tx);
            }
            await tx.CommitAsync();
            await platform.Publish(new { type = "compacted", taskId = id, detail = JsonSerializer.Deserialize<object>(detail) });
            if (task.ConversationId != null) await platform.Publish(new { type = "message", conversationId = task.ConversationId });
            await platform.Audit(task.OwnerId.ToString(), "task.compacted", task.BotId, id, JsonSerializer.Deserialize<object>(detail)!);
            return Results.Json(new { ok = true, kept = incoming.Length, archived, compactionId });
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
            JsonElement videoAnalysis = default;
            if (body.TryGetProperty("videoAnalysis", out var videoJson) && videoJson.ValueKind == JsonValueKind.Object)
            {
                using var filtered = JsonDocument.Parse(OutputRedactor.Redact(videoJson.GetRawText()));
                videoAnalysis = filtered.RootElement.Clone();
            }
            var metadata = videoAnalysis.ValueKind == JsonValueKind.Object
                ? JsonSerializer.Serialize(new { videoAnalysis }) : "{}";
            await using var conn = await platform.Data.OpenConnectionAsync();
            var epoch = body.TryGetProperty("epoch", out var epochEl) ? epochEl.GetInt32() : -1;
            var gate = await conn.QuerySingleOrDefaultAsync<(bool Required, DateTimeOffset? Passed, bool Override)>("SELECT coalesce(t.require_tests,b.require_tests,false),t.tests_passed_at,t.tests_override FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE t.id=@id", new { id });
            if (!TestGate.Check(gate.Required, gate.Passed, gate.Override)) return Results.Json(new { error = "tests_required" }, statusCode: 422);
            var attempt = await conn.QuerySingleOrDefaultAsync<(string? Checkpoint, int Number, int Steps, string? Worker)>("SELECT checkpoint::text,attempt,(SELECT count(*)::int FROM task_steps WHERE task_id=@id),lease_owner FROM tasks WHERE id=@id AND status='running' AND lease_epoch=@epoch", new { id, epoch });
            // Completion and feedback consumption share one statement and the same epoch fence.
            var completed = await conn.QuerySingleOrDefaultAsync<(Guid? ConversationId, int Applied)>(FeedbackDelivery.CompleteSql,
                new { id, result = JsonSerializer.Serialize(new { text, videoAnalysis = videoAnalysis.ValueKind == JsonValueKind.Object ? JsonSerializer.Deserialize<object>(videoAnalysis.GetRawText()) : null }), epoch });
            if (completed.Applied == 0) return Results.StatusCode(409);
            if (attempt.Checkpoint != null)
            {
                var ledger = TaskCheckpoint.Read(attempt.Checkpoint);
                var ended = DateTimeOffset.UtcNow;
                var started = DateTimeOffset.TryParse((string?)ledger["attemptStartedAt"], out var at) ? at : ended;
                var progress = DateTimeOffset.TryParse((string?)ledger["lastProgressAt"], out var progressAt) && progressAt > started;
                await AttemptLog.Record(conn, null, id, attempt.Number, started, ended, Math.Max(0, attempt.Steps - ((int?)ledger["attemptStepsAtStart"] ?? 0)), "completed", progress, attempt.Worker);
            }
            var conversation = completed.ConversationId;
            var taskKind = await conn.ExecuteScalarAsync<string>("SELECT kind FROM tasks WHERE id=@id", new { id });
            // A peer task's answer is the reply on the thread, not a chat message in the receiver's own chat.
            var quiet = taskKind != "peer" && await RoutineRuns.IsQuiet(conn, id, text);
            try { await RoutineRuns.Finish(platform, conn, id, true, text, null, quiet); }
            catch (Exception) { /* run history must not fail the task */ }
            if (conversation != null && !string.IsNullOrWhiteSpace(text) && taskKind != "peer" && !quiet)
                await conn.ExecuteAsync("INSERT INTO messages (conversation_id, role, content, metadata, task_id) VALUES (@conversation, 'assistant', @text, CAST(@metadata AS jsonb), @id)", new { conversation, text, metadata, id });
            if (taskKind == "peer")
            {
                try { await BotMessaging.OnTaskComplete(platform, id, text); }
                catch (Exception) { /* the reply is retried by the sweeper; completion itself must not fail */ }
            }
            var owner = await conn.ExecuteScalarAsync<Guid?>("SELECT b.owner_id FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE t.id=@id", new { id });
            if (owner != null && !quiet) await platform.Notify(owner.Value, "task.complete", "Task finished", text ?? "");
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
            var attempt = await conn.QuerySingleOrDefaultAsync<(string? Checkpoint, int Number, int Steps, string? Worker)>("SELECT checkpoint::text,attempt,(SELECT count(*)::int FROM task_steps WHERE task_id=@id),lease_owner FROM tasks WHERE id=@id AND status='running' AND lease_epoch=@epoch", new { id, epoch });
            var n = await conn.ExecuteAsync("UPDATE tasks SET status='failed', error=@error, error_code=@errorCode, finished_at=now(), lease_owner=NULL, updated_at=now() WHERE id=@id AND status='running' AND lease_epoch=@epoch", new { id, error, errorCode, epoch });
            if (n > 0 && attempt.Checkpoint != null)
            {
                var ledger = TaskCheckpoint.Read(attempt.Checkpoint);
                var ended = DateTimeOffset.UtcNow;
                var started = DateTimeOffset.TryParse((string?)ledger["attemptStartedAt"], out var at) ? at : ended;
                var progress = DateTimeOffset.TryParse((string?)ledger["lastProgressAt"], out var progressAt) && progressAt > started;
                await AttemptLog.Record(conn, null, id, attempt.Number, started, ended, Math.Max(0, attempt.Steps - ((int?)ledger["attemptStepsAtStart"] ?? 0)), "failed", progress, attempt.Worker);
            }
            if (n > 0) await Reliability.Event(platform, id, "error", new { error_code = errorCode, error });
            if (n > 0)
            {
                try { await RoutineRuns.Finish(platform, conn, id, false, null, error, false); }
                catch (Exception) { /* run history must not fail the task */ }
            }
            if (n > 0)
            {
                try { await BotMessaging.OnTaskFailed(platform, id, errorCode); }
                catch (Exception) { /* thread failure notice is best effort */ }
            }
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
                var current = await conn.ExecuteScalarAsync<string>("SELECT checkpoint::text FROM tasks WHERE id=@id AND status='running' AND lease_epoch=@epoch", new { id, epoch });
                if (current == null) return Results.StatusCode(409);
                var ledger = TaskCheckpoint.Read(current);
                if (checkpoint != null)
                {
                    try
                    {
                        using var supplied = JsonDocument.Parse(checkpoint);
                        if (supplied.RootElement.ValueKind == JsonValueKind.Object && supplied.RootElement.TryGetProperty("phase", out var phase) && phase.ValueKind == JsonValueKind.String && phase.GetString() == "holding")
                            ledger["phase"] = "holding";
                    }
                    catch (JsonException) { }
                }
                var bounded = TaskCheckpoint.Bounded(ledger);
                var kept = await conn.ExecuteAsync("UPDATE tasks SET checkpoint=@checkpoint::jsonb, updated_at=now() WHERE id=@id AND status='running' AND lease_epoch=@epoch", new { id, checkpoint = bounded, epoch });
                return kept == 0 ? Results.StatusCode(409) : Results.Json(new { ok = true });
            }
            if (status == "queued" && reason == "attempt_limit")
            {
                var state = await conn.QuerySingleOrDefaultAsync<(string? Checkpoint, int Attempt, int Steps, string? Worker)>("""
                    SELECT checkpoint::text,attempt,(SELECT count(*)::int FROM task_steps WHERE task_id=@id),lease_owner
                    FROM tasks WHERE id=@id AND status='running' AND lease_epoch=@epoch
                    """, new { id, epoch });
                if (state.Checkpoint == null) return Results.StatusCode(409);
                var ledger = TaskCheckpoint.Read(state.Checkpoint);
                var now = DateTimeOffset.UtcNow;
                var startedAt = DateTimeOffset.TryParse((string?)ledger["attemptStartedAt"], out var started) ? started : now;
                var progressAt = DateTimeOffset.TryParse((string?)ledger["lastProgressAt"], out var progress) ? progress : DateTimeOffset.MinValue;
                var progressMade = progressAt > startedAt;
                var attempts = ledger["attempts"] as JsonArray ?? new JsonArray();
                attempts.Add(new JsonObject { ["n"] = state.Attempt, ["startedAt"] = startedAt.ToString("O"), ["endedAt"] = now.ToString("O"), ["endReason"] = "attempt_limit", ["stepsAtEnd"] = state.Steps, ["progress"] = progressMade });
                while (attempts.Count > 16) attempts.RemoveAt(0);
                ledger["attempts"] = attempts;
                ledger["stepsUsed"] = state.Steps;
                ledger["secondsUsed"] = (int?)ledger["secondsBeforeAttempt"] + Math.Max(0, (int)(now - startedAt).TotalSeconds);
                var bounded = TaskCheckpoint.Bounded(ledger);
                var queued = await conn.ExecuteAsync("""
                    UPDATE tasks SET status='queued',waiting_reason='attempt_limit',checkpoint=@checkpoint::jsonb,
                        lease_owner=NULL,lease_until=NULL,resume_after=now()+interval '2 seconds',updated_at=now()
                    WHERE id=@id AND status='running' AND lease_epoch=@epoch
                    """, new { id, epoch, checkpoint = bounded });
                if (queued == 0) return Results.StatusCode(409);
                await AttemptLog.Record(conn, null, id, state.Attempt, startedAt, now, Math.Max(0, state.Steps - ((int?)ledger["attemptStepsAtStart"] ?? 0)), "attempt_limit", progressMade, state.Worker);
                await Reliability.Event(platform, id, "resume_scheduled", new { attempt = state.Attempt, reason = "attempt_limit", backoffSeconds = 2, stepsUsed = state.Steps });
                platform.Tasks.Pulse();
                return Results.Json(new { ok = true, requeued = true });
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
                          AND CASE WHEN jsonb_typeof(content::jsonb -> 'answer') = 'array'
                                   THEN jsonb_array_length(content::jsonb -> 'answer')
                                   ELSE 0 END > 0
                      )
                    """,
                    new { id });
                if (resumed > 0)
                {
                    platform.Tasks.Pulse();
                    return Results.Json(new { ok = true, resumed = true });
                }
            }
            var endState = status is "waiting_resource" or "waiting_approval" or "waiting_human" or "completed" or "failed" or "cancelled";
            var endInfo = endState ? await conn.QuerySingleOrDefaultAsync<(string? Checkpoint, int Attempt, int Steps, string? Worker)>("""
                SELECT checkpoint::text,attempt,(SELECT count(*)::int FROM task_steps WHERE task_id=@id),lease_owner
                FROM tasks WHERE id=@id AND status='running' AND lease_epoch=@epoch
                """, new { id, epoch }) : default;
            var endStartedAt = DateTimeOffset.UtcNow;
            var endProgress = false;
            if (endState && endInfo.Checkpoint != null)
            {
                var endLedger = TaskCheckpoint.Read(endInfo.Checkpoint);
                if (DateTimeOffset.TryParse((string?)endLedger["attemptStartedAt"], out var parsedStart)) endStartedAt = parsedStart;
                endProgress = DateTimeOffset.TryParse((string?)endLedger["lastProgressAt"], out var parsedProgress) && parsedProgress > endStartedAt;
            }
            var n = await conn.ExecuteAsync(
                """
                UPDATE tasks
                SET status=@status,
                    waiting_reason=coalesce(@reason, waiting_reason),
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
                        AND CASE WHEN jsonb_typeof(content::jsonb -> 'answer') = 'array'
                                 THEN jsonb_array_length(content::jsonb -> 'answer')
                                 ELSE 0 END > 0
                    )
                  )
                """,
                new { id, status, reason, checkpoint, epoch });
            if (n > 0 && endState && endInfo.Checkpoint != null)
                await AttemptLog.Record(conn, null, id, endInfo.Attempt, endStartedAt, DateTimeOffset.UtcNow, Math.Max(0, endInfo.Steps - ((int?)TaskCheckpoint.Read(endInfo.Checkpoint)["attemptStepsAtStart"] ?? 0)), reason ?? status ?? "status_change", endProgress, endInfo.Worker);
            if (n > 0 && status == "waiting_human" && reason == "budget_reached")
            {
                var usage = await conn.QuerySingleAsync<(int Steps, int Rounds)>("SELECT (SELECT count(*)::int FROM task_steps WHERE task_id=@id),model_calls FROM tasks WHERE id=@id", new { id });
                await Reliability.Event(platform, id, "budget_reached", new { stepsUsed = usage.Steps, modelRounds = usage.Rounds });
            }
            if (n > 0 && status == "waiting_human" && reason == "context_exhausted")
            {
                var usage = await conn.QuerySingleAsync<(int Steps, int Rounds)>("SELECT (SELECT count(*)::int FROM task_steps WHERE task_id=@id),model_calls FROM tasks WHERE id=@id", new { id });
                await Reliability.Event(platform, id, "context_exhausted", new { stepsUsed = usage.Steps, modelRounds = usage.Rounds });
            }
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
        app.MapPost("/internal/video/{operation}", (HttpContext ctx, string operation, JsonElement body, CancellationToken ct) => Worker(ctx, platform) ? runtime.VideoBridge(body, operation, ct) : Task.FromResult<IResult>(Results.Unauthorized()));
        app.MapPost("/internal/video/cache/{operation}", (HttpContext ctx, string operation, JsonElement body, CancellationToken ct) => Worker(ctx, platform) ? runtime.VideoBridge(body, "cache/" + operation, ct) : Task.FromResult<IResult>(Results.Unauthorized()));
        app.MapPost("/internal/tools/authorize", (HttpContext ctx, JsonElement body, CancellationToken ct) => Worker(ctx, platform) ? runtime.Authorize(body, ct) : Task.FromResult<IResult>(Results.Unauthorized()));
        app.MapPost("/internal/tools/preexec", (HttpContext ctx, JsonElement body, CancellationToken ct) => Worker(ctx, platform) ? runtime.PreExec(body, ct) : Task.FromResult<IResult>(Results.Unauthorized()));
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
        if (user == null) return Results.Unauthorized();
        if (!await Owns(platform, user.Value, id)) return Results.NotFound();
        if (control) return Results.Conflict(new { error = "control_requires_lease_ticket" });
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

    internal static async Task<Guid?> RequireUser(HttpContext ctx, Platform platform)
    {
        ctx.Request.Cookies.TryGetValue("teammates_session", out var token);
        return await platform.UserForSession(token);
    }

    /// <summary>One page of a chat, oldest first. `before` pages back from that message. hasMore says older messages exist.</summary>
    internal static async Task<(List<Dictionary<string, object?>> Rows, bool HasMore)> LoadMessages(NpgsqlConnection conn, Guid conversationId, Guid? before, int limit)
    {
        var messages = (await conn.QueryAsync("SELECT m.id, m.role, m.content, m.created_at, m.metadata::text AS metadata, m.reply_to_message_id, m.deleted_at, m.kind, COALESCE(m.task_id, (SELECT t.id FROM tasks t WHERE t.source_message_id=m.id ORDER BY t.created_at DESC LIMIT 1)) AS request_id, (SELECT t.status FROM tasks t WHERE t.id = COALESCE(m.task_id, (SELECT t2.id FROM tasks t2 WHERE t2.source_message_id=m.id ORDER BY t2.created_at DESC LIMIT 1))) AS task_status FROM messages m WHERE m.conversation_id=@conversation AND (@before::uuid IS NULL OR (m.created_at, m.id) < (SELECT b.created_at, b.id FROM messages b WHERE b.id=@before AND b.conversation_id=@conversation)) ORDER BY m.created_at DESC, m.id DESC LIMIT @lim", new { conversation = conversationId, before, lim = limit + 1 })).Select(Platform.ToDict).ToList();
        var reactionRows = (await conn.QueryAsync("SELECT r.id, r.message_id, r.actor_type::text AS actor_type, r.actor_id, r.emoji, r.created_at FROM message_reactions r JOIN messages m ON m.id=r.message_id WHERE m.conversation_id=@conversation ORDER BY r.created_at", new { conversation = conversationId })).Select(Platform.ToDict).ToList();
        foreach (var message in messages)
        {
            var idText = message["id"]?.ToString();
            if (message.TryGetValue("metadata", out var metaRaw) && metaRaw is string metaText && metaText.Length > 2)
            {
                try { var meta = JsonSerializer.Deserialize<JsonElement>(metaText); message["parts"] = meta.TryGetProperty("parts", out var pe) ? pe : null; message["skill"] = meta.TryGetProperty("skill", out var se) ? se : null; message["attachments"] = meta.TryGetProperty("attachments", out var ae) ? ae : null; message["videoAnalysis"] = meta.TryGetProperty("videoAnalysis", out var video) ? video : null; } catch { message["parts"] = null; }
            }
            message.Remove("metadata");
            message["deleted"] = message.TryGetValue("deletedAt", out var del) && del != null;
            message["reactions"] = reactionRows.Where(row => row["messageId"]?.ToString() == idText).Select(row => new { id = row["id"], actorType = row["actorType"], actorId = row["actorId"], emoji = row["emoji"], createdAt = row["createdAt"] }).ToList();
        }
        var hasMore = messages.Count > limit;
        if (hasMore) messages.RemoveAt(messages.Count - 1);
        messages.Reverse();
        return (messages, hasMore);
    }

    internal static async Task<bool> Owns(Platform platform, Guid user, Guid bot)
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
