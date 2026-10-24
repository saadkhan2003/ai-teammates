using Dapper;
using Teammates.Compute;

namespace Teammates.Api;

// Computer control/recovery may take longer than a task lease. Keep the database-only
// sweeps independent so a slow or stopped desktop cannot starve task recovery.
public sealed class TaskLeaseMaintenance(
    Func<CancellationToken, Task> sweep,
    ILogger<TaskLeaseMaintenance> logger,
    TimeSpan? interval = null) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await sweep(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex)
            {
                logger.LogWarning("task lease maintenance skipped {Message}", OutputRedactor.Redact(ex.Message));
            }
            try { await Task.Delay(interval ?? TimeSpan.FromSeconds(2), stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
        }
    }

    public static async Task Sweep(Platform platform, CancellationToken ct)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var stalled = await conn.QueryAsync<(Guid Id, Guid BotId, string Title, Guid? ConversationId, bool ForceCompact, double IdleSeconds, bool ToolInFlight)>("""
            SELECT t.id,t.bot_id,t.title,t.conversation_id,t.force_compact,
                   extract(epoch from now()-coalesce((t.checkpoint->>'lastProgressAt')::timestamptz,t.last_progress_at)),
                   (CASE WHEN t.checkpoint ? 'inFlightToolStartedAt' THEN
                       now() < (t.checkpoint->>'inFlightToolStartedAt')::timestamptz
                           + (greatest(1,least(600,coalesce((t.checkpoint->>'inFlightToolTimeoutSeconds')::int,120))) * interval '1 second')
                       ELSE false END)
            FROM tasks t WHERE t.status='running' AND t.lease_until>now()
            """);
        foreach (var task in stalled)
        {
            var decision = StallEscalation.Decide(task.IdleSeconds, platform.StallSoftSeconds, platform.StallHardSeconds, task.ForceCompact);
            if (decision == StallEscalationDecision.ForceCompact)
                await conn.ExecuteAsync("UPDATE tasks SET force_compact=true WHERE id=@id AND status='running' AND force_compact=false", new { id = task.Id });
            else if (decision == StallEscalationDecision.Abandon && !task.ToolInFlight)
            {
                await conn.ExecuteAsync("UPDATE tasks SET lease_until=now(),checkpoint=jsonb_set(coalesce(checkpoint,'{}'::jsonb),'{stallEndReason}','\"stalled\"'::jsonb,true) WHERE id=@id AND status='running' AND lease_until>now()", new { id = task.Id });
            }
        }
        await Reliability.SweepExpiredLeases(platform, platform.MaxAutoResumesPerHour);
    }
}
