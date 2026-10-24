using Dapper;
using Npgsql;
using Teammates.Compute;

namespace Teammates.Api;

public static class DesktopRwConnections
{
    public static string InstanceId { get; } = Guid.NewGuid().ToString("N");
    public sealed record ReleasedLease(Guid ComputerId, long Epoch, Guid? HolderUserId);

    public static async Task RegisterAsync(NpgsqlDataSource data, Guid computerId, long epoch, Guid connectionId, CancellationToken ct)
    {
        await using var conn = await data.OpenConnectionAsync(ct);
        await conn.ExecuteAsync(new CommandDefinition("""
            INSERT INTO desktop_rw_connections (lease_computer_id,display,epoch,instance_id,conn_id) VALUES (@computerId,1,@epoch,@instance,@connectionId)
            ON CONFLICT DO NOTHING
            """, new { computerId, epoch, instance = InstanceId, connectionId }, cancellationToken: ct));
        await conn.ExecuteAsync(new CommandDefinition("UPDATE desktop_lease SET release_after=NULL WHERE computer_id=@computerId AND display=1 AND epoch=@epoch", new { computerId, epoch }, cancellationToken: ct));
    }

    public static async Task HeartbeatAsync(NpgsqlDataSource data, Guid computerId, long epoch, Guid connectionId, CancellationToken ct)
    {
        await using var conn = await data.OpenConnectionAsync(ct);
        await conn.ExecuteAsync(new CommandDefinition("UPDATE desktop_rw_connections SET heartbeat_at=clock_timestamp() WHERE lease_computer_id=@computerId AND display=1 AND epoch=@epoch AND instance_id=@instance AND conn_id=@connectionId", new { computerId, epoch, instance = InstanceId, connectionId }, cancellationToken: ct));
    }

    public static async Task DisconnectedAsync(NpgsqlDataSource data, Guid computerId, long epoch, Guid connectionId)
    {
        await using var conn = await data.OpenConnectionAsync();
        await conn.ExecuteAsync("DELETE FROM desktop_rw_connections WHERE lease_computer_id=@computerId AND display=1 AND epoch=@epoch AND instance_id=@instance AND conn_id=@connectionId", new { computerId, epoch, instance = InstanceId, connectionId });
        await conn.ExecuteAsync("""
            UPDATE desktop_lease SET release_after=clock_timestamp()+interval '12 seconds'
            WHERE computer_id=@computerId AND display=1 AND epoch=@epoch AND holder_kind='human'
              AND NOT EXISTS (SELECT 1 FROM desktop_rw_connections WHERE lease_computer_id=@computerId AND display=1 AND epoch=@epoch AND heartbeat_at>clock_timestamp()-interval '30 seconds')
            """, new { computerId, epoch });
    }

    public static async Task<int> SweepOnceAsync(Platform platform, ILogger logger, CancellationToken ct)
    {
        var released = await ClaimDueAsync(platform.Data, ct);
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        foreach (var row in released)
        {
            var bot = await conn.ExecuteScalarAsync<Guid?>("SELECT desktop_bot_id FROM user_computers WHERE computer_id=@id", new { id = row.ComputerId });
            try
            {
                if (bot != null)
                {
                    await platform.Tickets.InvalidateLeaseAsync(bot.Value, row.Epoch, ct);
                    await conn.ExecuteAsync("UPDATE control_locks SET holder='agent',epoch=@epoch,updated_at=clock_timestamp() WHERE bot_id=@bot", new { epoch = row.Epoch, bot });
                    await platform.Compute.SetHolderAsync(new ComputerId(row.ComputerId.ToString()), "fenced", (ulong)row.Epoch, ct);
                    await platform.Audit(row.HolderUserId?.ToString() ?? "system", "desktop.lease.release", bot, null, new { reason = "rw_websocket_grace_expired", epoch = row.Epoch });
                    await platform.Publish(new { type = "computer.mode", botId = bot, mode = "watching", epoch = row.Epoch });
                }
            }
            catch (Exception ex) { logger.LogWarning("desktop lease release effect failed: {Type}", ex.GetType().Name); }
        }
        return released.Count;
    }

    public static async Task<IReadOnlyList<ReleasedLease>> ClaimDueAsync(NpgsqlDataSource data, CancellationToken ct)
    {
        await using var conn = await data.OpenConnectionAsync(ct);
        await conn.ExecuteAsync(new CommandDefinition("""
            UPDATE desktop_lease l SET release_after=clock_timestamp()+interval '12 seconds'
            WHERE l.holder_kind='human' AND l.release_after IS NULL
              AND EXISTS (SELECT 1 FROM desktop_rw_connections r WHERE r.lease_computer_id=l.computer_id AND r.display=l.display AND r.epoch=l.epoch)
              AND NOT EXISTS (SELECT 1 FROM desktop_rw_connections r WHERE r.lease_computer_id=l.computer_id AND r.display=l.display AND r.epoch=l.epoch AND r.heartbeat_at>clock_timestamp()-interval '30 seconds');
            """, cancellationToken: ct));
        await conn.ExecuteAsync(new CommandDefinition("DELETE FROM desktop_rw_connections WHERE heartbeat_at<clock_timestamp()-interval '2 minutes'", cancellationToken: ct));
        return (await conn.QueryAsync<ReleasedLease>(new CommandDefinition("""
            WITH due AS (
              SELECT computer_id,display,holder_user_id FROM desktop_lease
              WHERE release_after<=clock_timestamp() AND holder_kind='human'
                AND NOT EXISTS (SELECT 1 FROM desktop_rw_connections r WHERE r.lease_computer_id=desktop_lease.computer_id
                  AND r.display=desktop_lease.display AND r.epoch=desktop_lease.epoch AND r.heartbeat_at>clock_timestamp()-interval '30 seconds')
              ORDER BY release_after FOR UPDATE SKIP LOCKED LIMIT 32
            )
            UPDATE desktop_lease l SET holder_kind='none',holder_user_id=NULL,tab_id=NULL,epoch=l.epoch+1,
              expires_at=clock_timestamp(),updated_at=clock_timestamp(),release_after=NULL
            FROM due WHERE l.computer_id=due.computer_id AND l.display=due.display
            RETURNING l.computer_id AS "ComputerId",l.epoch AS "Epoch",due.holder_user_id AS "HolderUserId"
            """, cancellationToken: ct))).ToArray();
    }
}

public sealed class DesktopLeaseSweepService(Platform platform, ILogger<DesktopLeaseSweepService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        do
        {
            try { await DesktopRwConnections.SweepOnceAsync(platform, logger, stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex) { logger.LogWarning("desktop lease sweep failed: {Type}", ex.GetType().Name); }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
