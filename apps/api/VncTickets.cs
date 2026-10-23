using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using Teammates.Compute;

namespace Teammates.Api;

public sealed record VncTicket(string Token, Guid UserId, Guid BotId, string Role, DateTimeOffset ExpiresAt);
public sealed record VncTicketEndpoint(DesktopEndpoint Endpoint, string SessionToken, Guid UserId, Guid BotId, Guid LeaseId, string Role, string TabId, long Epoch);

/// <summary>Short lived, one-use VNC tickets. Raw values exist only in the response and memory transiently.</summary>
public static class VncTicketStore
{
    private sealed record Scope(string Host, int Port, string Mode, string ComputerId, string EncryptedSessionToken);

    public static string ClientIpHash(byte[] key, IPAddress? address)
    {
        var canonical = address?.MapToIPv6().ToString() ?? "unknown";
        return Convert.ToHexString(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
    }

    public static async Task<VncTicket> IssueAsync(Platform platform, Guid user, Guid bot, Guid leaseId, string role,
        string tabId, long epoch, DesktopEndpoint endpoint, string sessionToken, string ipHash, CancellationToken ct)
    {
        if (role is not ("watch" or "control")) throw new ArgumentException("invalid VNC role");
        var raw = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var expires = DateTimeOffset.UtcNow.AddSeconds(60);
        var scope = JsonSerializer.Serialize(new Scope(endpoint.Host, endpoint.Port, endpoint.Mode.ToString(), endpoint.ComputerId.Value,
            TicketScopeCrypto.Encrypt(platform.MasterKey, sessionToken)));
        await platform.Tickets.IssueAsync(new OneTimeTicket(Guid.NewGuid(), "vnc", raw, user, bot, leaseId, role,
            tabId, epoch, scope, Convert.FromHexString(ipHash), expires.UtcDateTime), ct);
        return new VncTicket(raw, user, bot, role, expires);
    }

    public static async Task<(VncTicketEndpoint? Ticket, int FailureStatus)> ConsumeAsync(Platform platform, string raw, Guid requestedBot, Guid user,
        string ipHash, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(raw) || raw.Length > 128) return (null, 401);
        var ticket = await platform.Tickets.ConsumeAsync(raw, "vnc", user, requestedBot, Convert.FromHexString(ipHash), ct);
        if (ticket is null) return (null, 401);
        var scope = JsonSerializer.Deserialize<Scope>(ticket.Scope);
        if (scope is null || ticket.Role is not ("watch" or "control") || ticket.TabId.Length > 128) return (null, 401);
        var endpoint = new DesktopEndpoint(new Teammates.Compute.ComputerId(scope.ComputerId), scope.Host, scope.Port,
            Enum.Parse<DesktopMode>(scope.Mode), (ulong)Math.Max(ticket.Epoch, 0), new DateTimeOffset(DateTime.SpecifyKind(ticket.ExpiresAt, DateTimeKind.Utc)));
        return (new VncTicketEndpoint(endpoint, TicketScopeCrypto.Decrypt(platform.MasterKey, scope.EncryptedSessionToken),
            ticket.UserId, ticket.BotId, ticket.ComputerId ?? Guid.Empty, ticket.Role, ticket.TabId, ticket.Epoch), 401);
    }

    public static Task InvalidateLeaseAsync(Platform platform, Guid bot, long epoch, CancellationToken ct = default) =>
        platform.Tickets.InvalidateLeaseAsync(bot, epoch, ct);
}

public static class VncTicketRoutes
{
    public static void Map(WebApplication app, Platform platform)
    {
        app.MapPost("/api/computers/{id:guid}/lease/force-release", async (HttpContext ctx, Guid id, System.Text.Json.JsonElement body, CancellationToken ct) =>
        {
            var user = await Routes.RequireUser(ctx, platform);
            if (user == null || !await Routes.Owns(platform, user.Value, id)) return Results.Unauthorized();
            var reason = body.ValueKind == System.Text.Json.JsonValueKind.Object && body.TryGetProperty("reason", out var reasonValue) && reasonValue.ValueKind == System.Text.Json.JsonValueKind.String ? reasonValue.GetString()?.Trim() : null;
            var expectedEpoch = body.ValueKind == System.Text.Json.JsonValueKind.Object && body.TryGetProperty("epoch", out var epochValue) && epochValue.TryGetInt64(out var parsed) ? parsed : -1;
            if (string.IsNullOrWhiteSpace(reason) || reason.Length < 8 || reason.Length > 500)
                return Results.BadRequest(new { error = "force_release_reason_required" });
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var placement = await platform.PlacementForBot(id, ct);
            if (!Guid.TryParse(placement.Computer.Value, out var computerId)) return Results.Conflict(new { error = "computer_unavailable" });
            var released = await DesktopLeaseRepository.ForceReleaseAsync(conn, computerId, 1, expectedEpoch, ct);
            if (released == null) return Results.Conflict(new { error = "lease_changed" });
            await VncTicketStore.InvalidateLeaseAsync(platform, id, released.Epoch, ct);
            await conn.ExecuteAsync("UPDATE control_locks SET holder='agent', epoch=@epoch, updated_at=now() WHERE bot_id=@id", new { id, epoch = released.Epoch });
            await platform.Compute.SetHolderAsync(placement.Computer, "fenced", (ulong)released.Epoch, ct);
            await platform.Audit(user.Value.ToString(), "desktop.lease.force_release", id, null, new { reason = OutputRedactor.Redact(reason), epoch = released.Epoch });
            await platform.Publish(new { type = "computer.mode", botId = id, mode = "watching", epoch = released.Epoch });
            return Results.Json(new { released = true, epoch = released.Epoch, continueRequired = true });
        });

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
            await VncTicketStore.InvalidateLeaseAsync(platform, id, changed.Epoch, ct);
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
                await VncTicketStore.InvalidateLeaseAsync(platform, id, epoch, ct);
                await conn.ExecuteAsync("UPDATE control_locks SET holder='human', epoch=@epoch, updated_at=now() WHERE bot_id=@id", new { id, epoch });
                if (changedOwner)
                    await conn.ExecuteAsync("UPDATE tasks SET status='waiting_human', waiting_reason='takeover', lease_owner=NULL, lease_until=NULL, lease_epoch=lease_epoch+1, updated_at=now() WHERE bot_id IN (SELECT id FROM bots WHERE owner_id=@owner) AND status='running' AND instruction NOT LIKE 'Terminal:%'", new { owner = user.Value });
                var auditAction = changedOwner ? (previousHolder == "agent" ? "desktop.lease.preempt" : "desktop.lease.acquire") : "desktop.lease.renew";
                await platform.Audit(user.Value.ToString(), auditAction, id, null, new { tabId, epoch });
                await platform.Publish(new { type = "computer.mode", botId = id, mode = "control", epoch });
                await platform.Compute.SetHolderAsync(placement.Computer, "human", (ulong)epoch, ct);
            }
            else if (lease.HolderKind == "human" && lease.ExpiresAt > DateTime.UtcNow)
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
            var ticket = await VncTicketStore.IssueAsync(platform, user.Value, id, computerId, role, tabId, epoch, endpoint, session.Token, VncTicketStore.ClientIpHash(platform.MasterKey, ctx.Connection.RemoteIpAddress), ct);
            return Results.Json(new { token = ticket.Token, role, windowId = id, epoch, expiresAt = ticket.ExpiresAt });
        });
    }
}
