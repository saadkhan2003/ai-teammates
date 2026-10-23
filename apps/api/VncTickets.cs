using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using Dapper;
using Teammates.Compute;

namespace Teammates.Api;

public sealed record VncTicket(string Token, Guid UserId, Guid BotId, string Role, DateTimeOffset ExpiresAt);
public sealed record VncTicketEndpoint(DesktopEndpoint Endpoint, string SessionToken, Guid UserId, Guid BotId, Guid LeaseId, string Role, string TabId, long Epoch);

/// <summary>Short lived, one-use VNC tickets. Raw values exist only in the response and memory transiently.</summary>
public static class VncTicketStore
{
    private sealed record Entry(byte[] TokenHash, byte[] IpHash, Guid User, Guid Bot, Guid LeaseId, string Role,
        string TabId, long Epoch, DesktopEndpoint Endpoint, string SessionToken, DateTimeOffset ExpiresAt);
    private static readonly ConcurrentDictionary<string, Entry> Entries = new(StringComparer.Ordinal);
    private static readonly object TicketGate = new();
    private static readonly byte[] IpKey = RandomNumberGenerator.GetBytes(32);

    public static string ClientIpHash(IPAddress? address)
    {
        var canonical = address?.MapToIPv6().ToString() ?? "unknown";
        return Convert.ToHexString(HMACSHA256.HashData(IpKey, Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
    }

    public static VncTicket Issue(Guid user, Guid bot, Guid leaseId, string role, string tabId, long epoch, DesktopEndpoint endpoint, string sessionToken, string ipHash, DateTimeOffset? issuedAt = null)
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
            if (!Entries.TryAdd(Convert.ToHexString(tokenHash), new Entry(tokenHash, Convert.FromHexString(ipHash), user, bot, leaseId, role, tabId, epoch, endpoint, sessionToken, expires)))
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
        if (!Entries.TryRemove(key, out var consumed) || !ReferenceEquals(entry, consumed)) return null;
        return new VncTicketEndpoint(entry.Endpoint, entry.SessionToken, entry.User, entry.Bot, entry.LeaseId, entry.Role, entry.TabId, entry.Epoch);
    }

    public static void InvalidateLease(Guid bot, long epoch)
    {
        foreach (var (key, entry) in Entries)
            if (entry.Bot == bot && entry.Epoch != epoch) Entries.TryRemove(new KeyValuePair<string, Entry>(key, entry));
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
            var body = await ctx.Request.ReadFromJsonAsync<System.Text.Json.JsonElement>(ct);
            var tabId = body.ValueKind == System.Text.Json.JsonValueKind.Object && body.TryGetProperty("tabId", out var tab) ? tab.GetString() : null;
            var action = body.ValueKind == System.Text.Json.JsonValueKind.Object && body.TryGetProperty("action", out var act) ? act.GetString() : "heartbeat";
            var epoch = body.ValueKind == System.Text.Json.JsonValueKind.Object && body.TryGetProperty("epoch", out var ep) && ep.TryGetInt64(out var value) ? value : -1;
            if (string.IsNullOrWhiteSpace(tabId) || tabId.Length > 128) return Results.BadRequest(new { error = "invalid_tab" });
            var placement = await platform.PlacementForBot(id, ct);
            if (!Guid.TryParse(placement.Computer.Value, out var computerId)) return Results.Conflict(new { error = "computer_unavailable" });
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            await conn.ExecuteAsync("INSERT INTO desktop_lease (computer_id, display, epoch) VALUES (@computerId, 1, 1) ON CONFLICT DO NOTHING", new { computerId });
            var current = await DesktopLeaseRepository.StateAsync(conn, computerId, 1, ct);
            if (current == null || epoch != current.Epoch)
            {
                await platform.Audit(user.Value.ToString(), "desktop.lease.reject", id, null, new { reason = "epoch_conflict", suppliedEpoch = epoch, epoch = current?.Epoch });
                return Results.Conflict(new { error = "lease_epoch_conflict", epoch = current?.Epoch ?? 0 });
            }
            var dbNow = await conn.ExecuteScalarAsync<DateTimeOffset>(new CommandDefinition("SELECT clock_timestamp()", cancellationToken: ct));
            if (action == "heartbeat" && !DesktopLeaseRepository.IsActiveFor(current, user.Value, tabId, epoch, dbNow))
            {
                await platform.Audit(user.Value.ToString(), "desktop.lease.reject", id, null, new { reason = "lease_expired", epoch });
                return Results.Conflict(new { error = "lease_expired", epoch = current.Epoch });
            }
            DesktopLeaseRow? changed;
            if (action == "release") changed = await DesktopLeaseRepository.ReleaseAsync(conn, computerId, 1, user.Value, tabId, epoch, ct);
            else if (action is "heartbeat" or "transfer") changed = await DesktopLeaseRepository.AcquireAsync(conn, computerId, 1, user.Value, tabId, epoch, action == "transfer", ct);
            else return Results.BadRequest(new { error = "invalid_action" });
            if (changed == null)
            {
                await platform.Audit(user.Value.ToString(), "desktop.lease.reject", id, null, new { reason = "busy", holder = current.HolderUserId, tabId = current.TabId, epoch = current.Epoch });
                return Results.Conflict(new { error = "desktop_busy", holder = current.HolderUserId, tabId = current.TabId, epoch = current.Epoch });
            }
            VncTicketStore.InvalidateLease(id, changed.Epoch);
            await conn.ExecuteAsync("UPDATE control_locks SET holder=@holder, epoch=@epoch, updated_at=now() WHERE bot_id=@id", new { holder = changed.HolderKind == "human" ? "human" : "agent", epoch = changed.Epoch, id });
            await platform.Compute.SetHolderAsync(placement.Computer, changed.HolderKind == "human" ? "human" : "fenced", (ulong)changed.Epoch, ct);
            var eventName = action == "release" ? "desktop.lease.release" : action == "transfer" ? "desktop.lease.acquire" : "desktop.lease.renew";
            await platform.Audit(user.Value.ToString(), eventName, id, null, new { tabId, epoch = changed.Epoch });
            await platform.Publish(new { type = "computer.mode", botId = id, mode = changed.HolderKind == "human" ? "control" : "watching", epoch = changed.Epoch });
            return Results.Json(new { held = changed.HolderKind == "human", expiresIn = changed.HolderKind == "human" ? 35 : 0, epoch = changed.Epoch });
        });

