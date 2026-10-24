using System.Security.Cryptography;
using System.Text;
using Dapper;
using Npgsql;

namespace Teammates.Api;

public static class DeviceCredentials
{
    public static string Create() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    public static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    public static bool ValidExecution(string? mode) => mode is "ask" or "always" or "off";
    public static bool MayExecute(string? mode) => mode is "ask" or "always";
    public static bool OwnerOnly(string? role) => role == "owner";
}

// Ask still requires the caller's normal approval flow. This gate never grants approval.
public sealed class DeviceGate(NpgsqlDataSource data)
{
    public async Task<bool> CanExecute(Guid deviceId)
    {
        await using var conn = await data.OpenConnectionAsync();
        return DeviceCredentials.MayExecute(await conn.ExecuteScalarAsync<string?>("SELECT execution FROM devices WHERE id=@deviceId", new { deviceId }));
    }
}

public static class Devices
{
    public record Permissions(string? Name = null, string? Execution = null, bool? RouteTraffic = null, bool? AllowFiles = null, bool? AllowBrowser = null);
    public record Registration(string Code, string Name, string Os, string Version);
    public record Heartbeat(string Version);
    private const string Projection = "id, name, os, version, execution, route_traffic AS \"routeTraffic\", allow_files AS \"allowFiles\", allow_browser AS \"allowBrowser\", last_seen AS \"lastSeen\", last_seen > now()-interval '90 seconds' AS online";

