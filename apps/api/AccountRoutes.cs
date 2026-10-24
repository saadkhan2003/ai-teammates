using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Amazon.S3.Model;
using Dapper;

namespace Teammates.Api;

public static class AccountRoutes
{
    private static readonly AccountRateLimiter Limits = new();
    private const int AvatarLimit = 2 * 1024 * 1024;
    private const int AttachmentLimit = 2 * 1024 * 1024;
    private static readonly HttpClient WorkerHealth = new() { Timeout = TimeSpan.FromSeconds(2) };

    public static void Map(WebApplication app, Platform platform)
    {
        app.MapGet("/api/pricing", async () =>
        {
            await using var db = await platform.Data.OpenConnectionAsync();
            var config = await db.QuerySingleOrDefaultAsync<(decimal? Rate, string Plans)>("SELECT currency_rate_pkr_per_usd AS rate,plans::text FROM billing_configuration WHERE id=true");
            object plans = config.Plans is null ? Array.Empty<object>() : JsonSerializer.Deserialize<JsonElement>(config.Plans);
            return Results.Json(new { currencyRatePkrPerUsd = config.Rate, plans });
        });
        app.MapGet("/api/billing", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized();
            await using var db = await platform.Data.OpenConnectionAsync();
            var usage = await db.QuerySingleAsync<(long Calls, decimal Cost, double Latency)>("SELECT count(*) AS calls,coalesce(sum(cost_usd),0) AS cost,coalesce(avg(latency_ms),0)::float8 AS latency FROM model_calls WHERE owner_id=@user AND created_at >= date_trunc('month',now())", new { user });
            var breakdown = await db.QueryAsync("SELECT role AS category,count(*) AS calls,coalesce(sum(cost_usd),0) AS cost_usd FROM model_calls WHERE owner_id=@user AND created_at >= date_trunc('month',now()) GROUP BY role ORDER BY cost_usd DESC", new { user });
            var planConfig = await db.QuerySingleOrDefaultAsync<(decimal? Rate, string Plans)>("SELECT currency_rate_pkr_per_usd AS rate,plans::text FROM billing_configuration WHERE id=true");
            return Results.Json(new { plan = (string?)null, creditBalance = (decimal?)null, periodStart = DateTimeOffset.UtcNow.Date.AddDays(1 - DateTimeOffset.UtcNow.Day), periodEnd = DateTimeOffset.UtcNow.Date.AddMonths(1).AddDays(1 - DateTimeOffset.UtcNow.Day), usage = new { modelCalls = usage.Calls, costUsd = usage.Cost, latencyMs = usage.Latency }, breakdown, invoices = Array.Empty<object>(), pricingConfigured = planConfig.Plans is not null && planConfig.Plans != "[]" });
        });
        app.MapGet("/api/admin/billing/config", async (HttpContext ctx) =>
        {
            var (user, denied) = await Staff(ctx, platform); if (denied is not null) return denied;
            await using var db = await platform.Data.OpenConnectionAsync();
            var config = await db.QuerySingleOrDefaultAsync<(decimal? Rate, string Plans)>("SELECT currency_rate_pkr_per_usd AS rate,plans::text FROM billing_configuration WHERE id=true");
            object plans = config.Plans is null ? Array.Empty<object>() : JsonSerializer.Deserialize<JsonElement>(config.Plans);
            return Results.Json(new { currencyRatePkrPerUsd = config.Rate, plans });
        });
        app.MapPut("/api/admin/billing/config", async (HttpContext ctx, JsonElement body) =>
        {
            var (user, denied) = await Staff(ctx, platform); if (denied is not null) return denied; if (!SameOrigin(ctx)) return Results.StatusCode(403);
            decimal? rate = body.TryGetProperty("currencyRatePkrPerUsd", out var rateElement) && rateElement.ValueKind == JsonValueKind.Number ? rateElement.GetDecimal() : null;
            if (rate is <= 0 or > 100000) return Results.BadRequest(new { error = "invalid_exchange_rate" });
            if (!body.TryGetProperty("plans", out var plans) || plans.ValueKind != JsonValueKind.Array || plans.GetArrayLength() > 20) return Results.BadRequest(new { error = "invalid_plans" });
            foreach (var plan in plans.EnumerateArray())
            {
                if (plan.ValueKind != JsonValueKind.Object || !plan.TryGetProperty("name", out var name) || name.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(name.GetString()) || name.GetString()!.Length > 80) return Results.BadRequest(new { error = "invalid_plans" });
                if (plan.TryGetProperty("priceUsd", out var price) && price.ValueKind != JsonValueKind.Null && (price.ValueKind != JsonValueKind.Number || price.GetDecimal() < 0 || price.GetDecimal() > 1000000)) return Results.BadRequest(new { error = "invalid_plans" });
            }
            var plansJson = plans.GetRawText(); await using var db = await platform.Data.OpenConnectionAsync();
            await db.ExecuteAsync("INSERT INTO billing_configuration(id,currency_rate_pkr_per_usd,plans,updated_by,updated_at) VALUES(true,@rate,@plans::jsonb,@user,now()) ON CONFLICT(id) DO UPDATE SET currency_rate_pkr_per_usd=excluded.currency_rate_pkr_per_usd,plans=excluded.plans,updated_by=excluded.updated_by,updated_at=now()", new { rate, plans = plansJson, user });
            await platform.Audit(user!.Value.ToString(), "billing.configuration_updated", null, null, new { planCount = plans.GetArrayLength(), rateConfigured = rate.HasValue });
            return Results.Json(new { ok = true });
        });
        app.MapPost("/api/auth/login/totp", async (HttpContext ctx, JsonElement body) =>
        {
            if (!SameOrigin(ctx)) return Results.StatusCode(403);
            ctx.Request.Cookies.TryGetValue("teammates_login_challenge", out var challenge);
            if (string.IsNullOrWhiteSpace(challenge) || !Limits.Allow("login-totp:" + TokenDigest(challenge))) return Results.Json(new { error = "invalid_credentials" }, statusCode: 401);
            var digest = TokenDigest(challenge);
            await using var db = await platform.Data.OpenConnectionAsync();
            var user = await db.ExecuteScalarAsync<Guid?>("SELECT user_id FROM login_totp_challenges WHERE token_hash=@digest AND expires_at>now()", new { digest });
            if (user is null) return Results.Json(new { error = "invalid_credentials" }, statusCode: 401);
            var row = await db.QuerySingleAsync<(byte[]? Cipher, byte[]? Nonce, string[] Recovery)>("SELECT totp_secret,totp_nonce,recovery_code_hashes FROM users WHERE id=@user AND totp_enabled=true", new { user });
            if (row.Cipher is null || row.Nonce is null) return Results.Json(new { error = "invalid_credentials" }, statusCode: 401);
            var code = Text(body, "code"); var secret = KeyEncryption.Decrypt(platform.MasterKey, user.Value, user.Value, "TOTP", KeyEncryption.KeyVersion, row.Cipher, row.Nonce);
            var validTotp = Totp.Verify(secret, code);
            var recoveryHash = Hash(code);
            if (!validTotp && !row.Recovery.Contains(recoveryHash, StringComparer.Ordinal)) return Results.Json(new { error = "invalid_credentials" }, statusCode: 401);
            if (!validTotp) await db.ExecuteAsync("UPDATE users SET recovery_code_hashes=array_remove(recovery_code_hashes,@recoveryHash) WHERE id=@user", new { user, recoveryHash });
            await db.ExecuteAsync("DELETE FROM login_totp_challenges WHERE token_hash=@digest", new { digest });
            ctx.Response.Cookies.Delete("teammates_login_challenge");
            await EstablishSession(ctx, platform, user.Value);
            return Results.Json(new { ok = true });
        });
        app.MapGet("/api/account", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized();
            await using var db = await platform.Data.OpenConnectionAsync();
            var me = await db.QuerySingleAsync("SELECT id,username,email,display_name AS \"displayName\",timezone,locale,notification_preferences::text AS preferences,avatar_url AS \"avatarUrl\",totp_enabled AS \"totpEnabled\",role FROM users WHERE id=@user", new { user });
            return Results.Json(me);
        });
        app.MapPut("/api/account/profile", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized();
            if (!SameOrigin(ctx)) return Results.StatusCode(403);
            var name = Text(body, "displayName").Trim(); var timezone = Text(body, "timezone").Trim(); var locale = Text(body, "locale").Trim();
            if (name.Length is < 1 or > 80 || !RoutineTime.TryZone(timezone, out _) || locale is not ("en" or "ur")) return Results.BadRequest(new { error = "invalid_profile" });
            var prefs = body.TryGetProperty("notifications", out var p) && p.ValueKind == JsonValueKind.Object ? p.GetRawText() : "{}";
            try { using var parsed = JsonDocument.Parse(prefs); if (parsed.RootElement.ValueKind != JsonValueKind.Object) return Results.BadRequest(); } catch { return Results.BadRequest(); }
            await using var db = await platform.Data.OpenConnectionAsync();
            await db.ExecuteAsync("UPDATE users SET display_name=@name,timezone=@timezone,locale=@locale,notification_preferences=@prefs::jsonb WHERE id=@user", new { user, name, timezone, locale, prefs });
            await platform.Audit(user.Value.ToString(), "account.profile_updated", null, null, new { timezone, locale });
            return Results.Json(new { ok = true });
        });
        app.MapPost("/api/account/email", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized();
            if (!SameOrigin(ctx)) return Results.StatusCode(403);
            var email = Text(body, "email").Trim();
            if (email.Length > 254 || !System.Net.Mail.MailAddress.TryCreate(email, out var parsed) || parsed.Address != email) return Results.BadRequest(new { error = "invalid_email" });
            // Sending is not configured. Do not alter the account or reveal whether the address belongs to anyone.
            await platform.Audit(user.Value.ToString(), "account.email_verification_requested", null, null, new { requested = true });
            return Results.Json(new { ok = true, verificationSent = false, message = "Email sending is not configured. Your email has not changed." });
        });
        app.MapPost("/api/account/password", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized();
            if (!SameOrigin(ctx)) return Results.StatusCode(403);
            if (!Limits.Allow($"password:{user}")) return Results.StatusCode(429);
            var current = Text(body, "currentPassword"); var next = Text(body, "newPassword");
            if (next.Length < 12 || next.Length > 256 || !next.Any(char.IsLetter) || !next.Any(char.IsDigit)) return Results.BadRequest(new { error = "weak_password" });
            await using var db = await platform.Data.OpenConnectionAsync();
            var hash = await db.ExecuteScalarAsync<string>("SELECT password_hash FROM users WHERE id=@user", new { user });
            if (!Passwords.Verify(current, hash ?? "")) return Results.Json(new { error = "invalid_credentials" }, statusCode: 401);
            await db.ExecuteAsync("UPDATE users SET password_hash=@hash WHERE id=@user", new { user, hash = Passwords.Hash(next) });
            await platform.Audit(user.Value.ToString(), "account.password_changed", null, null, new { });
            return Results.Json(new { ok = true });
        });
        app.MapGet("/api/account/sessions", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized();
            var token = TokenHash(ctx); await using var db = await platform.Data.OpenConnectionAsync();
            await db.ExecuteAsync("UPDATE sessions SET last_active_at=now() WHERE token_hash=@token AND user_id=@user", new { user, token });
            var rows = await db.QueryAsync<(Guid Id, string UserAgent, string? Ip, DateTime LastActive, bool Current)>("SELECT id,user_agent,host(ip_address) AS ip,last_active_at AS last_active,token_hash=@token AS current FROM sessions WHERE user_id=@user AND expires_at>now() ORDER BY last_active_at DESC", new { user, token });
            return Results.Json(rows.Select(r => new { id = r.Id, device = DeviceName(r.UserAgent), browser = BrowserName(r.UserAgent), ip = r.Ip, lastActive = r.LastActive, current = r.Current }));
        });
        app.MapDelete("/api/account/sessions/{id:guid}", async (HttpContext ctx, Guid id) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized(); if (!SameOrigin(ctx)) return Results.StatusCode(403);
            await using var db = await platform.Data.OpenConnectionAsync(); var targetOwner = await db.ExecuteScalarAsync<Guid?>("SELECT user_id FROM sessions WHERE id=@id AND token_hash<>@token", new { id, token = TokenHash(ctx) });
            if (targetOwner is null || !AccountSecurityPolicy.CanRevokeSession(targetOwner.Value, user.Value, false)) return Results.NotFound();
            var count = await db.ExecuteAsync("DELETE FROM sessions WHERE id=@id AND user_id=@user AND token_hash<>@token", new { id, user, token = TokenHash(ctx) });
            if (count > 0) await platform.Audit(user.Value.ToString(), "account.session_revoked", null, null, new { });
            return count == 0 ? Results.NotFound() : Results.Json(new { ok = true });
        });
        app.MapPost("/api/account/sessions/revoke-others", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized(); if (!SameOrigin(ctx)) return Results.StatusCode(403);
            await using var db = await platform.Data.OpenConnectionAsync(); var count = await db.ExecuteAsync("DELETE FROM sessions WHERE user_id=@user AND token_hash<>@token", new { user, token = TokenHash(ctx) });
            await platform.Audit(user.Value.ToString(), "account.sessions_revoked", null, null, new { count }); return Results.Json(new { ok = true, revoked = count });
        });
        app.MapPost("/api/account/totp/setup", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized(); if (!SameOrigin(ctx)) return Results.StatusCode(403);
            await using var db = await platform.Data.OpenConnectionAsync();
            if (await db.ExecuteScalarAsync<bool>("SELECT totp_enabled FROM users WHERE id=@user", new { user })) return Results.Conflict(new { error = "already_enabled" });
            var secret = Totp.NewSecret(); var (cipher, nonce) = KeyEncryption.Encrypt(platform.MasterKey, user.Value, user.Value, "TOTP", KeyEncryption.KeyVersion, secret);
            await db.ExecuteAsync("UPDATE users SET totp_secret=@cipher,totp_nonce=@nonce,totp_enabled=false WHERE id=@user", new { user, cipher, nonce });
            var b32 = Base32(secret); var account = Uri.EscapeDataString("Teammates"); var label = Uri.EscapeDataString($"Teammates:{user.Value}");
            return Results.Json(new { secret = b32, otpauth = $"otpauth://totp/{label}?secret={b32}&issuer={account}&algorithm=SHA1&digits=6&period=30" });
        });
        app.MapPost("/api/account/totp/verify", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized(); if (!SameOrigin(ctx)) return Results.StatusCode(403); if (!Limits.Allow($"totp:{user}")) return Results.StatusCode(429);
            await using var db = await platform.Data.OpenConnectionAsync(); var row = await db.QuerySingleOrDefaultAsync<(byte[]? Cipher, byte[]? Nonce)>("SELECT totp_secret,totp_nonce FROM users WHERE id=@user", new { user });
            if (row.Cipher is null || row.Nonce is null) return Results.BadRequest(new { error = "setup_required" });
            // Column is encrypted using a stable per-user purpose identifier.
            var secret = KeyEncryption.Decrypt(platform.MasterKey, user.Value, user.Value, "TOTP", KeyEncryption.KeyVersion, row.Cipher, row.Nonce);
            if (!Totp.Verify(secret, Text(body, "code"))) return Results.BadRequest(new { error = "invalid_code" });
            var recovery = Enumerable.Range(0, 8).Select(_ => Convert.ToHexString(RandomNumberGenerator.GetBytes(5)).ToLowerInvariant()).ToArray();
            await db.ExecuteAsync("UPDATE users SET totp_enabled=true,recovery_code_hashes=@hashes WHERE id=@user", new { user, hashes = recovery.Select(Hash).ToArray() });
            await platform.Audit(user.Value.ToString(), "account.totp_enabled", null, null, new { }); return Results.Json(new { recoveryCodes = recovery });
        });
        app.MapPost("/api/account/totp/disable", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized(); if (!SameOrigin(ctx)) return Results.StatusCode(403);
            await using var db = await platform.Data.OpenConnectionAsync(); var hash = await db.ExecuteScalarAsync<string>("SELECT password_hash FROM users WHERE id=@user", new { user });
            if (!Passwords.Verify(Text(body, "password"), hash ?? "")) return Results.Json(new { error = "invalid_credentials" }, statusCode: 401);
            await db.ExecuteAsync("UPDATE users SET totp_secret=NULL,totp_nonce=NULL,totp_enabled=false,recovery_code_hashes='{}' WHERE id=@user", new { user });
            await platform.Audit(user.Value.ToString(), "account.totp_disabled", null, null, new { }); return Results.Json(new { ok = true });
        });
        app.MapPost("/api/account/avatar", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized(); if (!SameOrigin(ctx)) return Results.StatusCode(403);
            var form = await ctx.Request.ReadFormAsync(); var file = form.Files.GetFile("avatar"); if (file is null || file.Length is < 1 or > AvatarLimit) return Results.BadRequest(new { error = "avatar_size_limit_2mb" });
            var mime = file.ContentType.ToLowerInvariant(); if (mime is not ("image/png" or "image/jpeg" or "image/webp")) return Results.BadRequest(new { error = "avatar_type_must_be_png_jpeg_or_webp" });
            await using var verification = file.OpenReadStream(); var header = new byte[12]; var read = await verification.ReadAsync(header);
            var signatureValid = mime switch
            {
                "image/png" => read >= 8 && header.AsSpan(0, 8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }),
                "image/jpeg" => read >= 3 && header[0] == 0xff && header[1] == 0xd8 && header[2] == 0xff,
                "image/webp" => read >= 12 && Encoding.ASCII.GetString(header, 0, 4) == "RIFF" && Encoding.ASCII.GetString(header, 8, 4) == "WEBP",
                _ => false
            };
            if (!signatureValid) return Results.BadRequest(new { error = "invalid_image" });
            var ext = mime == "image/png" ? "png" : mime == "image/webp" ? "webp" : "jpg"; var key = $"user-avatars/{user.Value:N}.{ext}";
            await using var stream = file.OpenReadStream(); await platform.S3.PutObjectAsync(new PutObjectRequest { BucketName = platform.Bucket, Key = key, InputStream = stream, ContentType = mime });
            await using var db = await platform.Data.OpenConnectionAsync(); await db.ExecuteAsync("UPDATE users SET avatar_url=@url WHERE id=@user", new { user, url = key });
            await platform.Audit(user.Value.ToString(), "account.avatar_updated", null, null, new { contentType = mime, size = file.Length });
            return Results.Json(new { ok = true, avatarUrl = "/api/account/avatar" });
        }).DisableAntiforgery();
        app.MapGet("/api/account/avatar", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized();
            await using var db = await platform.Data.OpenConnectionAsync(); var objectKey = await db.ExecuteScalarAsync<string>("SELECT avatar_url FROM users WHERE id=@user", new { user });
            if (string.IsNullOrWhiteSpace(objectKey)) return Results.NotFound();
            var obj = await platform.S3.GetObjectAsync(platform.Bucket, objectKey); return Results.Stream(obj.ResponseStream, obj.Headers.ContentType);
        });
        app.MapDelete("/api/account", async (HttpContext ctx, [Microsoft.AspNetCore.Mvc.FromBody] JsonElement body) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized(); if (!SameOrigin(ctx)) return Results.StatusCode(403);
            if (!AccountSecurityPolicy.HasDeleteConfirmation(Text(body, "confirmation"))) return Results.BadRequest(new { error = "confirmation_mismatch" });
            await using var db = await platform.Data.OpenConnectionAsync(); var hash = await db.ExecuteScalarAsync<string>("SELECT password_hash FROM users WHERE id=@user", new { user });
            if (!Passwords.Verify(Text(body, "password"), hash ?? "")) return Results.Json(new { error = "invalid_credentials" }, statusCode: 401);
            await platform.Audit(user.Value.ToString(), "account.deleted", null, null, new { policy = "immediate" }); await db.ExecuteAsync("DELETE FROM users WHERE id=@user", new { user });
            ctx.Response.Cookies.Delete("teammates_session"); return Results.Json(new { ok = true, policy = "immediate" });
        });

        app.MapPost("/api/support/tickets", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized(); if (!SameOrigin(ctx)) return Results.StatusCode(403);
            var category = Text(body, "category"); var subject = Text(body, "subject").Trim(); var message = Text(body, "message").Trim();
            if (!Limits.Allow($"ticket:{user}", 5, TimeSpan.FromHours(1))) return Results.StatusCode(429);
            if (category is not ("account" or "billing" or "bug" or "feedback" or "other") || subject.Length is < 3 or > 160 || message.Length is < 10 or > 10000) return Results.BadRequest(new { error = "invalid_ticket" });
            var name = Text(body, "attachmentName"); var type = Text(body, "attachmentType"); byte[]? data = null;
            if (body.TryGetProperty("attachmentBase64", out var att) && att.ValueKind == JsonValueKind.String)
            {
                try { data = Convert.FromBase64String(att.GetString() ?? ""); } catch { return Results.BadRequest(new { error = "invalid_attachment" }); }
                if (data.Length > AttachmentLimit || name.Length > 180 || type.Length > 120) return Results.BadRequest(new { error = "attachment_limit_2mb" });
                if (type is not ("image/png" or "image/jpeg" or "application/pdf" or "text/plain")) return Results.BadRequest(new { error = "unsupported_attachment_type" });
            }
            await using var db = await platform.Data.OpenConnectionAsync(); await using var tx = await db.BeginTransactionAsync();
            var id = await db.ExecuteScalarAsync<Guid>("INSERT INTO support_tickets(user_id,category,subject) VALUES(@user,@category,@subject) RETURNING id", new { user, category, subject }, tx);
            await db.ExecuteAsync("INSERT INTO support_ticket_messages(ticket_id,author_user_id,body,attachment_name,attachment_content_type,attachment_data) VALUES(@id,@user,@message,@name,@type,@data)", new { id, user, message, name = data is null ? null : name, type = data is null ? null : type, data }, tx); await tx.CommitAsync();
            await platform.Audit(user.Value.ToString(), "support.ticket_created", null, null, new { ticketId = id, category }); return Results.Json(new { id, status = "open" });
        });
        app.MapGet("/api/support/tickets", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized(); await using var db = await platform.Data.OpenConnectionAsync();
            return Results.Json(await db.QueryAsync("SELECT id,category,subject,status,created_at,updated_at FROM support_tickets WHERE user_id=@user ORDER BY updated_at DESC", new { user }));
        });
        app.MapGet("/api/support/tickets/{id:guid}", async (HttpContext ctx, Guid id) => await TicketDetail(ctx, platform, id, false));
        app.MapGet("/api/admin/support/tickets", async (HttpContext ctx) =>
        {
            var (user, denied) = await Staff(ctx, platform); if (denied is not null) return denied; await using var db = await platform.Data.OpenConnectionAsync();
            return Results.Json(await db.QueryAsync("SELECT t.id,t.category,t.subject,t.status,t.created_at,t.updated_at,u.username FROM support_tickets t JOIN users u ON u.id=t.user_id ORDER BY t.updated_at DESC LIMIT 200"));
        });
        app.MapGet("/api/admin/support/tickets/{id:guid}", async (HttpContext ctx, Guid id) => await TicketDetail(ctx, platform, id, true));
        app.MapPost("/api/admin/support/tickets/{id:guid}/messages", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var (user, denied) = await Staff(ctx, platform); if (denied is not null) return denied; if (!SameOrigin(ctx)) return Results.StatusCode(403);
            var text = Text(body, "message").Trim(); if (text.Length is < 1 or > 10000) return Results.BadRequest(); await using var db = await platform.Data.OpenConnectionAsync();
            if (await db.ExecuteAsync("INSERT INTO support_ticket_messages(ticket_id,author_user_id,is_staff,body) SELECT @id,@user,true,@text WHERE EXISTS(SELECT 1 FROM support_tickets WHERE id=@id)", new { id, user, text }) == 0) return Results.NotFound();
            await db.ExecuteAsync("UPDATE support_tickets SET updated_at=now() WHERE id=@id", new { id }); await platform.Audit(user!.Value.ToString(), "support.ticket_replied", null, null, new { ticketId = id }); return Results.Json(new { ok = true });
        });
        app.MapPatch("/api/admin/support/tickets/{id:guid}", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var (user, denied) = await Staff(ctx, platform); if (denied is not null) return denied; if (!SameOrigin(ctx)) return Results.StatusCode(403);
            var status = Text(body, "status"); if (status is not ("open" or "in_progress" or "resolved" or "closed")) return Results.BadRequest(); await using var db = await platform.Data.OpenConnectionAsync();
            var n = await db.ExecuteAsync("UPDATE support_tickets SET status=@status,updated_at=now() WHERE id=@id", new { id, status }); if (n == 0) return Results.NotFound(); await platform.Audit(user!.Value.ToString(), "support.ticket_status_changed", null, null, new { ticketId = id, status }); return Results.Json(new { ok = true });
        });
        app.MapGet("/api/status/incidents", async () => { await using var db = await platform.Data.OpenConnectionAsync(); return Results.Json(await db.QueryAsync("SELECT id,title,status,details,created_at,updated_at FROM status_incidents ORDER BY created_at DESC LIMIT 100")); });
        app.MapGet("/api/status", async (HttpContext ctx) =>
        {
            var database = false; var computers = false; var worker = false; var computerCount = 0;
            try
            {
                await using var db = await platform.Data.OpenConnectionAsync(); database = await db.ExecuteScalarAsync<int>("SELECT 1") == 1;
                computerCount = await db.ExecuteScalarAsync<int>("SELECT count(*) FROM user_computers");
            }
            catch { }
            try { computers = (await platform.Compute.HealthCheckAsync(CancellationToken.None)).Healthy && platform.Compute.ComputerIsolationHealthy; } catch { computers = false; }
            try
            {
                var workerHealthUrl = platform.Configuration["WORKER_HEALTH_URL"] ?? "http://agent:7710/health";
                using var response = await WorkerHealth.GetAsync(workerHealthUrl, ctx.RequestAborted);
                worker = response.IsSuccessStatusCode;
            }
            catch { worker = false; }
            return Results.Json(new { components = new object[] { new { name = "API", status = "operational" }, new { name = "Database", status = database ? "operational" : "outage" }, new { name = "Computers", status = computers ? "operational" : "degraded", available = computerCount }, new { name = "Worker", status = worker ? "operational" : "outage" } } });
        });
        app.MapPost("/api/admin/status/incidents", async (HttpContext ctx, JsonElement body) =>
        {
            var (user, denied) = await Staff(ctx, platform); if (denied is not null) return denied; if (!SameOrigin(ctx)) return Results.StatusCode(403);
            var title = Text(body, "title").Trim(); var status = Text(body, "status"); var details = Text(body, "details").Trim(); if (title.Length is < 3 or > 180 || status.Length is < 3 or > 40 || details.Length > 10000) return Results.BadRequest();
            await using var db = await platform.Data.OpenConnectionAsync(); var id = await db.ExecuteScalarAsync<Guid>("INSERT INTO status_incidents(title,status,details,created_by) VALUES(@title,@status,@details,@user) RETURNING id", new { title, status, details, user }); await platform.Audit(user!.Value.ToString(), "status.incident_created", null, null, new { id }); return Results.Json(new { id });
        });
        app.MapPatch("/api/admin/status/incidents/{id:guid}", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var (user, denied) = await Staff(ctx, platform); if (denied is not null) return denied; if (!SameOrigin(ctx)) return Results.StatusCode(403);
            var title = Text(body, "title").Trim(); var status = Text(body, "status"); var details = Text(body, "details").Trim();
            if (title.Length is < 3 or > 180 || status.Length is < 3 or > 40 || details.Length > 10000) return Results.BadRequest();
            await using var db = await platform.Data.OpenConnectionAsync(); var count = await db.ExecuteAsync("UPDATE status_incidents SET title=@title,status=@status,details=@details,updated_at=now() WHERE id=@id", new { id, title, status, details });
            if (count == 0) return Results.NotFound(); await platform.Audit(user!.Value.ToString(), "status.incident_updated", null, null, new { id, status }); return Results.Json(new { ok = true });
        });
    }

    private static async Task<IResult> TicketDetail(HttpContext ctx, Platform p, Guid id, bool staffOnly)
    {
        var user = await User(ctx, p); if (user is null) return Results.Unauthorized(); await using var db = await p.Data.OpenConnectionAsync();
        var role = await db.ExecuteScalarAsync<string>("SELECT role FROM users WHERE id=@user", new { user }); var staff = Access.IsStaff(role);
        if (staffOnly && !AccountSecurityPolicy.CanManageSupport(role)) return Results.Json(new { error = "forbidden" }, statusCode: 403);
        var ticket = await db.QuerySingleOrDefaultAsync("SELECT t.id,t.user_id,t.category,t.subject,t.status,t.created_at,t.updated_at,u.username FROM support_tickets t JOIN users u ON u.id=t.user_id WHERE t.id=@id", new { id });
        if (ticket is not null && !AccountSecurityPolicy.CanReadTicket((Guid)ticket.user_id, user.Value, staff)) return Results.NotFound();
        if (ticket is null) return Results.NotFound(); var messages = await db.QueryAsync("SELECT id,author_user_id,is_staff,body,attachment_name,attachment_content_type,encode(attachment_data,'base64') AS attachment_base64,created_at FROM support_ticket_messages WHERE ticket_id=@id ORDER BY created_at", new { id });
        return Results.Json(new { ticket, messages });
    }
    private static async Task<(Guid? User, IResult? Denied)> Staff(HttpContext ctx, Platform p)
    { var u = await User(ctx, p); if (u is null) return (null, Results.Unauthorized()); await using var db = await p.Data.OpenConnectionAsync(); return AccountSecurityPolicy.CanManageSupport(await db.ExecuteScalarAsync<string>("SELECT role FROM users WHERE id=@u", new { u })) ? (u, null) : (u, Results.Json(new { error = "forbidden" }, statusCode: 403)); }
    private static Task<Guid?> User(HttpContext c, Platform p) { c.Request.Cookies.TryGetValue("teammates_session", out var token); return p.UserForSession(token); }
    private static bool SameOrigin(HttpContext ctx)
    {
        var origin = ctx.Request.Headers.Origin.ToString(); if (origin.Length == 0) return true;
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri) || !string.Equals(uri.Host, ctx.Request.Host.Host, StringComparison.OrdinalIgnoreCase)) return false;
        var expectedPort = ctx.Request.Host.Port ?? (ctx.Request.Headers["X-Forwarded-Proto"] == "https" ? 443 : 80);
        return uri.Port == expectedPort;
    }
    private static string Text(JsonElement body, string name) => body.ValueKind == JsonValueKind.Object && body.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
    private static string TokenHash(HttpContext ctx) { ctx.Request.Cookies.TryGetValue("teammates_session", out var token); return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token ?? ""))).ToLowerInvariant(); }
    private static string Hash(string value) => TokenDigest(value);
    private static string TokenDigest(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    private static string Base32(ReadOnlySpan<byte> data)
    { const string chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; var sb = new StringBuilder(); var buffer = 0; var bits = 0; foreach (var b in data) { buffer = (buffer << 8) | b; bits += 8; while (bits >= 5) { sb.Append(chars[(buffer >> (bits - 5)) & 31]); bits -= 5; } } if (bits > 0) sb.Append(chars[(buffer << (5 - bits)) & 31]); return sb.ToString(); }
    private static string DeviceName(string ua) => ua.Contains("Windows", StringComparison.OrdinalIgnoreCase) ? "Windows device" : ua.Contains("Mac OS", StringComparison.OrdinalIgnoreCase) ? "Mac device" : ua.Contains("Android", StringComparison.OrdinalIgnoreCase) ? "Android device" : ua.Contains("iPhone", StringComparison.OrdinalIgnoreCase) ? "iPhone" : ua.Contains("iPad", StringComparison.OrdinalIgnoreCase) ? "iPad" : ua.Contains("Linux", StringComparison.OrdinalIgnoreCase) ? "Linux device" : ua.Length == 0 ? "Unknown device" : "Device";
    private static string BrowserName(string ua) => ua.Contains("Edg/", StringComparison.OrdinalIgnoreCase) ? "Microsoft Edge" : ua.Contains("Firefox/", StringComparison.OrdinalIgnoreCase) ? "Firefox" : ua.Contains("Chrome/", StringComparison.OrdinalIgnoreCase) ? "Chrome" : ua.Contains("Safari/", StringComparison.OrdinalIgnoreCase) ? "Safari" : ua.Length == 0 ? "Unknown browser" : "Browser";

    public static async Task<IResult> StartLoginChallenge(HttpContext ctx, Platform p, Guid user)
    {
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant(); var digest = TokenDigest(token);
        await using var db = await p.Data.OpenConnectionAsync(); await db.ExecuteAsync("INSERT INTO login_totp_challenges(token_hash,user_id,expires_at) VALUES(@digest,@user,now()+interval '5 minutes') ON CONFLICT(token_hash) DO NOTHING", new { digest, user });
        ctx.Response.Cookies.Append("teammates_login_challenge", token, new CookieOptions { HttpOnly = true, SameSite = SameSiteMode.Lax, Secure = ctx.Request.Headers["X-Forwarded-Proto"] == "https", Path = "/api/auth/login/totp", MaxAge = TimeSpan.FromMinutes(5) });
        return Results.Json(new { totpRequired = true });
    }

    public static async Task EstablishSession(HttpContext ctx, Platform p, Guid user)
    {
        var token = await p.CreateSession(user); var hash = TokenDigest(token);
        var ip = ClientAddress.From(ctx); var ua = ctx.Request.Headers.UserAgent.ToString(); if (ua.Length > 500) ua = ua[..500];
        await using var db = await p.Data.OpenConnectionAsync(); await db.ExecuteAsync("UPDATE sessions SET user_agent=@ua,ip_address=CASE WHEN @ip ~ '^[0-9a-fA-F:.]+$' THEN @ip::inet ELSE NULL END,last_active_at=now() WHERE token_hash=@hash", new { hash, ua, ip });
        ctx.Response.Cookies.Append("teammates_session", token, new CookieOptions { HttpOnly = true, SameSite = SameSiteMode.Lax, Secure = ctx.Request.Headers["X-Forwarded-Proto"] == "https", Path = "/", MaxAge = TimeSpan.FromDays(14) });
    }
}
