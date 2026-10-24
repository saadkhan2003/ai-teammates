using Dapper;

namespace Teammates.Api;

/// <summary>Only resumes the model-control wait reasons. Existing RunBudget human pauses remain untouched.</summary>
public sealed class AiWaiters(Platform platform) : BackgroundService
{
    public static async Task<int> ResumeReady(Platform platform, CancellationToken ct = default)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var rows = await conn.QueryAsync<(Guid Task, Guid Bot, Guid Owner, string Reason)>("""
            SELECT t.id,t.bot_id,b.owner_id,t.waiting_reason FROM tasks t JOIN bots b ON b.id=t.bot_id
            WHERE t.status='waiting_resource' AND t.waiting_reason IN
             ('Model requests are temporarily paused.','The spending limit has been reached. Please try again later.','Audio requests are temporarily paused.')
            ORDER BY t.updated_at LIMIT 100
            """);
        var resumed = 0;
        foreach (var row in rows)
        {
            var audio = row.Reason == "Audio requests are temporarily paused.";
            var resolution = await platform.AiRegistry.Resolve(audio ? "vision" : "chat", row.Owner, row.Task, row.Bot, ct);
            if (resolution.KillSwitch?.Mode == "stop") continue;
            var spend = resolution.CheckSpend == null ? new AiSpendDecision() : await resolution.CheckSpend(ct);
            if (spend.Blocked || audio && (resolution.KillSwitch?.Mode == "safe" || resolution.Role?.Privacy == true || spend.Downgrade != null) || resolution.KillSwitch is { Mode: "safe", SafeModel: { } safe } && spend.Downgrade != null && spend.Downgrade != safe) continue;
            var id = await conn.ExecuteScalarAsync<Guid?>("""
                UPDATE tasks SET status='queued',waiting_reason=NULL,error=NULL,error_code=NULL,
                  lease_owner=NULL,lease_until=NULL,lease_epoch=lease_epoch+1,updated_at=now()
                WHERE id=@task AND bot_id=@bot AND status='waiting_resource' AND waiting_reason IN
                 ('Model requests are temporarily paused.','The spending limit has been reached. Please try again later.','Audio requests are temporarily paused.') RETURNING id
                """, new { task = row.Task, bot = row.Bot });
            if (id == null) continue;
            resumed++;
            await platform.Audit("system", "ai.task_resumed", row.Bot, row.Task, new { reason = "model_access_restored" });
            await Reliability.Event(platform, row.Task, "resource_resumed", new { resource = "model_access" });
        }
        if (resumed > 0) platform.Tasks.Pulse();
        return resumed;
    }
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try { await ResumeReady(platform, stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception) { /* A failed scan cannot resume work; retry on the next tick. */ }
        }
    }
}
