using Npgsql;
namespace Teammates.Api;

/// <summary>Revocations cross API instances; the short TTL also covers missed notifications.</summary>
public sealed class SessionCacheInvalidator(Platform platform, ILogger<SessionCacheInvalidator> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var conn=await platform.Data.OpenConnectionAsync(stoppingToken);
                conn.Notification += (_, notification) => Apply(platform.SessionUsers,notification.Payload);
                await using var command=new NpgsqlCommand("LISTEN session_user_changed",conn);
                await command.ExecuteNonQueryAsync(stoppingToken);
                platform.SessionUsers.Invalidate();
                while (!stoppingToken.IsCancellationRequested) await conn.WaitAsync(stoppingToken);
            }
            catch (OperationCanceledException) when(stoppingToken.IsCancellationRequested) { break; }
            catch(Exception)
            {
                platform.SessionUsers.Invalidate();
                logger.LogWarning("Session cache invalidation connection interrupted");
                try { await Task.Delay(1000,stoppingToken); } catch(OperationCanceledException) { break; }
            }
        }
    }
    public static void Apply(SessionUserCache cache,string payload)
    {
        if (payload.StartsWith("user:",StringComparison.Ordinal) && Guid.TryParse(payload[5..],out var user)) cache.Invalidate(user);
        else if(payload.StartsWith("hash:",StringComparison.Ordinal)) cache.Invalidate(hash:payload[5..]);
        else cache.Invalidate();
    }
}