        app.MapPost("/api/computers/{id:guid}/vnc-ticket", async (HttpContext ctx, Guid id, string? role, bool? transfer, CancellationToken ct) =>
        {
            var user = await Routes.RequireUser(ctx, platform);
            if (user == null || !await Routes.Owns(platform, user.Value, id)) return Results.Unauthorized();
            role ??= "watch";
            if (role is not ("watch" or "control")) return Results.BadRequest(new { error = "role must be watch or control" });
            var tabId = ctx.Request.Headers["X-Desktop-Tab"].ToString();
            if (string.IsNullOrWhiteSpace(tabId) || tabId.Length > 128) return Results.BadRequest(new { error = "desktop tab is required" });
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var placement = await platform.PlacementForBot(id, ct);
            if (!Guid.TryParse(placement.Computer.Value, out var computerId)) return Results.Conflict(new { error = "computer_unavailable" });
            await conn.ExecuteAsync("INSERT INTO desktop_lease (computer_id, display, epoch) VALUES (@computerId, 1, 1) ON CONFLICT DO NOTHING", new { computerId });
            var lease = await DesktopLeaseRepository.StateAsync(conn, computerId, 1, ct);
            if (lease == null) return Results.NotFound();
            var epoch = lease.Epoch;
            if (role == "control")
            {
                var previousHolder = lease.HolderKind;
                var changedOwner = lease.HolderKind != "human" || lease.HolderUserId != user.Value || lease.TabId != tabId;
                var held = await DesktopLeaseRepository.AcquireAsync(conn, computerId, 1, user.Value, tabId, epoch, transfer == true, ct);
                if (held == null)
                {
                    await platform.Audit(user.Value.ToString(), "desktop.lease.reject", id, null, new { reason = "busy", holder = lease.HolderUserId, tabId = lease.TabId, epoch });
                    return Results.Conflict(new { error = "desktop_busy", holder = lease.HolderUserId, tabId = lease.TabId });
                }
                lease = held;
                epoch = held.Epoch;
                VncTicketStore.InvalidateLease(id, epoch);
                await conn.ExecuteAsync("UPDATE control_locks SET holder='human', epoch=@epoch, updated_at=now() WHERE bot_id=@id", new { id, epoch });
                if (changedOwner)
                    await conn.ExecuteAsync("UPDATE tasks SET status='waiting_human', waiting_reason='takeover', lease_owner=NULL, lease_until=NULL, lease_epoch=lease_epoch+1, updated_at=now() WHERE bot_id IN (SELECT id FROM bots WHERE owner_id=@owner) AND status='running' AND instruction NOT LIKE 'Terminal:%'", new { owner = user.Value });
                var auditAction = changedOwner ? (previousHolder == "agent" ? "desktop.lease.preempt" : "desktop.lease.acquire") : "desktop.lease.renew";
                await platform.Audit(user.Value.ToString(), auditAction, id, null, new { tabId, epoch });
                await platform.Publish(new { type = "computer.mode", botId = id, mode = "control", epoch });
                await platform.Compute.SetHolderAsync(placement.Computer, "human", (ulong)epoch, ct);
            }
            else if (lease.HolderKind == "human" && lease.ExpiresAt > DateTimeOffset.UtcNow)
            {
                // A second tab remains view-only unless it explicitly transfers control.
                if (lease.HolderUserId != user.Value || lease.TabId != tabId) epoch = lease.Epoch;
            }
            var dbNow = await conn.ExecuteScalarAsync<DateTimeOffset>(new CommandDefinition("SELECT clock_timestamp()", cancellationToken: ct));
            if (role == "control" && !DesktopLeaseRepository.IsActiveFor(lease, user.Value, tabId, epoch, dbNow))
                return Results.Conflict(new { error = "lease_not_held" });
            DesktopSession session;
            try
            {
                session = await platform.Compute.GetDesktopSessionAsync(placement.Computer,
                    new DesktopAccess(role == "control" ? DesktopMode.Interactive : DesktopMode.View, (ulong)Math.Max(epoch, 1), TimeSpan.FromSeconds(60), role == "control"), ct);
            }
            catch (ComputeException ex) when (ex.Code == ComputeErrorCode.FailedPrecondition && ex.Message.Contains("stale fencing epoch", StringComparison.Ordinal))
            {
                return Results.Conflict(new { error = "desktop_epoch_conflict" });
            }
            var endpoint = platform.Compute.RequireSession(session.Token, DateTimeOffset.UtcNow);
            var ticket = VncTicketStore.Issue(user.Value, id, computerId, role, tabId, epoch, endpoint, session.Token, VncTicketStore.ClientIpHash(ctx.Connection.RemoteIpAddress));
            return Results.Json(new { token = ticket.Token, role, windowId = id, epoch, expiresAt = ticket.ExpiresAt });
        });
    }
}
