using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;

namespace Teammates.Api;

public sealed record TerminalTicketClaims(string Computer, string User, string Bot, int Window, string Role, long Expires, string Nonce);

public static class TerminalTickets
{
    public static byte[] SecretFor(string computerToken, string computer)
    {
        if (string.IsNullOrWhiteSpace(computerToken)) throw new InvalidOperationException("Terminal ticket configuration is missing");
        return SHA256.HashData(Encoding.UTF8.GetBytes(computerToken + ":" + computer));
    }

    public static string Create(byte[] secret, string computer, string user, string bot, int window, string role, DateTimeOffset? now = null)
    {
        if (secret.Length < 32) throw new ArgumentException("Terminal ticket secret is too short", nameof(secret));
        if (window < 1 || window > BoxContract.MaxWindows) throw new ArgumentOutOfRangeException(nameof(window));
        if (role is not ("user" or "watch" or "control")) throw new ArgumentException("Invalid terminal role", nameof(role));
        RequireScope(computer, nameof(computer));
        RequireScope(user, nameof(user));
        RequireScope(bot, nameof(bot));
        var payload = JsonSerializer.SerializeToUtf8Bytes(new
        {
            computer,
            user,
            bot,
            window,
            role,
            exp = (now ?? DateTimeOffset.UtcNow).ToUnixTimeSeconds() + 60,
            nonce = Base64Url(RandomNumberGenerator.GetBytes(32))
        });
        var encoded = Base64Url(payload);
        var signature = HMACSHA256.HashData(secret, Encoding.ASCII.GetBytes(encoded));
        return encoded + "." + Base64Url(signature);
    }

    public static TerminalTicketClaims Verify(string token, byte[] secret, DateTimeOffset? now = null)
        => VerifyCore(token, secret, now, checkExpiry: true);

    private static TerminalTicketClaims VerifyCore(string token, byte[] secret, DateTimeOffset? now, bool checkExpiry)
    {
        try
        {
            if (secret.Length < 32 || token.Length is < 40 or > 8192) throw new InvalidOperationException();
            var parts = token.Split('.');
            if (parts.Length != 2) throw new InvalidOperationException();
            var supplied = FromBase64Url(parts[1]);
            var expected = HMACSHA256.HashData(secret, Encoding.ASCII.GetBytes(parts[0]));
            if (supplied.Length != expected.Length || !CryptographicOperations.FixedTimeEquals(supplied, expected)) throw new InvalidOperationException();
            using var json = JsonDocument.Parse(FromBase64Url(parts[0]), new JsonDocumentOptions { MaxDepth = 4 });
            var root = json.RootElement;
            var claims = new TerminalTicketClaims(
                root.GetProperty("computer").GetString() ?? "",
                root.GetProperty("user").GetString() ?? "",
                root.GetProperty("bot").GetString() ?? "",
                root.GetProperty("window").GetInt32(),
                root.GetProperty("role").GetString() ?? "",
                root.GetProperty("exp").GetInt64(),
                root.GetProperty("nonce").GetString() ?? "");
            if (claims.Window < 1 || claims.Window > BoxContract.MaxWindows || claims.Role is not ("user" or "watch" or "control")) throw new InvalidOperationException();
            RequireScope(claims.Computer, nameof(claims.Computer));
            RequireScope(claims.User, nameof(claims.User));
            RequireScope(claims.Bot, nameof(claims.Bot));
            if (FromBase64Url(claims.Nonce).Length < 16 || (checkExpiry && claims.Expires <= (now ?? DateTimeOffset.UtcNow).ToUnixTimeSeconds())) throw new InvalidOperationException();
            return claims;
        }
        catch (Exception ex) when (ex is FormatException or JsonException or KeyNotFoundException or InvalidOperationException or ArgumentException or OverflowException)
        {
            throw new InvalidOperationException("Invalid terminal ticket");
        }
    }