    public static void Map(WebApplication app, Platform platform)
    {
        async Task<bool> Limited(HttpContext ctx, string scope)
        {
            var key = HMACSHA256.HashData(platform.MasterKey, Encoding.UTF8.GetBytes(scope + ":" + (ctx.Connection.RemoteIpAddress?.ToString() ?? "local")));
            await using var conn = await platform.Data.OpenConnectionAsync(ctx.RequestAborted);
            var count = await conn.ExecuteScalarAsync<int>("""
                INSERT INTO api_rate_windows(scope_hash,window_started,request_count) VALUES(@key,clock_timestamp(),1)
                ON CONFLICT(scope_hash) DO UPDATE SET
                  window_started=CASE WHEN api_rate_windows.window_started<=clock_timestamp()-interval '10 minutes' THEN clock_timestamp() ELSE api_rate_windows.window_started END,
                  request_count=CASE WHEN api_rate_windows.window_started<=clock_timestamp()-interval '10 minutes' THEN 1 ELSE api_rate_windows.request_count+1 END
                RETURNING request_count
                """, new { key });
            await conn.ExecuteAsync("DELETE FROM api_rate_windows WHERE window_started<clock_timestamp()-interval '1 day'");
            return count > LoginRateLimiter.MaxAttempts;
        }
        async Task<Guid?> Owner(HttpContext ctx)
        {
            ctx.Request.Cookies.TryGetValue("teammates_session", out var token);
            var id = await platform.UserForSession(token);
            if (id == null) return null;
            await using var conn = await platform.Data.OpenConnectionAsync();
            return DeviceCredentials.OwnerOnly(await conn.ExecuteScalarAsync<string>("SELECT role FROM users WHERE id=@id", new { id })) ? id : null;
        }
        async Task<IResult> Pair(HttpContext ctx)
        {
            var owner = await Owner(ctx);
            if (owner == null) return Results.StatusCode(403);
            if (await Limited(ctx, "issue:" + owner)) return Results.StatusCode(429);
            var code = DeviceCredentials.Create()[..12].ToUpperInvariant();
            var expiresAt = DateTimeOffset.UtcNow.AddMinutes(10);
            await using var conn = await platform.Data.OpenConnectionAsync();
            await conn.ExecuteAsync("DELETE FROM device_pairings WHERE expires_at <= now()");
            await conn.ExecuteAsync("INSERT INTO device_pairings(code_hash,owner_id,expires_at) VALUES (@hash,@owner,@expiresAt)", new { hash = DeviceCredentials.Hash(code), owner, expiresAt });
            await platform.Audit(owner.ToString()!, "device.pairing_created", null, null, new { expiresAt });
            ctx.Response.Headers.CacheControl = "no-store";
            return Results.Json(new { code, expiresAt });
        }
        app.MapPost("/api/devices", (Delegate)Pair);
        app.MapPost("/api/devices/pair", (Delegate)Pair);
        app.MapGet("/api/devices/version", () => Results.Json(new { latest = "0.4.0", minCompatible = "0.4.0", docs = "/docs/COMPANION.md" }));
        app.MapGet("/api/devices", async (HttpContext ctx) =>
        {
            var owner = await Owner(ctx);
            if (owner == null) return Results.StatusCode(403);
            await using var conn = await platform.Data.OpenConnectionAsync();
            return Results.Json(await conn.QueryAsync($"SELECT {Projection} FROM devices WHERE owner_id=@owner ORDER BY created_at", new { owner }));
        });
        app.MapPost("/api/devices/pair/complete", async (HttpContext ctx, Registration body) =>
        {
            if (await Limited(ctx, "complete")) return Results.StatusCode(429);
            if (string.IsNullOrWhiteSpace(body.Code) || body.Code.Length > 64 || string.IsNullOrWhiteSpace(body.Name) || body.Name.Length > 120 || string.IsNullOrWhiteSpace(body.Os) || body.Os.Length > 80 || string.IsNullOrWhiteSpace(body.Version) || body.Version.Length > 40) return Results.BadRequest(new { error = "Code, name, OS and version are required." });
            await using var conn = await platform.Data.OpenConnectionAsync();
            await using var tx = await conn.BeginTransactionAsync();
            var owner = await conn.ExecuteScalarAsync<Guid?>("DELETE FROM device_pairings WHERE code_hash=@hash AND expires_at>now() RETURNING owner_id", new { hash = DeviceCredentials.Hash(body.Code.Trim().ToUpperInvariant()) }, tx);
            if (owner == null) return Results.BadRequest(new { error = "Pairing code is invalid or expired." });
            var token = DeviceCredentials.Create();
            var id = await conn.ExecuteScalarAsync<Guid>("INSERT INTO devices(owner_id,name,os,version,token_hash) VALUES (@owner,@name,@os,@version,@hash) RETURNING id", new { owner, name = body.Name.Trim(), os = body.Os, version = body.Version, hash = DeviceCredentials.Hash(token) }, tx);
            await tx.CommitAsync();
            await platform.Audit(owner.ToString()!, "device.paired", null, null, new { deviceId = id });
            ctx.Response.Headers.CacheControl = "no-store";
            return Results.Json(new { id, deviceToken = token });
        });
        app.MapPatch("/api/devices/{id:guid}", async (HttpContext ctx, Guid id, Permissions body) =>
        {
            var owner = await Owner(ctx);
            if (owner == null) return Results.StatusCode(403);
            if ((body.Execution != null && !DeviceCredentials.ValidExecution(body.Execution)) || (body.Name != null && (string.IsNullOrWhiteSpace(body.Name) || body.Name.Length > 120))) return Results.BadRequest(new { error = "Invalid device permissions or name." });
            await using var conn = await platform.Data.OpenConnectionAsync();
            var changed = await conn.ExecuteAsync("UPDATE devices SET name=coalesce(@Name,name), execution=coalesce(@Execution,execution), route_traffic=coalesce(@RouteTraffic,route_traffic), allow_files=coalesce(@AllowFiles,allow_files), allow_browser=coalesce(@AllowBrowser,allow_browser) WHERE id=@id AND owner_id=@owner", new { id, owner, body.Name, body.Execution, body.RouteTraffic, body.AllowFiles, body.AllowBrowser });
            if (changed == 0) return Results.NotFound();
            await platform.Audit(owner.ToString()!, "device.permissions_updated", null, null, new { deviceId = id, body.Execution, body.RouteTraffic, body.AllowFiles, body.AllowBrowser });
            return Results.Json(new { ok = true });
        });
        app.MapDelete("/api/devices/{id:guid}", async (HttpContext ctx, Guid id) =>
        {
            var owner = await Owner(ctx);
            if (owner == null) return Results.StatusCode(403);
            await using var conn = await platform.Data.OpenConnectionAsync();
            if (await conn.ExecuteAsync("DELETE FROM devices WHERE id=@id AND owner_id=@owner", new { id, owner }) == 0) return Results.NotFound();
            await platform.Audit(owner.ToString()!, "device.revoked", null, null, new { deviceId = id });
            return Results.NoContent();
        });
        app.MapPost("/api/devices/{id:guid}/heartbeat", async (HttpContext ctx, Guid id, Heartbeat body) =>
        {
            var header = ctx.Request.Headers.Authorization.ToString();
            if (!header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) || header.Length > 100 || string.IsNullOrWhiteSpace(body.Version) || body.Version.Length > 40) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var device = await conn.QuerySingleOrDefaultAsync($"UPDATE devices SET last_seen=now(),version=@version WHERE id=@id AND token_hash=@hash RETURNING {Projection}", new { id, version = body.Version, hash = DeviceCredentials.Hash(header[7..]) });
            return device == null ? Results.Unauthorized() : Results.Json(device);
        });
    }
}
