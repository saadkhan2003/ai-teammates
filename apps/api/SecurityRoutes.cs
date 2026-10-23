using System.Text.Json;
using System.Text.RegularExpressions;
using Dapper;

namespace Teammates.Api;

public static partial class SecurityRoutes
{
    [GeneratedRegex("^[a-z][a-z0-9_]{2,40}$", RegexOptions.CultureInvariant)]
    private static partial Regex CodePattern();

    public static void Map(WebApplication app, Platform platform, LoginFlow logins)
    {
        app.MapGet("/api/policy", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var policy = await Load(platform, user.Value);
            return Results.Json(new { classes = policy.Classes, modelAssist = policy.ModelAssist, privateHosts = policy.PrivateHosts, risky = ActionClasses.All.Where(name => ActionClasses.Defaults[name] != PolicyEngine.Allow).ToArray() });
        });

        app.MapPut("/api/policy", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var policy = UserPolicy.Parse(body.GetRawText());
            if (body.TryGetProperty("classes", out var classes))
            {
                foreach (var prop in classes.EnumerateObject())
                {
                    if (!ActionClasses.All.Contains(prop.Name)) return Results.BadRequest(new { error = "unknown class" });
                }
            }
            try
            {
                await PrivateHosts.PropagateAsync(platform, user.Value, policy.PrivateHosts, ctx.RequestAborted);
            }
            catch
            {
                return Results.Json(new { error = "private host policy could not be applied" }, statusCode: 503);
            }
            await using var conn = await platform.Data.OpenConnectionAsync();
            var json = JsonSerializer.Serialize(new { classes = policy.Classes, modelAssist = policy.ModelAssist, privateHosts = policy.PrivateHosts });
            await conn.ExecuteAsync(
                """
                INSERT INTO user_policies (user_id, settings, updated_at) VALUES (@id, @settings::jsonb, now())
                ON CONFLICT (user_id) DO UPDATE SET settings=EXCLUDED.settings, updated_at=now()
                """,
                new { id = user, settings = json });
            await platform.Audit(user.Value.ToString(), "policy.updated", null, null, new { classes = policy.Classes, modelAssist = policy.ModelAssist, privateHosts = policy.PrivateHosts });
            return Results.Json(new { ok = true, classes = policy.Classes, modelAssist = policy.ModelAssist, privateHosts = policy.PrivateHosts });
        });

        app.MapGet("/api/admin/policy/deny-list", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!Access.IsStaff(await Role(platform, user.Value))) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            await using var conn = await platform.Data.OpenConnectionAsync();
            var custom = (await conn.QueryAsync<(string Code, string Description, string Pattern)>("SELECT code, description, pattern FROM policy_deny_rules ORDER BY code")).ToArray();
            var builtins = HardDeny.Builtins.GroupBy(rule => HardDeny.Family(rule.Code)).Select(group => new
            {
                code = group.Key,
                description = Describe(group.Key),
                builtin = true,
                enabled = true
            });
            var extras = custom.Select(rule => new { code = rule.Code, description = rule.Description, pattern = rule.Pattern, builtin = false, enabled = true });
            return Results.Json(new { rules = builtins.Cast<object>().Concat(extras), note = "Built-in rules stay on. Approval cannot override them." });
        });

        app.MapPost("/api/admin/policy/deny-list", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!Access.IsStaff(await Role(platform, user.Value))) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            var code = (body.TryGetProperty("code", out var codeEl) ? codeEl.GetString() : "")?.Trim().ToLowerInvariant() ?? "";
            var pattern = (body.TryGetProperty("pattern", out var patternEl) ? patternEl.GetString() : "")?.Trim() ?? "";
            var description = (body.TryGetProperty("description", out var descriptionEl) ? descriptionEl.GetString() : "")?.Trim() ?? "";
            if (!CodePattern().IsMatch(code) || HardDeny.Builtins.Any(rule => HardDeny.Family(rule.Code) == code))
                return Results.BadRequest(new { error = "invalid code" });
            if (pattern.Length is < 3 or > 120 || description.Length is < 3 or > 200)
                return Results.BadRequest(new { error = "invalid pattern" });
            await using var conn = await platform.Data.OpenConnectionAsync();
            await conn.ExecuteAsync(
                """
                INSERT INTO policy_deny_rules (code, description, pattern, builtin) VALUES (@code, @description, @pattern, false)
                ON CONFLICT (code) DO UPDATE SET description=EXCLUDED.description, pattern=EXCLUDED.pattern
                """,
                new { code, description, pattern });
            await platform.Audit(user.Value.ToString(), "policy.deny_added", null, null, new { code });
            return Results.Json(new { ok = true, code });
        });

        app.MapDelete("/api/admin/policy/deny-list/{code}", async (HttpContext ctx, string code) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!Access.IsStaff(await Role(platform, user.Value))) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            if (HardDeny.Builtins.Any(rule => HardDeny.Family(rule.Code) == code))
                return Results.Json(new { error = "builtin rules cannot be removed" }, statusCode: 403);
            await using var conn = await platform.Data.OpenConnectionAsync();
            var removed = await conn.ExecuteAsync("DELETE FROM policy_deny_rules WHERE code=@code AND builtin=false", new { code });
            if (removed == 0) return Results.NotFound();
            await platform.Audit(user.Value.ToString(), "policy.deny_removed", null, null, new { code });
            return Results.Json(new { ok = true });
        });

        app.MapPost("/api/login-requests/{id:guid}", async (HttpContext ctx, Guid id) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            return await logins.Accept(ctx, user.Value, id);
        });

        app.MapPost("/api/login-requests/{id:guid}/cancel", async (HttpContext ctx, Guid id) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            return await logins.Cancel(user.Value, id);
        });

        app.MapGet("/internal/test/audit-chain", async (HttpContext ctx) =>
        {
            if (!platform.TestHooks || !Worker(ctx, platform)) return Results.NotFound();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = (await conn.QueryAsync<(long Id, string Prev, string Hash, string Canon)>(
                "SELECT id, prev_hash, row_hash, chain_canonical FROM audit_events ORDER BY id")).ToArray();
            var prev = AuditChain.Genesis;
            foreach (var row in rows)
            {
                if (!string.Equals(row.Prev, prev, StringComparison.Ordinal))
                    return Results.Json(new { ok = false, reason = "broken_link", id = row.Id });
                var expect = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(row.Canon ?? ""))).ToLowerInvariant();
                if (!string.Equals(expect, row.Hash, StringComparison.Ordinal))
                    return Results.Json(new { ok = false, reason = "hash_mismatch", id = row.Id });
                if ((row.Canon ?? "").Contains("CANARY", StringComparison.Ordinal) || (row.Canon ?? "").Contains("4242424242424242", StringComparison.Ordinal))
                    return Results.Json(new { ok = false, reason = "secret_in_chain", id = row.Id });
                prev = row.Hash;
            }
            var trigger = await conn.ExecuteScalarAsync<string>("SELECT tgname FROM pg_trigger WHERE tgname='audit_events_no_mutate'");
            if (trigger != "audit_events_no_mutate")
                return Results.Json(new { ok = false, reason = "missing_trigger" });
            if (rows.Length == 0) return Results.Json(new { ok = true, rows = 0 });
            var mutated = false;
            try
            {
                await conn.ExecuteAsync("UPDATE audit_events SET actor=actor WHERE id=(SELECT id FROM audit_events ORDER BY id DESC LIMIT 1)");
                mutated = true;
            }
            catch (Npgsql.PostgresException ex) when (ex.MessageText.Contains("append-only", StringComparison.Ordinal))
            {
                mutated = false;
            }
            return Results.Json(new { ok = !mutated, rows = rows.Length });
        });
    }

    public static async Task<UserPolicy> Load(Platform platform, Guid user)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        var json = await conn.ExecuteScalarAsync<string>("SELECT settings::text FROM user_policies WHERE user_id=@id", new { id = user });
        return UserPolicy.Parse(json);
    }

    public static async Task<DenyRule[]> DenyRules(Platform platform)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        var rows = await conn.QueryAsync<(string Code, string Pattern, bool Builtin)>("SELECT code, pattern, builtin FROM policy_deny_rules");
        return rows.Select(row => new DenyRule(row.Code, row.Pattern, row.Builtin)).ToArray();
    }

    private static string Describe(string code) => code switch
    {
        "move_money" => "Moving money between accounts",
        "trade_securities" => "Trading securities",
        "other_user_account" => "Accessing another user's account",
        "disable_audit" => "Disabling or truncating the audit log",
        "export_vault" => "Exporting the secret vault",
        _ => code
    };

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

    private static bool Worker(HttpContext ctx, Platform platform)
    {
        var header = ctx.Request.Headers.Authorization.ToString();
        var token = header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? header[7..].Trim() : "";
        var expected = System.Text.Encoding.UTF8.GetBytes(platform.WorkerToken);
        var presented = System.Text.Encoding.UTF8.GetBytes(token);
        return expected.Length > 0 && presented.Length == expected.Length && System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(presented, expected);
    }
}
