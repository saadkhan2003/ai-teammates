using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using Npgsql;

namespace Teammates.Api;

public sealed record OneTimeTicket(Guid Id, string Kind, string Token, Guid UserId, Guid BotId, Guid? ComputerId,
    string Role, string TabId, long Epoch, string Scope, byte[]? IpHash, DateTime ExpiresAt);

public interface IOneTimeTicketStore
{
    Task IssueAsync(OneTimeTicket ticket, CancellationToken ct);
    Task<OneTimeTicket?> ConsumeAsync(string token, string kind, Guid userId, Guid botId, byte[]? ipHash, CancellationToken ct);
    Task InvalidateLeaseAsync(Guid botId, long epoch, CancellationToken ct);
}

public sealed class InMemoryOneTimeTicketStore : IOneTimeTicketStore
{
    private readonly ConcurrentDictionary<string, OneTimeTicket> _tickets = new(StringComparer.Ordinal);
    public Task IssueAsync(OneTimeTicket ticket, CancellationToken ct)
    {
        if (!_tickets.TryAdd(Key(ticket.Token), ticket)) throw new CryptographicException("ticket collision");
        return Task.CompletedTask;
    }

    public Task<OneTimeTicket?> ConsumeAsync(string token, string kind, Guid userId, Guid botId, byte[]? ipHash, CancellationToken ct)
    {
        var key = Key(token);
        if (!_tickets.TryGetValue(key, out var ticket) || ticket.Kind != kind || ticket.UserId != userId || ticket.BotId != botId
            || !Same(ticket.IpHash, ipHash) || ticket.ExpiresAt <= DateTime.UtcNow) return Task.FromResult<OneTimeTicket?>(null);
        return Task.FromResult(_tickets.TryRemove(key, out var used) ? used : null);
    }
    public Task InvalidateLeaseAsync(Guid botId, long epoch, CancellationToken ct)
    { foreach (var pair in _tickets) if (pair.Value.Kind == "vnc" && pair.Value.BotId == botId && pair.Value.Epoch != epoch) _tickets.TryRemove(pair.Key, out _); return Task.CompletedTask; }

