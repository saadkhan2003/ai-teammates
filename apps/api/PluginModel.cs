using System.Text.Json;
using Dapper;

namespace Teammates.Api;

/// <summary>
/// One plugin record covers MCP servers, OpenAPI-generated APIs, built-ins, and OAuth apps.
/// Connector and OAuth credential type names are aliases for PLUGIN_CREDENTIAL.
/// </summary>
public static class PluginModel
{
    private static readonly HashSet<string> AuthTypes = new(StringComparer.Ordinal) { "none", "api_key", "oauth" };
    private static readonly HashSet<string> Labels = new(StringComparer.Ordinal) { "listed", "auto-checked", "tested", "failed", "needs-auth" };
    private static readonly HashSet<string> Trusts = new(StringComparer.Ordinal) { "community", "official", "verified" };
    private static readonly HashSet<string> Risks = new(StringComparer.Ordinal) { "unknown", "low", "medium", "high" };

    public static string NormalizeSecretType(string? type)
    {
        var key = (type ?? "GENERIC").Trim().ToUpperInvariant().Replace(' ', '_').Replace('-', '_');
        return key switch
        {
            "CONNECTOR" or "CONNECTOR_CREDENTIAL" or "CONNECTOR_CREDENTIALS" or "OAUTH_CREDENTIAL" or "OAUTH_CREDENTIALS" or "PLUGIN" or "PLUGIN_CREDENTIALS" or "OAUTH" => "PLUGIN_CREDENTIAL",
            "" => "GENERIC",
            _ => key
        };
    }

    public static string NormalizePluginKind(string? kind)
    {
        var key = (kind ?? "openapi").Trim().ToLowerInvariant();
        return key switch
        {
            "" or "http" or "openapi" or "rest" => "openapi",
            "mcp" or "stdio" or "sse" or "streamable-http" => "mcp",
            "builtin" or "built-in" or "built_in" => "builtin",
            "oauth" or "oauth2" => "oauth",
            _ => key
        };
    }

    public static void Map(WebApplication app, Platform platform)
    {
        app.MapGet("/api/plugins", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync(
                """
                SELECT id, bot_id, name, kind, transport, auth_type, category, risk, trust, label, status,
                       secret_id, base_url, manifest::text AS manifest, created_at, catalog_id, publisher, source_url, version
                FROM plugins WHERE owner_user_id=@id ORDER BY created_at DESC
                """,
                new { id = user });
            return Results.Json(rows.Select(Platform.ToDict));
        });

        app.MapPost("/api/plugins", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var name = Text(body, "name").Trim();
            if (name.Length == 0 || name.Length > 200) return Results.BadRequest(new { error = "name is required" });
            var kind = NormalizePluginKind(Text(body, "kind"));
            var auth = Text(body, "authType", "none").Trim().ToLowerInvariant();
            var label = Text(body, "label", "listed").Trim().ToLowerInvariant();
            var trust = Text(body, "trust", "community").Trim().ToLowerInvariant();
            var risk = Text(body, "risk", "unknown").Trim().ToLowerInvariant();
            if (!AuthTypes.Contains(auth)) return Results.BadRequest(new { error = "invalid auth type" });
            if (!Labels.Contains(label)) return Results.BadRequest(new { error = "invalid label" });
            if (!Trusts.Contains(trust)) return Results.BadRequest(new { error = "invalid trust" });
            if (!Risks.Contains(risk)) return Results.BadRequest(new { error = "invalid risk" });
            Guid? botId = GuidText(body, "botId");
            Guid? secretId = GuidText(body, "secretId");
            await using var conn = await platform.Data.OpenConnectionAsync();
            if (botId != null)
            {
                var owns = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM bots WHERE id=@id AND owner_id=@owner", new { id = botId, owner = user });
                if (owns == 0) return Results.BadRequest(new { error = "unknown bot" });
            }
            if (secretId != null)
            {
                var owns = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM secrets WHERE id=@id AND owner_user_id=@owner", new { id = secretId, owner = user });
                if (owns == 0) return Results.BadRequest(new { error = "unknown secret" });
            }
            var manifest = "{}";
            if (body.TryGetProperty("manifest", out var manifestEl) && manifestEl.ValueKind is JsonValueKind.Object or JsonValueKind.Array)
                manifest = manifestEl.GetRawText();
            var id = await conn.ExecuteScalarAsync<Guid>(
                """
                INSERT INTO plugins (owner_user_id, bot_id, name, kind, transport, manifest, auth_type, category, risk, trust, label, status, secret_id, base_url)
                VALUES (@owner, @bot, @name, @kind, @transport, CAST(@manifest AS jsonb), @auth, @category, @risk, @trust, @label, 'installed', @secret, @baseUrl)
                RETURNING id
                """,
                new
                {
                    owner = user,
                    bot = botId,
                    name,
                    kind,
                    transport = Text(body, "transport"),
                    manifest,
                    auth,
                    category = Text(body, "category"),
                    risk,
                    trust,
                    label,
                    secret = secretId,
                    baseUrl = Text(body, "baseUrl")
                });
            var row = await conn.QuerySingleAsync(
                """
                SELECT id, bot_id, name, kind, transport, auth_type, category, risk, trust, label, status,
                       secret_id, base_url, manifest::text AS manifest, created_at
                FROM plugins WHERE id=@id
                """,
                new { id });
            return Results.Json(Platform.ToDict(row));
        });

        app.MapDelete("/api/plugins/{id:guid}", async (HttpContext ctx, Guid id) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var n = await conn.ExecuteAsync("DELETE FROM plugins WHERE id=@id AND owner_user_id=@owner", new { id, owner = user });
            return n == 0 ? Results.NotFound() : Results.Json(new { ok = true });
        });
    }

    private static async Task<Guid?> User(HttpContext ctx, Platform platform)
    {
        ctx.Request.Cookies.TryGetValue("teammates_session", out var token);
        return await platform.UserForSession(token);
    }

    private static string Text(JsonElement body, string name, string fallback = "")
    {
        if (!body.TryGetProperty(name, out var el) || el.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            return fallback;
        return el.ValueKind == JsonValueKind.String ? el.GetString() ?? fallback : fallback;
    }

    private static Guid? GuidText(JsonElement body, string name)
    {
        var text = Text(body, name);
        return Guid.TryParse(text, out var id) ? id : null;
    }
}
