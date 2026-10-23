using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Net;
using Dapper;

namespace Teammates.Api;

/// <summary>Computer-token control plane for proxy policy snapshots and audit decisions.</summary>
public static class EgressControlRoutes
{
    public sealed record Decision(string? Host, int Port, bool Allowed, string? Reason);
    private sealed class Window { public long Started; public int Count; }
    private static readonly ConcurrentDictionary<Guid, Window> Windows = new();

    public static void MapEgressControlRoutes(this WebApplication app, Platform platform)
    {
        app.MapGet("/internal/computers/{computerId:guid}/egress-policy", async (HttpContext ctx, Guid computerId) =>
        {
            if (!Authorized(ctx, platform.ComputerToken)) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var owner = await conn.ExecuteScalarAsync<Guid?>("SELECT user_id FROM user_computers WHERE computer_id=@computerId", new { computerId });
            if (owner is null) return Results.NotFound();
            var settings = await conn.ExecuteScalarAsync<string?>("SELECT settings::text FROM user_policies WHERE user_id=@owner", new { owner });
            var policy = NetworkPolicyRoutes.ReadPolicy(settings);
            return Results.Json(policy);
        });

        app.MapPost("/internal/computers/{computerId:guid}/egress-decisions", async (HttpContext ctx, Guid computerId, Decision? decision) =>
        {
            if (!Authorized(ctx, platform.ComputerToken)) return Results.Unauthorized();
            if (ctx.Request.ContentLength is > 4096) return Results.BadRequest(new { error = "egress decision too large" });
            if (decision is null || decision.Host is not { Length: > 0 and <= 253 } host || !SafeHost(host) || decision.Port is < 1 or > 65535 || decision.Reason is not { Length: <= 120 } reason || reason.Any(char.IsControl))
                return Results.BadRequest(new { error = "invalid or rate-limited egress decision" });
            await using var conn = await platform.Data.OpenConnectionAsync();
            var exists = await conn.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM user_computers WHERE computer_id=@computerId)", new { computerId });
            if (!exists) return Results.NotFound();
            if (!TakeRate(computerId)) return Results.StatusCode(429);
            await platform.Audit("computer:" + computerId.ToString("N"), decision.Allowed ? "egress.allowed" : "egress.blocked", null, null,
                new { host, decision.Port, decision.Allowed, reason });
            return Results.Ok(new { ok = true });
        });
    }

    private static bool Authorized(HttpContext ctx, string expected)
    {
        var header = ctx.Request.Headers.Authorization.ToString();
        if (!header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) || header.Length > 512 || string.IsNullOrEmpty(expected)) return false;
        var a = SHA256.HashData(Encoding.UTF8.GetBytes(expected));
        var b = SHA256.HashData(Encoding.UTF8.GetBytes(header[7..].Trim()));
        return CryptographicOperations.FixedTimeEquals(a, b);
    }

    private static bool TakeRate(Guid id)
    {
        var now = Environment.TickCount64;
        var window = Windows.GetOrAdd(id, _ => new Window { Started = now });
        lock (window)
        {
            if (now - window.Started >= 60_000) { window.Started = now; window.Count = 0; }
            return ++window.Count <= 120;
        }
    }

    private static bool SafeHost(string host) => !host.Any(char.IsControl) && !host.Any(c => c is '/' or '?' or '#' or '@' or '\\')
        && (IPAddress.TryParse(host, out _) || Uri.CheckHostName(host) == UriHostNameType.Dns);
}
