using System.Text;
using System.Text.Json;
using Dapper;
using Teammates.Compute;

namespace Teammates.Api;

public static class WebBotAuthRoutes
{
    public static void Map(WebApplication app, Platform platform)
    {
        app.MapGet("/internal/tasks/{taskId:guid}/private-hosts", async (HttpContext ctx, Guid taskId, CancellationToken ct) =>
        {
            if (!Worker(ctx, platform)) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var owner = await conn.QuerySingleOrDefaultAsync<Guid?>(
                "SELECT b.owner_id FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE t.id=@taskId AND t.status='running' AND t.lease_until > now()",
                new { taskId });
            if (owner is null) return Results.Forbid();
            var policy = await SecurityRoutes.Load(platform, owner.Value);
            return Results.Json(new { hosts = policy.PrivateHosts.Order(StringComparer.OrdinalIgnoreCase).ToArray() });
        });

        app.MapGet("/.well-known/http-message-signatures-directory", async (HttpContext ctx, Guid tenant, CancellationToken ct) =>
        {
            if (tenant == Guid.Empty) return Results.BadRequest(new { error = "tenant required" });
            using var key = await WebBotAuth.GetOrCreateTenantKeyAsync(platform, tenant, ct);
            var bytes = Encoding.UTF8.GetBytes(WebBotAuth.DirectoryJwks(key));
            var contentType = "application/json";
            var agent = platform.Config["WEB_BOT_AUTH_SIGNATURE_AGENT"] ?? "";
            if (agent.Length == 0) return Results.StatusCode(503);
            WebBotAuthDirectorySignature signed;
            try { signed = WebBotAuth.SignDirectoryResponse(ctx.Request.Host.Value ?? "", contentType, bytes, agent, key); }
            catch (ArgumentException) { return Results.StatusCode(503); }
            ctx.Response.Headers["Signature-Agent"] = signed.SignatureAgent;
            ctx.Response.Headers["Signature-Input"] = signed.SignatureInput;
            ctx.Response.Headers["Signature"] = signed.Signature;
            ctx.Response.Headers["Content-Digest"] = signed.ContentDigest;
            return Results.Bytes(bytes, contentType);
        });

        app.MapPost("/internal/web-bot-auth/sign", async (HttpContext ctx, JsonElement body, CancellationToken ct) =>
        {
            if (!Worker(ctx, platform)) return Results.Unauthorized();
            if (!body.TryGetProperty("taskId", out var taskEl) || !taskEl.TryGetGuid(out var taskId) || taskId == Guid.Empty ||
                !body.TryGetProperty("url", out var urlEl) || urlEl.ValueKind != JsonValueKind.String || urlEl.GetString() is not { Length: <= 4096 } urlText ||
                !Uri.TryCreate(urlText, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps || uri.UserInfo.Length > 0 || uri.Fragment.Length > 0 ||
                !body.TryGetProperty("signatureAgent", out var agentEl) || agentEl.ValueKind != JsonValueKind.String || agentEl.GetString() is not { Length: <= 512 } agent)
                return Results.BadRequest(new { error = "invalid signing request" });
            var configuredAgent = platform.Config["WEB_BOT_AUTH_SIGNATURE_AGENT"] ?? "";
            if (configuredAgent.Length == 0 || !string.Equals(configuredAgent, agent, StringComparison.Ordinal))
                return Results.Forbid();
            var allow = AllowedHosts(platform.Config["WEB_BOT_AUTH_ALLOWED_HOSTS"] ?? "");
            if (!allow.Any(host => HostMatches(uri.IdnHost, host))) return Results.Forbid();
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var owner = await conn.QuerySingleOrDefaultAsync<Guid?>(
                "SELECT b.owner_id FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE t.id=@taskId AND t.status='running' AND t.lease_until > now()",
                new { taskId });
            if (owner is null) return Results.Forbid();
            using var key = await WebBotAuth.GetOrCreateTenantKeyAsync(platform, owner.Value, ct);
            WebBotAuthHeaders signed;
            try { signed = WebBotAuth.SignRequest(uri.Authority, agent, key); }
            catch (ArgumentException) { return Results.BadRequest(new { error = "invalid signing request" }); }
            return Results.Json(new { signatureAgent = signed.SignatureAgent, signatureInput = signed.SignatureInput, signature = signed.Signature });
        });
    }

    private static bool Worker(HttpContext ctx, Platform platform)
    {
        var header = ctx.Request.Headers.Authorization.ToString();
        var token = header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? header[7..].Trim() : "";
        var expected = Encoding.UTF8.GetBytes(platform.WorkerToken);
        var actual = Encoding.UTF8.GetBytes(token);
        return expected.Length > 0 && expected.Length == actual.Length && System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(expected, actual);
    }

    private static string[] AllowedHosts(string raw) => raw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .Take(501).Where(host => host.Length is > 0 and <= 253 && !host.Contains('/') && !host.Contains(':') && host.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '-'))
        .Select(host => host.TrimEnd('.').ToLowerInvariant()).Where(host => host.Length > 0).Distinct(StringComparer.Ordinal).Take(500).ToArray();

    private static bool HostMatches(string host, string suffix) => host.Equals(suffix, StringComparison.OrdinalIgnoreCase) || host.EndsWith("." + suffix, StringComparison.OrdinalIgnoreCase);
}