    private static void RequireScope(string value, string name)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 128 || value.Any(char.IsControl)) throw new ArgumentException("Invalid ticket scope", name);
    }

    private static string Base64Url(byte[] value) => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static byte[] FromBase64Url(string value)
    {
        if (value.Length > 8192 || value.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '='))) throw new FormatException();
        var base64 = value.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(base64 + new string('=', (4 - base64.Length % 4) % 4));
    }

    public static void Map(WebApplication app, Platform platform)
    {
        app.MapPost("/api/computers/{id:guid}/terminal-ticket", async (HttpContext ctx, Guid id) =>
        {
            var user = await Routes.RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            byte[] bodyBytes;
            try { bodyBytes = await BotFileTransfer.ReadBoundedAsync(ctx.Request.Body, 4096, ctx.RequestAborted); }
            catch (FileTransferTooLargeException) { return Results.StatusCode(413); }
            JsonDocument bodyDocument;
            try { bodyDocument = JsonDocument.Parse(bodyBytes, new JsonDocumentOptions { MaxDepth = 3 }); }
            catch (JsonException) { return Results.BadRequest(new { error = "invalid terminal scope" }); }
            using (bodyDocument)
            {
            var body = bodyDocument.RootElement;
            if (body.ValueKind != JsonValueKind.Object || !body.TryGetProperty("botId", out var botEl) || botEl.ValueKind != JsonValueKind.String || !Guid.TryParse(botEl.GetString(), out var bot) ||
                !body.TryGetProperty("window", out var windowEl) || !windowEl.TryGetInt32(out var window) ||
                window < 1 || window > BoxContract.MaxWindows) return Results.BadRequest(new { error = "invalid terminal scope" });
            var role = "user";
            if (body.TryGetProperty("role", out var roleEl))
            {
                if (roleEl.ValueKind != JsonValueKind.String) return Results.BadRequest(new { error = "invalid terminal role" });
                role = roleEl.GetString() ?? "";
            }
            if (role != "user") return Results.BadRequest(new { error = "invalid terminal role" });
            await using var conn = await platform.Data.OpenConnectionAsync(ctx.RequestAborted);
            var owned = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM bots WHERE id=@bot AND owner_id=@user", new { bot, user });
            var mapped = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM user_computers WHERE user_id=@user AND computer_id=@id", new { user, id });
            if (owned == 0 || mapped == 0) return Results.NotFound();
            if (await platform.Usage.WakeBlockAsync(user.Value, id.ToString(), ctx.RequestAborted) is { } paused)
                return Results.Json(new { error = Credits.LimitCode, message = paused }, statusCode: 402);
            await platform.Compute.EnsureAwakeAsync(new Teammates.Compute.ComputerId(id.ToString()), ctx.RequestAborted);
            var token = Create(SecretFor(platform.ComputerToken, id.ToString()), id.ToString(), user.Value.ToString(), bot.ToString(), window, role);
            await platform.Tickets.IssueAsync(new OneTimeTicket(Guid.NewGuid(), "terminal", token, user.Value, bot, id,
                role, "", 0, JsonSerializer.Serialize(new { window }), null, DateTime.UtcNow.AddSeconds(60)), ctx.RequestAborted);
            return Results.Json(new { ticket = token, websocketPath = $"/api/computers/{id}/terminal", expiresInSeconds = 60 });
            }
        });

        app.Map("/api/computers/{id:guid}/terminal", ProxyAsync);

        async Task ProxyAsync(HttpContext ctx)
        {
            if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = 400; return; }
            var id = Guid.Parse((string)ctx.Request.RouteValues["id"]!);
            var protocols = ctx.Request.Headers.SecWebSocketProtocol.ToString().Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
            var matches = protocols.Where(value => value.StartsWith("terminal-ticket.", StringComparison.Ordinal)).Take(2).ToArray();
            if (matches.Length != 1) { ctx.Response.StatusCode = 401; return; }
            var selected = matches[0];
            var token = selected["terminal-ticket.".Length..];
            var user = await Routes.RequireUser(ctx, platform);
            if (user == null) { ctx.Response.StatusCode = 401; return; }
            TerminalTicketClaims claims;
            try { claims = VerifyCore(token, SecretFor(platform.ComputerToken, id.ToString()), null, checkExpiry: false); }
            catch (InvalidOperationException) { ctx.Response.StatusCode = 401; return; }
            if (claims.Computer != id.ToString() || claims.User != user.Value.ToString()) { ctx.Response.StatusCode = 403; return; }
            if (!await Routes.Owns(platform, user.Value, Guid.Parse(claims.Bot))) { ctx.Response.StatusCode = 403; return; }
            var consumed = await platform.Tickets.ConsumeAsync(token, "terminal", user.Value, Guid.Parse(claims.Bot), null, ctx.RequestAborted);
            if (consumed is null || consumed.ComputerId != id || consumed.Role != claims.Role) { ctx.Response.StatusCode = 401; return; }
            await using (var conn = await platform.Data.OpenConnectionAsync(ctx.RequestAborted))
            {
                if (await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM user_computers WHERE user_id=@user AND computer_id=@id", new { user, id }) == 0)
                { ctx.Response.StatusCode = 403; return; }
            }
            using var upstream = new ClientWebSocket();
            upstream.Options.AddSubProtocol(selected);
            try
            {
                var host = "tm" + new string(id.ToString().Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).Take(48).ToArray());
                var uri = new Uri($"ws://{host}:{BoxContract.PortFor("pty", claims.Window)}/");
                await upstream.ConnectAsync(uri, ctx.RequestAborted);
                using var downstream = await ctx.WebSockets.AcceptWebSocketAsync(selected);
                using var linked = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
                var up = Relay(downstream, upstream, linked.Token);
                var down = Relay(upstream, downstream, linked.Token);
                await Task.WhenAny(up, down);
                linked.Cancel();
                try { await Task.WhenAll(up, down); } catch (OperationCanceledException) { }
            }
            catch (WebSocketException)
            {
                if (!ctx.Response.HasStarted) ctx.Response.StatusCode = 502;
            }
        }
    }

    private static async Task Relay(WebSocket source, WebSocket target, CancellationToken ct)
    {
        var buffer = new byte[16 * 1024];
        while (source.State == WebSocketState.Open && target.State == WebSocketState.Open)
        {
            var result = await source.ReceiveAsync(buffer, ct);
            if (result.MessageType == WebSocketMessageType.Close) break;
            await target.SendAsync(buffer.AsMemory(0, result.Count), result.MessageType, result.EndOfMessage, ct);
        }
    }
}
