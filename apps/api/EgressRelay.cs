using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using Dapper;

namespace Teammates.Api;

/// <summary>Owner-scoped, authenticated byte relay for a computer proxy and its paired device.</summary>
public static class EgressRelay
{
    private sealed class Pair { public WebSocket? Computer; public WebSocket? Companion; public Task? RelayTask; public readonly TaskCompletionSource Ready = new(TaskCreationOptions.RunContinuationsAsynchronously); }
    private static readonly ConcurrentDictionary<Guid, Pair> Pairs = new();

    public static bool TokenMatches(string expected, string presented)
    {
        if (string.IsNullOrEmpty(expected) || string.IsNullOrEmpty(presented)) return false;
        var a = SHA256.HashData(Encoding.UTF8.GetBytes(expected));
        var b = SHA256.HashData(Encoding.UTF8.GetBytes(presented));
        return CryptographicOperations.FixedTimeEquals(a, b);
    }

    private static bool TokenHashMatches(string storedHash, string presented)
    {
        var actual = Encoding.ASCII.GetBytes(DeviceCredentials.Hash(presented));
        var expected = Encoding.ASCII.GetBytes(storedHash);
        return actual.Length == expected.Length && CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    public static void Map(WebApplication app, Platform platform)
    {
        app.Map("/api/egress/relay/{computerId:guid}", async (HttpContext ctx, Guid computerId, string? role, string? deviceId) =>
        {
            if (!ctx.WebSockets.IsWebSocketRequest || role is not ("computer" or "companion")) { ctx.Response.StatusCode = 400; return; }
            Guid owner;
            var relayComputerId = computerId;
            await using (var conn = await platform.Data.OpenConnectionAsync())
            {
                if (role == "computer")
                {
                    if (!Authorized(ctx, platform.ComputerToken)) { ctx.Response.StatusCode = 401; return; }
                    var found = await conn.ExecuteScalarAsync<Guid?>("SELECT user_id FROM user_computers WHERE computer_id=@computerId", new { computerId });
                    if (found is null) { ctx.Response.StatusCode = 404; return; }
                    owner = found.Value;
                }
                else
                {
                    if (!Guid.TryParse(deviceId, out var parsed)) { ctx.Response.StatusCode = 401; return; }
                    var header = ctx.Request.Headers.Authorization.ToString();
                    var token = header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? header[7..].Trim() : "";
                    var row = await conn.QuerySingleOrDefaultAsync<(Guid Owner, string Hash)>("SELECT owner_id, token_hash FROM devices WHERE id=@id", new { id = parsed });
                    if (row.Owner == Guid.Empty || !TokenHashMatches(row.Hash, token)) { ctx.Response.StatusCode = 401; return; }
                    owner = row.Owner;
                    var ownedComputer = await conn.ExecuteScalarAsync<Guid?>("SELECT computer_id FROM user_computers WHERE user_id=@owner ORDER BY created_at DESC LIMIT 1", new { owner });
                    if (ownedComputer is null) { ctx.Response.StatusCode = 404; return; }
                    relayComputerId = ownedComputer.Value;
                }
            }
            using var socket = await ctx.WebSockets.AcceptWebSocketAsync();
            var pair = Pairs.GetOrAdd(relayComputerId, _ => new Pair());
            var occupied = false;
            lock (pair)
            {
                occupied = role == "computer" ? pair.Computer is not null : pair.Companion is not null;
                if (!occupied)
                {
                    if (role == "computer") pair.Computer = socket;
                    else pair.Companion = socket;
                    if (pair.Computer is not null && pair.Companion is not null) pair.Ready.TrySetResult();
                }
            }
            if (occupied)
            {
                await socket.CloseAsync(WebSocketCloseStatus.PolicyViolation, "relay_pair_mismatch", CancellationToken.None);
                return;
            }
            try
            {
                await pair.Ready.Task.WaitAsync(TimeSpan.FromSeconds(90), ctx.RequestAborted);
                Task relayTask;
                lock (pair)
                {
                    relayTask = pair.RelayTask ??= RelayBoth(pair.Computer!, pair.Companion!, ctx.RequestAborted);
                }
                await relayTask;
            }
            catch (OperationCanceledException) { }
            catch (WebSocketException) { }
            catch (TimeoutException)
            {
                try { if (socket.State == WebSocketState.Open) await socket.CloseAsync(WebSocketCloseStatus.PolicyViolation, "relay_pair_mismatch", CancellationToken.None); }
                catch (WebSocketException) { }
            }
            finally
            {
                lock (pair) { if (role == "computer") pair.Computer = null; else pair.Companion = null; }
                if (pair.Computer is null && pair.Companion is null) Pairs.TryRemove(relayComputerId, out _);
            }
        });
    }

    private static bool Authorized(HttpContext ctx, string expected)
    {
        var header = ctx.Request.Headers.Authorization.ToString();
        return header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) && TokenMatches(expected, header[7..].Trim());
    }

    private static async Task Relay(WebSocket source, WebSocket destination, CancellationToken ct)
    {
        var buffer = new byte[64 * 1024];
        while (source.State == WebSocketState.Open && destination.State == WebSocketState.Open)
        {
            var result = await source.ReceiveAsync(buffer, ct);
            if (result.MessageType == WebSocketMessageType.Close) break;
            await destination.SendAsync(buffer.AsMemory(0, result.Count), result.MessageType, result.EndOfMessage, ct);
        }
    }

    private static async Task RelayBoth(WebSocket computer, WebSocket companion, CancellationToken ct)
    {
        // The computer treats its route as the desktop only once a companion is paired, so say so first.
        try { await computer.SendAsync(Encoding.UTF8.GetBytes("{\"type\":\"ready\"}"), WebSocketMessageType.Text, true, ct); }
        catch (WebSocketException) { }
        await Task.WhenAny(Relay(computer, companion, ct), Relay(companion, computer, ct));
        try { if (computer.State == WebSocketState.Open) await computer.CloseAsync(WebSocketCloseStatus.NormalClosure, "relay closed", CancellationToken.None); } catch (WebSocketException) { }
        try { if (companion.State == WebSocketState.Open) await companion.CloseAsync(WebSocketCloseStatus.NormalClosure, "relay closed", CancellationToken.None); } catch (WebSocketException) { }
    }
}
