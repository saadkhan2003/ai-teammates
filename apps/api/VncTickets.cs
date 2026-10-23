using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using Dapper;
using Teammates.Compute;

namespace Teammates.Api;

public sealed record VncTicket(string Token, Guid UserId, Guid BotId, string Role, DateTimeOffset ExpiresAt);
public sealed record VncTicketEndpoint(DesktopEndpoint Endpoint, string SessionToken, Guid UserId, Guid BotId, Guid LeaseId, string Role);

/// <summary>Short lived, one-use VNC tickets. Raw values exist only in the response and memory transiently.</summary>
public static class VncTicketStore
{
    private sealed record Entry(byte[] TokenHash, byte[] IpHash, Guid User, Guid Bot, Guid LeaseId, string Role,
        DesktopEndpoint Endpoint, string SessionToken, DateTimeOffset ExpiresAt);
    private static readonly ConcurrentDictionary<string, Entry> Entries = new(StringComparer.Ordinal);
    private static readonly object TicketGate = new();
    private static readonly ConcurrentDictionary<Guid, (Guid User, DateTimeOffset Until)> HumanLeases = new();
    private static readonly byte[] IpKey = RandomNumberGenerator.GetBytes(32);

    public static string ClientIpHash(IPAddress? address)
    {
        var canonical = address?.MapToIPv6().ToString() ?? "unknown";
        return Convert.ToHexString(HMACSHA256.HashData(IpKey, Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
    }

    public static VncTicket Issue(Guid user, Guid bot, Guid leaseId, string role, DesktopEndpoint endpoint, string sessionToken, string ipHash, DateTimeOffset? issuedAt = null)
    {
        if (role is not ("watch" or "control")) throw new ArgumentException("invalid VNC role");
        var raw = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var tokenHash = SHA256.HashData(Encoding.UTF8.GetBytes(raw));
        var expires = (issuedAt ?? DateTimeOffset.UtcNow).AddSeconds(60);
        lock (TicketGate)
        {
            var now = DateTimeOffset.UtcNow;
            foreach (var (key, entry) in Entries)
                if (entry.ExpiresAt <= now) Entries.TryRemove(new KeyValuePair<string, Entry>(key, entry));
            if (Entries.Count >= 10_000) throw new InvalidOperationException("VNC ticket capacity reached");
            if (!Entries.TryAdd(Convert.ToHexString(tokenHash), new Entry(tokenHash, Convert.FromHexString(ipHash), user, bot, leaseId, role, endpoint, sessionToken, expires)))
                throw new CryptographicException("VNC ticket collision");
        }
        return new VncTicket(raw, user, bot, role, expires);
    }

    public static VncTicketEndpoint? Consume(string raw, Guid requestedBot, Guid user, string ipHash, out int failureStatus)
    {
        failureStatus = 401;
        if (string.IsNullOrEmpty(raw) || raw.Length > 128) return null;
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(raw));
        var key = Convert.ToHexString(hash);
        if (!Entries.TryGetValue(key, out var entry) || !CryptographicOperations.FixedTimeEquals(hash, entry.TokenHash)) return null;
        if (entry.Bot != requestedBot) { failureStatus = 403; return null; }
        if (entry.User != user || !CryptographicOperations.FixedTimeEquals(Convert.FromHexString(ipHash), entry.IpHash)) return null;
        if (entry.ExpiresAt <= DateTimeOffset.UtcNow) { Entries.TryRemove(key, out _); return null; }
        if (entry.Role == "control" && (!HumanLeases.TryGetValue(entry.LeaseId, out var lease) || lease.User != user || lease.Until <= DateTimeOffset.UtcNow)) { failureStatus = 409; return null; }
        if (!Entries.TryRemove(key, out var consumed) || !ReferenceEquals(entry, consumed)) return null;
        return new VncTicketEndpoint(entry.Endpoint, entry.SessionToken, entry.User, entry.Bot, entry.LeaseId, entry.Role);
    }

    public static bool HumanLeaseActive(Guid leaseId, Guid user) =>
        HumanLeases.TryGetValue(leaseId, out var lease) && lease.User == user && lease.Until > DateTimeOffset.UtcNow;

    public static bool TryAcquireHuman(Guid bot, Guid user, DateTimeOffset now)
    {
        while (true)
        {
            if (!HumanLeases.TryGetValue(bot, out var old))
                return HumanLeases.TryAdd(bot, (user, now.AddSeconds(120)));
            if (old.Until <= now)
            {
                HumanLeases.TryRemove(new KeyValuePair<Guid, (Guid User, DateTimeOffset Until)>(bot, old));
                continue;
            }
            if (old.User != user) return false;
            return HumanLeases.TryUpdate(bot, (user, now.AddSeconds(120)), old);
        }
    }

    public static void ReleaseHuman(Guid bot, Guid user)
    {
        if (HumanLeases.TryGetValue(bot, out var lease) && lease.User == user)
            HumanLeases.TryRemove(new KeyValuePair<Guid, (Guid User, DateTimeOffset Until)>(bot, lease));
    }

    public static IReadOnlyList<Guid> ExpireHumanLeases(DateTimeOffset now)
    {
        var expired = new List<Guid>();
        foreach (var (leaseId, lease) in HumanLeases)
        {
            if (lease.Until <= now && HumanLeases.TryRemove(new KeyValuePair<Guid, (Guid User, DateTimeOffset Until)>(leaseId, lease)))
                expired.Add(leaseId);
        }
        return expired;
    }
}

public static class VncTicketRoutes
{
    public static void Map(WebApplication app, Platform platform)
    {
        app.MapPost("/api/computers/{id:guid}/lease", async (HttpContext ctx, Guid id, CancellationToken ct) =>
        {
            var user = await Routes.RequireUser(ctx, platform);
            if (user == null || !await Routes.Owns(platform, user.Value, id)) return Results.Unauthorized();
            if (!VncTicketStore.TryAcquireHuman(user.Value, user.Value, DateTimeOffset.UtcNow)) return Results.Conflict(new { error = "desktop_busy" });
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            await conn.ExecuteAsync("UPDATE control_locks SET updated_at=now() WHERE bot_id IN (SELECT id FROM bots WHERE owner_id=@owner) AND holder='human'", new { owner = user.Value });
            var epoch = await conn.ExecuteScalarAsync<long?>("SELECT epoch FROM control_locks WHERE bot_id=@id AND holder='human'", new { id });
            if (epoch == null) return Results.Conflict(new { error = "lease_not_held" });
            var placement = await platform.PlacementForBot(id, ct);
            await platform.Compute.SetHolderAsync(placement.Computer, "human", (ulong)epoch.Value, ct);
            return Results.Json(new { held = true, expiresIn = 120 });
        });

        app.MapPost("/api/computers/{id:guid}/vnc-ticket", async (HttpContext ctx, Guid id, string? role, CancellationToken ct) =>
        {
            var user = await Routes.RequireUser(ctx, platform);
            if (user == null || !await Routes.Owns(platform, user.Value, id)) return Results.Unauthorized();
            role ??= "watch";
            if (role is not ("watch" or "control")) return Results.BadRequest(new { error = "role must be watch or control" });
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var epoch = await conn.ExecuteScalarAsync<long?>("SELECT epoch FROM control_locks WHERE bot_id=@id", new { id });
            if (epoch == null) return Results.NotFound();
            if (role == "control")
            {
                if (!VncTicketStore.TryAcquireHuman(user.Value, user.Value, DateTimeOffset.UtcNow)) return Results.Conflict(new { error = "desktop_busy" });
                epoch = await conn.ExecuteScalarAsync<long>("UPDATE control_locks SET holder='human', epoch=epoch+1, updated_at=now() WHERE bot_id=@id RETURNING epoch", new { id });
                await conn.ExecuteAsync("UPDATE control_locks SET holder='human', updated_at=now() WHERE bot_id IN (SELECT id FROM bots WHERE owner_id=@owner)", new { owner = user.Value });
                await conn.ExecuteAsync("UPDATE tasks SET status='waiting_human', waiting_reason='takeover', lease_owner=NULL, lease_until=NULL, lease_epoch=lease_epoch+1, updated_at=now() WHERE bot_id IN (SELECT id FROM bots WHERE owner_id=@owner) AND status='running' AND instruction NOT LIKE 'Terminal:%'", new { owner = user.Value });
            }
            var placement = await platform.PlacementForBot(id, ct);
            DesktopSession? session = null;
            for (var attempt = 0; attempt < 256; attempt++)
            {
                try
                {
                    session = await platform.Compute.GetDesktopSessionAsync(placement.Computer,
                        new DesktopAccess(role == "control" ? DesktopMode.Interactive : DesktopMode.View, (ulong)Math.Max(epoch.Value, 1), TimeSpan.FromSeconds(60), role == "control"), ct);
                    break;
                }
                catch (ComputeException ex) when (ex.Code == ComputeErrorCode.FailedPrecondition && ex.Message.Contains("stale fencing epoch", StringComparison.Ordinal))
                {
                    epoch++;
                }
            }
            if (session == null) return Results.Conflict(new { error = "desktop_epoch_conflict" });
            var endpoint = platform.Compute.RequireSession(session.Token, DateTimeOffset.UtcNow);
            var ticket = VncTicketStore.Issue(user.Value, id, user.Value, role, endpoint, session.Token, VncTicketStore.ClientIpHash(ctx.Connection.RemoteIpAddress));
            if (role == "control")
            {
                await platform.Audit(user.Value.ToString(), "desktop.lease.acquire", id, null, new { role });
                await platform.Publish(new { type = "computer.mode", botId = id, mode = "control" });
            }
            return Results.Json(new { token = ticket.Token, role, windowId = id, expiresAt = ticket.ExpiresAt });
        });
    }
}