    private static string Key(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
    private static bool Same(byte[]? a, byte[]? b) => a is null ? b is null : b is not null && a.Length == b.Length && CryptographicOperations.FixedTimeEquals(a, b);
}

public sealed class PostgresOneTimeTicketStore(NpgsqlDataSource data) : IOneTimeTicketStore
{
    private sealed record TicketRow(Guid Id, string Kind, string Token, Guid UserId, Guid BotId, Guid? ComputerId,
        string Role, string TabId, long Epoch, string Scope, byte[]? IpHash, DateTime ExpiresAt);
    public async Task IssueAsync(OneTimeTicket ticket, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ticket);
        if (ticket.Token.Length is < 32 or > 8192 || ticket.Kind.Length is < 1 or > 32 || ticket.Role.Length > 32
            || ticket.TabId.Length > 128 || ticket.Scope.Length > 16_384) throw new ArgumentException("invalid one-time ticket");
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(ticket.Token));
        await using var conn = await data.OpenConnectionAsync(ct);
        await conn.ExecuteAsync(new CommandDefinition("""
            INSERT INTO one_time_tickets (id, kind, token_hash, user_id, bot_id, computer_id, role, tab_id, epoch, scope, ip_hash, expires_at)
            VALUES (@Id,@Kind,@Hash,@UserId,@BotId,@ComputerId,@Role,@TabId,@Epoch,@Scope::jsonb,@IpHash,clock_timestamp()+interval '60 seconds')
            """, new { ticket.Id, ticket.Kind, Hash = hash, ticket.UserId, ticket.BotId, ticket.ComputerId, ticket.Role,
                ticket.TabId, ticket.Epoch, ticket.Scope, ticket.IpHash, ticket.ExpiresAt }, cancellationToken: ct));
    }

    public async Task<OneTimeTicket?> ConsumeAsync(string token, string kind, Guid userId, Guid botId, byte[]? ipHash, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 8192 || kind.Length > 32) return null;
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(token));
        await using var conn = await data.OpenConnectionAsync(ct);
        // Bind claims in the UPDATE predicate: invalid attempts do not consume the row.
        var row = await conn.QuerySingleOrDefaultAsync<TicketRow>(new CommandDefinition("""
            WITH consumed AS (
              UPDATE one_time_tickets SET consumed_at=clock_timestamp()
              WHERE token_hash=@Hash AND kind=@kind AND user_id=@userId AND bot_id=@botId
                AND ip_hash IS NOT DISTINCT FROM @ipHash AND consumed_at IS NULL AND expires_at > clock_timestamp()
              RETURNING id, kind, user_id, bot_id, computer_id, role, tab_id, epoch, scope, ip_hash, expires_at
            ), cleared AS (
              UPDATE desktop_lease l SET release_after=NULL
              FROM consumed c WHERE c.kind='vnc' AND c.role='control' AND c.computer_id=l.computer_id
                AND l.display=1 AND l.epoch=c.epoch AND l.holder_kind='human'
                AND l.holder_user_id=c.user_id AND l.tab_id=c.tab_id
              RETURNING l.computer_id
            )
            SELECT id AS "Id", kind AS "Kind", @token AS "Token", user_id AS "UserId", bot_id AS "BotId",
              computer_id AS "ComputerId", role AS "Role", tab_id AS "TabId", epoch AS "Epoch",
              scope::text AS "Scope", ip_hash AS "IpHash", expires_at AS "ExpiresAt" FROM consumed
            """, new { Hash = hash, kind, userId, botId, ipHash, token }, cancellationToken: ct));
        if (row is null || row.UserId != userId || row.BotId != botId
            || (ipHash is null ? row.IpHash is not null : row.IpHash is null || row.IpHash.Length != ipHash.Length || !CryptographicOperations.FixedTimeEquals(row.IpHash, ipHash))) return null;
        return new OneTimeTicket(row.Id, row.Kind, row.Token, row.UserId, row.BotId, row.ComputerId,
            row.Role, row.TabId, row.Epoch, row.Scope, row.IpHash, DateTime.SpecifyKind(row.ExpiresAt, DateTimeKind.Utc));
    }
    public async Task InvalidateLeaseAsync(Guid botId, long epoch, CancellationToken ct)
    { await using var conn = await data.OpenConnectionAsync(ct); await conn.ExecuteAsync(new CommandDefinition("DELETE FROM one_time_tickets WHERE kind='vnc' AND bot_id=@botId AND epoch<>@epoch", new { botId, epoch }, cancellationToken: ct)); }
}

public sealed class TicketCleanupService(NpgsqlDataSource data, ILogger<TicketCleanupService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1));
        do
        {
            try
            {
                await using var conn = await data.OpenConnectionAsync(stoppingToken);
                await conn.ExecuteAsync(new CommandDefinition("DELETE FROM one_time_tickets WHERE expires_at < clock_timestamp() - interval '5 minutes'", cancellationToken: stoppingToken));
                await conn.ExecuteAsync(new CommandDefinition("DELETE FROM login_broker_slots WHERE created_at < clock_timestamp() - interval '5 minutes'", cancellationToken: stoppingToken));
                await conn.ExecuteAsync(new CommandDefinition("DELETE FROM active_teach WHERE expires_at < clock_timestamp()", cancellationToken: stoppingToken));
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex) { logger.LogWarning("ticket cleanup failed: {Type}", ex.GetType().Name); }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}

public static class TicketScopeCrypto
{
    public static string Encrypt(byte[] key, string value)
    {
        var nonce = RandomNumberGenerator.GetBytes(12); var plain = Encoding.UTF8.GetBytes(value); var cipher = new byte[plain.Length]; var tag = new byte[16];
        using var aes = new AesGcm(key, 16); aes.Encrypt(nonce, plain, cipher, tag);
        CryptographicOperations.ZeroMemory(plain);
        return Convert.ToBase64String(nonce.Concat(tag).Concat(cipher).ToArray());
    }
    public static string Decrypt(byte[] key, string value)
    {
        var blob = Convert.FromBase64String(value); if (blob.Length < 28 || blob.Length > 8192) throw new CryptographicException();
        var plain = new byte[blob.Length - 28]; using var aes = new AesGcm(key, 16); aes.Decrypt(blob.AsSpan(0, 12), blob.AsSpan(28), blob.AsSpan(12, 16), plain);
        return Encoding.UTF8.GetString(plain);
    }
}
