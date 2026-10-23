using System.Text.Json;
using System.Text.Json.Nodes;
using Dapper;
using Teammates.Compute;

namespace Teammates.Api;

public static class NetworkPolicyRoutes
{
    public const int DefaultMaxEntries = 500;
    public static int MaxEntries(IConfiguration config) =>
        int.TryParse(config["NETWORK_POLICY_MAX_ENTRIES"], out var value) && value is > 0 and <= DefaultMaxEntries ? value : DefaultMaxEntries;

    public static void MapNetworkPolicyRoutes(this WebApplication app, Platform platform)
    {
        app.MapGet("/api/network-policy", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform);
            if (user is null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var settings = await conn.ExecuteScalarAsync<string?>("SELECT settings::text FROM user_policies WHERE user_id=@user", new { user });
            var policy = Read(settings);
            return Results.Json(policy);
        });

        app.MapPut("/api/network-policy", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform);
            if (user is null) return Results.Unauthorized();
            if (ctx.Request.ContentLength is > 256_000) return Results.BadRequest(new { error = "network policy request too large" });
            if (body.ValueKind != JsonValueKind.Object) return Results.BadRequest(new { error = "invalid network policy" });
            try
            {
                await using var conn = await platform.Data.OpenConnectionAsync();
                await using var tx = await conn.BeginTransactionAsync();
                await conn.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtextextended(@user::text,0))", new { user = user.Value }, tx);
                var currentText = await conn.ExecuteScalarAsync<string?>("SELECT settings::text FROM user_policies WHERE user_id=@user", new { user = user.Value }, tx);
                _ = Read(currentText);
                var modeText = body.GetProperty("mode").GetString();
                var mode = modeText switch { "allow_all" => NetworkPolicyMode.AllowAll, "defaults_with_team" => NetworkPolicyMode.DefaultsWithTeam, "team_only" => NetworkPolicyMode.TeamOnly, _ => throw new ArgumentException("invalid network policy mode") };
                var entries = Strings(body, "entries");
                var groups = Strings(body, "groups");
                var locked = body.TryGetProperty("locked", out var lockedJson) && lockedJson.ValueKind == JsonValueKind.True;
                var failClosed = body.TryGetProperty("failClosed", out var failClosedJson) && failClosedJson.ValueKind == JsonValueKind.True;
                var max = MaxEntries(ctx.RequestServices.GetRequiredService<IConfiguration>());
                if (entries.Count + groups.Count > max) throw new ArgumentException($"network policy accepts at most {max} entries");
                IEnumerable<string> effective = locked ? entries : entries.Concat(groups);
                _ = new NetworkPolicy(mode, effective);
                var result = new { mode = modeText, entries, groups, locked, failClosed, version = Version(currentText) + 1, updatedAt = DateTimeOffset.UtcNow };
                var root = JsonNode.Parse(currentText ?? "{}") as JsonObject ?? new JsonObject();
                root["networkPolicy"] = JsonSerializer.SerializeToNode(result);
                var serialized = root.ToJsonString();
                await conn.ExecuteAsync("""
                    INSERT INTO user_policies(user_id,settings,updated_at) VALUES (@user,@settings::jsonb,now())
                    ON CONFLICT(user_id) DO UPDATE SET settings=EXCLUDED.settings,updated_at=now()
                    """, new { user = user.Value, settings = serialized }, tx);
                await tx.CommitAsync();
                await platform.Audit(user.Value.ToString(), "network_policy.changed", null, null,
                    new { mode = modeText, entries = entries.Count, groups = groups.Count, locked, version = result.version });
                return Results.Json(result);
            }
            catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or KeyNotFoundException or NullReferenceException)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });
    }

    private static object Read(string? settings) => ReadPolicy(settings);

    public static object ReadPolicy(string? settings)
    {
        try
        {
            using var doc = JsonDocument.Parse(settings ?? "{}");
            if (doc.RootElement.TryGetProperty("networkPolicy", out var policy)) return policy.Clone();
        }
        catch (JsonException) { }
        return new { mode = "team_only", entries = Array.Empty<string>(), groups = Array.Empty<string>(), locked = false, version = 0 };
    }

    private static int Version(string? settings)
    {
        try
        {
            using var doc = JsonDocument.Parse(settings ?? "{}");
            if (doc.RootElement.TryGetProperty("networkPolicy", out var policy) && policy.TryGetProperty("version", out var version) && version.TryGetInt32(out var value)) return Math.Max(0, value);
        }
        catch (JsonException) { }
        return 0;
    }

    private static List<string> Strings(JsonElement body, string name)
    {
        if (!body.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null) return [];
        if (value.ValueKind != JsonValueKind.Array) throw new ArgumentException($"{name} must be an array");
        var result = new List<string>();
        foreach (var item in value.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String || item.GetString() is not { Length: > 0 and <= 253 } text)
                throw new ArgumentException($"invalid {name} entry");
            result.Add(text);
        }
        return result;
    }

    private static async Task<Guid?> User(HttpContext ctx, Platform platform)
    {
        ctx.Request.Cookies.TryGetValue("teammates_session", out var token);
        return await platform.UserForSession(token);
    }
}
