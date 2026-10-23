using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using Teammates.Compute;

namespace Teammates.Api;

public static class Beta
{
    public static void Map(WebApplication app, Platform platform)
    {
        app.MapPost("/api/invitations", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var role = await Role(platform, user.Value);
            var target = body.TryGetProperty("role", out var roleEl) ? roleEl.GetString() ?? "member" : "member";
            if (!Access.CanGrant(role, target)) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            var email = (body.GetProperty("email").GetString() ?? "").Trim().ToLowerInvariant();
            if (email.Length < 3 || !email.Contains('@')) return Results.BadRequest(new { error = "email is required" });
            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
            var hash = Hash(token);
            await using var conn = await platform.Data.OpenConnectionAsync();
            var id = await conn.ExecuteScalarAsync<Guid>(
                """
                INSERT INTO invitations (email, role, token_hash, invited_by, expires_at)
                VALUES (@email, @role, @hash, @by, now() + interval '7 days')
                RETURNING id
                """,
                new { email, role = target, hash, by = user });
            await platform.Audit(user.Value.ToString(), "invitation.created", null, null, new { id, email, role = target });
            return Results.Json(new { id, email, role = target, token, expiresInDays = 7 });
        });

        app.MapGet("/api/invitations", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!Access.IsStaff(await Role(platform, user.Value))) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync(
                """
                SELECT id, email, role, expires_at, accepted_user_id, revoked_at, created_at
                FROM invitations ORDER BY created_at DESC
                """);
            return Results.Json(rows.Select(Platform.ToDict));
        });

        app.MapPost("/api/invitations/{id:guid}/revoke", async (HttpContext ctx, Guid id) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!Access.IsStaff(await Role(platform, user.Value))) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            await using var conn = await platform.Data.OpenConnectionAsync();
            var n = await conn.ExecuteAsync("UPDATE invitations SET revoked_at=now() WHERE id=@id AND accepted_user_id IS NULL AND revoked_at IS NULL", new { id });
            return n == 0 ? Results.NotFound() : Results.Json(new { ok = true });
        });

        app.MapPost("/api/invitations/accept", async (HttpContext ctx, JsonElement body) =>
        {
            var token = body.GetProperty("token").GetString() ?? "";
            var username = (body.GetProperty("username").GetString() ?? "").Trim();
            var password = body.GetProperty("password").GetString() ?? "";
            if (username.Length < 2 || password.Length < 8) return Results.BadRequest(new { error = "username and a password of 8 or more characters are required" });
            await using var conn = await platform.Data.OpenConnectionAsync();
            var invite = await conn.QuerySingleOrDefaultAsync<(Guid Id, string Email, string Role)>(
                """
                SELECT id, email, role FROM invitations
                WHERE token_hash=@hash AND revoked_at IS NULL AND accepted_user_id IS NULL AND expires_at > now()
                """,
                new { hash = Hash(token) });
            if (invite.Id == Guid.Empty)
                return Results.Json(new { error = "invitation is not valid" }, statusCode: 410);
            Guid id;
            try
            {
                id = await conn.ExecuteScalarAsync<Guid>(
                    "INSERT INTO users (username, password_hash, role, status, display_name) VALUES (@username, @hash, @role, 'active', @email) RETURNING id",
                    new { username, hash = Passwords.Hash(password), role = invite.Role, email = invite.Email });
            }
            catch (Npgsql.PostgresException ex) when (ex.SqlState == "23505")
            {
                return Results.Json(new { error = "username is taken" }, statusCode: 409);
            }
            await conn.ExecuteAsync("INSERT INTO user_quotas (user_id) VALUES (@id) ON CONFLICT DO NOTHING", new { id });
            await conn.ExecuteAsync("UPDATE invitations SET accepted_user_id=@user WHERE id=@id", new { user = id, id = invite.Id });
            var session = await platform.CreateSession(id);
            ctx.Response.Cookies.Append("teammates_session", session, new CookieOptions
            {
                HttpOnly = true,
                SameSite = SameSiteMode.Lax,
                Secure = ctx.Request.Headers["X-Forwarded-Proto"] == "https",
                Path = "/"
            });
            await platform.Audit(id.ToString(), "user.accepted", null, null, new { username, role = invite.Role });
            return Results.Json(new { id, username, role = invite.Role });
        });

        app.MapGet("/api/admin/users", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!Access.IsStaff(await Role(platform, user.Value))) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync("SELECT id, username, display_name, role, status, created_at FROM users ORDER BY created_at");
            return Results.Json(rows.Select(Platform.ToDict));
        });

        app.MapPatch("/api/admin/users/{id:guid}", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var actor = await User(ctx, platform);
            if (actor == null) return Results.Unauthorized();
            var actorRole = await Role(platform, actor.Value);
            await using var conn = await platform.Data.OpenConnectionAsync();
            var targetRole = await conn.ExecuteScalarAsync<string>("SELECT role FROM users WHERE id=@id", new { id });
            if (string.IsNullOrEmpty(targetRole)) return Results.NotFound();
            if (body.TryGetProperty("role", out var roleEl))
            {
                var next = roleEl.GetString() ?? "";
                if (id == actor) return Results.Json(new { error = "you cannot change your own role" }, statusCode: 403);
                if (!Access.CanGrant(actorRole, next) || !Access.CanChangeStatus(actorRole, targetRole))
                    return Results.Json(new { error = "forbidden" }, statusCode: 403);
                await conn.ExecuteAsync("UPDATE users SET role=@role WHERE id=@id", new { id, role = next });
                targetRole = next;
            }
            if (body.TryGetProperty("status", out var statusEl))
            {
                var status = statusEl.GetString() ?? "";
                if (status is not ("active" or "disabled")) return Results.BadRequest(new { error = "status must be active or disabled" });
                if (id == actor && status == "disabled") return Results.Json(new { error = "you cannot disable yourself" }, statusCode: 403);
                if (!Access.CanChangeStatus(actorRole, targetRole)) return Results.Json(new { error = "forbidden" }, statusCode: 403);
                await conn.ExecuteAsync("UPDATE users SET status=@status WHERE id=@id", new { id, status });
                if (status == "disabled")
                    await conn.ExecuteAsync("DELETE FROM sessions WHERE user_id=@id", new { id });
            }
            var row = await conn.QuerySingleAsync("SELECT id, username, display_name, role, status FROM users WHERE id=@id", new { id });
            return Results.Json(Platform.ToDict(row));
        });

        app.MapGet("/api/admin/health", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!Access.IsStaff(await Role(platform, user.Value))) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            await using var conn = await platform.Data.OpenConnectionAsync();
            var postgres = await conn.ExecuteScalarAsync<int>("SELECT 1") == 1;
            var users = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM users");
            var bots = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM bots");
            var computers = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM user_computers");
            var stuck = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM tasks WHERE status IN ('running','recovering') AND updated_at < now() - interval '2 minutes'");
            var pending = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM approvals WHERE status='pending'");
            var isolation = platform.Compute.ComputerIsolationHealthy;
            return Results.Json(new
            {
                ok = postgres && isolation,
                postgres,
                computerIsolation = isolation,
                llmProvider = platform.LlmProvider,
                users,
                bots,
                computers,
                stuckTasks = stuck,
                pendingApprovals = pending,
                computerMemoryBytes = platform.ComputerMemory,
                chromeProcesses = platform.ChromeProcesses
            });
        });

        app.MapGet("/api/admin/outbound-actions", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!Access.IsStaff(await Role(platform, user.Value))) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync(
                """
                SELECT id, kind, tool, status, created_at, finished_at
                FROM outbound_actions
                ORDER BY created_at DESC
                LIMIT 50
                """);
            return Results.Json(rows.Select(Platform.ToDict));
        });

        app.MapGet("/api/admin/usage", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!Access.IsStaff(await Role(platform, user.Value))) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync(
                """
                SELECT u.id, u.username, u.role, u.status,
                       count(m.id) AS model_calls,
                       coalesce(sum(m.cost_usd), 0) AS cost_usd,
                       coalesce(avg(m.latency_ms), 0)::float8 AS latency_ms
                FROM users u
                LEFT JOIN model_calls m ON m.owner_id = u.id
                GROUP BY u.id
                ORDER BY u.created_at
                """);
            return Results.Json(rows.Select(Platform.ToDict));
        });

        app.MapGet("/api/quotas", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var quota = await conn.QuerySingleOrDefaultAsync(
                "SELECT max_bots, max_computers, memory_bytes, cpu_millis, disk_bytes, max_parallel_tasks, max_secrets FROM user_quotas WHERE user_id=@id",
                new { id = user });
            var bots = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM bots WHERE owner_id=@id", new { id = user });
            var secrets = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM secrets WHERE owner_user_id=@id AND revoked_at IS NULL", new { id = user });
            var computers = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM user_computers WHERE user_id=@id", new { id = user });
            var dict = quota == null ? new Dictionary<string, object?>() : Platform.ToDict(quota);
            dict["bots"] = bots;
            dict["secrets"] = secrets;
            dict["computers"] = computers;
            var disk = await DiskUsage(platform, user.Value, ct: default);
            dict["diskUsedBytes"] = disk.Used;
            dict["diskQuotaBytes"] = disk.Quota;
            dict["diskEnforced"] = disk.Enforced;
            return Results.Json(dict);
        });

        app.MapGet("/api/computer", async (HttpContext ctx, CancellationToken ct) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var id = await conn.ExecuteScalarAsync<Guid?>("SELECT computer_id FROM user_computers WHERE user_id=@id", new { id = user });
            if (id == null) return Results.Json(new { status = "absent" });
            try
            {
                var status = await platform.Compute.GetStatusAsync(new ComputerId(id.Value.ToString()), ct);
                var disk = await DiskUsage(platform, user.Value, ct);
                return Results.Json(new { status = status.State.ToString().ToLowerInvariant(), computerId = id, healthy = status.Components.All(component => component.Healthy), diskUsedBytes = disk.Used, diskQuotaBytes = disk.Quota, diskEnforced = disk.Enforced });
            }
            catch (ComputeException ex) when (ex.IsRecovering)
            {
                return Results.Json(new { status = "recovering", computerId = id, error = ComputeException.RecoveringMessage });
            }
            catch (ComputeException ex)
            {
                return Results.Json(new { status = "unknown", computerId = id, error = ex.Code.ToString() });
            }
        });

        app.MapPost("/api/computer/restart", async (HttpContext ctx, CancellationToken ct) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var id = await Computer(platform, user.Value);
            if (id == null) return Results.NotFound();
            var computer = await platform.Compute.RestartComputerAsync(new ComputerId(id.Value.ToString()), IdempotencyKey.Require("restart-" + Guid.NewGuid().ToString("n")), ct);
            return Results.Json(new { ok = true, status = computer.State.ToString().ToLowerInvariant() });
        });

        app.MapPost("/api/computer/recreate", async (HttpContext ctx, CancellationToken ct) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var id = await Computer(platform, user.Value);
            if (id == null) return Results.NotFound();
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var name = await conn.ExecuteScalarAsync<string>(
                "SELECT b.name FROM bots b JOIN user_computers c ON c.desktop_bot_id = b.id WHERE c.user_id=@id",
                new { id = user });
            var computer = await platform.Compute.RecreateComputerAsync(new ComputerId(id.Value.ToString()), new RecreateOptions(null, user.Value.ToString(), name), IdempotencyKey.Require("recreate-" + Guid.NewGuid().ToString("n")), ct);
            return Results.Json(new { ok = true, status = computer.State.ToString().ToLowerInvariant() });
        });

        app.MapPatch("/api/bots/{id:guid}", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var owns = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM bots WHERE id=@id AND owner_id=@owner", new { id, owner = user });
            if (owns == 0) return Results.NotFound();
            var avatarShape = body.TryGetProperty("avatarShape", out var shapeEl) ? shapeEl.GetString() : null;
            var avatarColor = body.TryGetProperty("avatarColor", out var colorEl) ? colorEl.GetString() : null;
            if (avatarShape is not null && !System.Text.RegularExpressions.Regex.IsMatch(avatarShape, @"^blob(1[0-5]|[1-9])$")) return Results.BadRequest(new { error = "invalid avatar shape" });
            if (avatarColor is not null && avatarColor.Length != 0 && !System.Text.RegularExpressions.Regex.IsMatch(avatarColor, @"^#[0-9a-fA-F]{6}$")) return Results.BadRequest(new { error = "invalid avatar color" });
            if (body.TryGetProperty("bio", out var bioEl))
            {
                var bio = BotBio.Normalize(bioEl.ValueKind == JsonValueKind.String ? bioEl.GetString() : "");
                if (bio == null) return Results.BadRequest(new { error = "invalid bio" });
                await conn.ExecuteAsync("UPDATE bots SET bio=@bio, updated_at=now() WHERE id=@id", new { id, bio });
            }
            if (body.TryGetProperty("name", out var name))
                await conn.ExecuteAsync("UPDATE bots SET name=@name, updated_at=now() WHERE id=@id", new { id, name = name.GetString() ?? "Teammate" });
            if (body.TryGetProperty("role", out var roleEl))
                await conn.ExecuteAsync("UPDATE bots SET role=@role, updated_at=now() WHERE id=@id", new { id, role = roleEl.GetString() ?? "" });
            if (body.TryGetProperty("instructions", out var instructions))
                await conn.ExecuteAsync("UPDATE bots SET instructions=@instructions, updated_at=now() WHERE id=@id", new { id, instructions = instructions.GetString() ?? "" });
            if (body.TryGetProperty("model", out var model))
                await conn.ExecuteAsync("UPDATE bots SET model=@model, updated_at=now() WHERE id=@id", new { id, model = model.GetString() ?? "" });
            if (body.TryGetProperty("section", out var section))
                await conn.ExecuteAsync("UPDATE bots SET section=@section, updated_at=now() WHERE id=@id", new { id, section = string.IsNullOrWhiteSpace(section.GetString()) ? "Teammates" : section.GetString() });
            if (body.TryGetProperty("avatar", out var avatar))
                await conn.ExecuteAsync("UPDATE bots SET avatar=@avatar, updated_at=now() WHERE id=@id", new { id, avatar = avatar.GetString() ?? "" });
            if (avatarShape is not null) await conn.ExecuteAsync("UPDATE bots SET avatar_shape=@value, updated_at=now() WHERE id=@id", new { id, value = avatarShape });
            if (avatarColor is not null) await conn.ExecuteAsync("UPDATE bots SET avatar_color=@value, updated_at=now() WHERE id=@id", new { id, value = avatarColor });
            if (body.TryGetProperty("peerMessaging", out var peerEl) && peerEl.ValueKind is JsonValueKind.True or JsonValueKind.False)
            {
                await conn.ExecuteAsync("UPDATE bots SET peer_messaging=@on, updated_at=now() WHERE id=@id", new { id, on = peerEl.ValueKind == JsonValueKind.True });
                await platform.Audit(user.ToString() ?? "", "bot.peer_messaging", id, null, new { enabled = peerEl.ValueKind == JsonValueKind.True });
            }
            if (body.TryGetProperty("notifications", out var notes))
                await conn.ExecuteAsync("UPDATE bots SET notifications_enabled=@on, updated_at=now() WHERE id=@id", new { id, on = notes.ValueKind != JsonValueKind.False });
            if (body.TryGetProperty("isPrimary", out var primaryEl) && primaryEl.ValueKind == JsonValueKind.True)
            {
                await using var tx = await conn.BeginTransactionAsync();
                await conn.ExecuteAsync("UPDATE bots SET is_primary=false WHERE owner_id=@owner AND is_primary AND id<>@id", new { id, owner = user }, tx);
                await conn.ExecuteAsync("UPDATE bots SET is_primary=true, updated_at=now() WHERE id=@id", new { id }, tx);
                await tx.CommitAsync();
            }
            var row = await conn.QuerySingleAsync("SELECT id, name, role, instructions, status, model, avatar, avatar_shape, avatar_color, section, notifications_enabled, is_primary, bio, peer_messaging FROM bots WHERE id=@id", new { id });
            return Results.Json(Platform.ToDict(row));
        });

        app.MapDelete("/api/bots/{id:guid}", async (HttpContext ctx, Guid id, CancellationToken ct) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var owns = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM bots WHERE id=@id AND owner_id=@owner", new { id, owner = user });
            if (owns == 0) return Results.NotFound();
            var computer = await conn.ExecuteScalarAsync<Guid?>("SELECT computer_id FROM user_computers WHERE user_id=@owner", new { owner = user });
            if (computer != null)
                await BotFs.WipeAsync(platform.Compute, new ComputerId(computer.Value.ToString()), id, ct);
            await conn.ExecuteAsync("DELETE FROM bots WHERE id=@id AND owner_id=@owner", new { id, owner = user });
            await conn.ExecuteAsync("UPDATE bots SET is_primary=true WHERE id=(SELECT id FROM bots WHERE owner_id=@owner ORDER BY created_at LIMIT 1) AND NOT EXISTS (SELECT 1 FROM bots WHERE owner_id=@owner AND is_primary)", new { owner = user });
            return Results.NoContent();
        });

        app.MapPatch("/api/secrets/{id:guid}", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var owns = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM secrets WHERE id=@id AND owner_user_id=@owner AND revoked_at IS NULL", new { id, owner = user });
            if (owns == 0) return Results.NotFound();
            if (body.TryGetProperty("allowedDomains", out var domains) && domains.ValueKind == JsonValueKind.Array)
            {
                var list = domains.EnumerateArray().Select(item => item.GetString() ?? "").Where(item => item.Length > 0).ToArray();
                await conn.ExecuteAsync("UPDATE secrets SET allowed_domains=@list, updated_at=now() WHERE id=@id", new { id, list });
            }
            if (body.TryGetProperty("allowedTools", out var tools) && tools.ValueKind == JsonValueKind.Array)
            {
                var list = tools.EnumerateArray().Select(item => item.GetString() ?? "").Where(item => item.Length > 0).ToArray();
                await conn.ExecuteAsync("UPDATE secrets SET allowed_tools=@list, updated_at=now() WHERE id=@id", new { id, list });
            }
            if (body.TryGetProperty("allowedBotIds", out var bots) && bots.ValueKind == JsonValueKind.Array)
            {
                var list = bots.EnumerateArray().Select(item => Guid.TryParse(item.GetString(), out var parsed) ? parsed : Guid.Empty).Where(item => item != Guid.Empty).ToArray();
                await conn.ExecuteAsync("UPDATE secrets SET allowed_bot_ids=@list, updated_at=now() WHERE id=@id", new { id, list = list.Length == 0 ? null : list });
            }
            if (body.TryGetProperty("expiresAt", out var expires))
            {
                DateTimeOffset? when = expires.ValueKind == JsonValueKind.Null ? null
                    : DateTimeOffset.TryParse(expires.GetString(), out var parsed) ? parsed : null;
                await conn.ExecuteAsync("UPDATE secrets SET expires_at=@when, updated_at=now() WHERE id=@id", new { id, when });
            }
            await platform.SecretEvent(id, "secret.updated", user.Value.ToString(), null, null, null, null, "allow", "allowlist");
            return Results.Json(await platform.SecretMeta(user.Value, id));
        });

        app.MapPost("/api/secrets/{id:guid}/access", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var row = await conn.QuerySingleOrDefaultAsync<(string Provider, string Name)>("SELECT provider, name FROM secrets WHERE id=@id AND owner_user_id=@owner", new { id, owner = user });
            if (string.IsNullOrEmpty(row.Name)) return Results.NotFound();
            var tool = body.TryGetProperty("tool", out var toolEl) ? toolEl.GetString() ?? "browser.type_secret" : "browser.type_secret";
            Guid? bot = body.TryGetProperty("botId", out var botEl) && Guid.TryParse(botEl.GetString(), out var parsed) ? parsed : null;
            var destination = body.TryGetProperty("destination", out var dest) ? dest.GetString() : null;
            var resolved = await platform.ResolveDetailed(user.Value, $"secret://{row.Provider}/{row.Name}", tool, bot, destination, null, "owner");
            var allowed = resolved.Deny == null && resolved.Value != null;
            if (resolved.Value != null) CryptographicOperations.ZeroMemory(resolved.Value);
            return Results.Json(new { allowed, reason = resolved.Deny });
        });

        app.MapPost("/api/admin/secrets/reencrypt", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if ((await Role(platform, user.Value)) != "owner") return Results.Json(new { error = "forbidden" }, statusCode: 403);
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = (await conn.QueryAsync<(Guid Id, Guid Owner, string Type, int Version, byte[] Cipher, byte[] Nonce)>(
                "SELECT id, owner_user_id, type, key_version, ciphertext, nonce FROM secrets WHERE revoked_at IS NULL")).ToArray();
            var changed = 0;
            foreach (var row in rows)
            {
                if (row.Version == KeyEncryption.KeyVersion) continue;
                try
                {
                    var plain = KeyEncryption.Decrypt(platform.MasterKey, row.Id, row.Owner, row.Type, row.Version, row.Cipher, row.Nonce);
                    var (cipher, nonce) = KeyEncryption.Encrypt(platform.MasterKey, row.Id, row.Owner, row.Type, KeyEncryption.KeyVersion, plain);
                    CryptographicOperations.ZeroMemory(plain);
                    await conn.ExecuteAsync("UPDATE secrets SET ciphertext=@cipher, nonce=@nonce, key_version=@version, updated_at=now() WHERE id=@id", new { id = row.Id, cipher, nonce, version = KeyEncryption.KeyVersion });
                    changed++;
                }
                catch (CryptographicException)
                {
                    await platform.SecretEvent(row.Id, "secret.denied", "reencrypt", null, null, null, null, "deny", "corrupted_ciphertext");
                }
            }
            return Results.Json(new { ok = true, examined = rows.Length, changed });
        });

        app.MapGet("/api/notifications", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync("SELECT id, kind, title, body, read_at, created_at FROM notifications WHERE user_id=@id ORDER BY created_at DESC LIMIT 40", new { id = user });
            return Results.Json(rows.Select(Platform.ToDict));
        });

        app.MapPost("/api/notifications/read", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            await conn.ExecuteAsync("UPDATE notifications SET read_at=now() WHERE user_id=@id AND read_at IS NULL", new { id = user });
            return Results.Json(new { ok = true });
        });
    }

    private static async Task<Guid?> User(HttpContext ctx, Platform platform)
    {
        ctx.Request.Cookies.TryGetValue("teammates_session", out var token);
        return await platform.UserForSession(token);
    }

    private static async Task<string?> Role(Platform platform, Guid id)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        return await conn.ExecuteScalarAsync<string>("SELECT role FROM users WHERE id=@id", new { id });
    }

    private static async Task<Guid?> Computer(Platform platform, Guid user)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        return await conn.ExecuteScalarAsync<Guid?>("SELECT computer_id FROM user_computers WHERE user_id=@id", new { id = user });
    }

    private static async Task<(ulong? Used, long Quota, bool Enforced)> DiskUsage(Platform platform, Guid user, CancellationToken ct)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var quota = await conn.ExecuteScalarAsync<long?>("SELECT disk_bytes FROM user_quotas WHERE user_id=@id", new { id = user });
        var computer = await conn.ExecuteScalarAsync<Guid?>("SELECT computer_id FROM user_computers WHERE user_id=@id", new { id = user });
        ulong? used = null;
        var enforced = false;
        if (computer != null)
        {
            var sample = await platform.Compute.TryDiskAsync(new ComputerId(computer.Value.ToString()), ct);
            used = sample.Used;
            enforced = sample.Enforced;
        }
        var limit = quota is null or <= 0 ? (long)DiskQuota.DefaultBytes : quota.Value;
        return (used, limit, enforced);
    }

    private static string Hash(string token) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();
}
