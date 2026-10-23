using Dapper;
using System.Text.Json.Nodes;

namespace Teammates.Api;

public static class TaskErrors
{
    public static (string Code, string Text) Describe(string? code) => code switch
    {
        "connect_openrouter" or "no_openrouter_key" => ("no_openrouter_key", "No OpenRouter key set. Add one in Settings > Vault."),
        "provider rejected the request" or "provider_error" => ("provider_error", "The model provider rejected the request. Check the key and model in Settings > Vault."),
        "step_budget" => ("step_budget", "The task reached its step limit. Raise the task budget or the bot's default work limit in Work settings."),
        "time_budget" => ("time_budget", "The task reached its time limit. Raise the task budget or the bot's default work limit in Work settings."),
        "repeat_loop" or "invalid_repeat" or "model round cap reached" => ("run_limit", "The task stopped after reaching a run limit. Try a smaller request."),
        "denied" => ("denied", "The requested action was denied."),
        _ => ("worker_error", "The task could not finish. Please retry or check the service status.")
    };
}

public static class Reliability
{
    public static int BackoffSeconds(int consecutiveNoProgressResumes) => Math.Min(60, 2 * (1 << Math.Clamp(consecutiveNoProgressResumes - 1, 0, 5)));

    public static bool IsExcluded(string? status) => status is "waiting_approval" or "waiting_human" or "cancelled";
    public static bool IsAutoResumeReason(string? reason) => reason is "lease_expired" or "computer_recovered" or "network_interrupted" or "attempt_limit";
    public static int RecentAutoResumes(JsonArray attempts, DateTimeOffset now) => attempts
        .OfType<JsonObject>()
        .Count(x => DateTimeOffset.TryParse((string?)x["endedAt"], out var end) && end >= now.AddHours(-1) && IsAutoResumeReason((string?)x["endReason"]));

    public static int ConsecutiveNoProgress(JsonArray attempts)
    {
        var count = 0;
        foreach (var item in attempts.OfType<JsonObject>().Reverse())
        {
            if ((string?)item["endReason"] is not ("lease_expired" or "computer_recovered" or "network_interrupted")) continue;
            if ((bool?)item["progress"] == true) break;
            count++;
        }
        return count;
    }

    public static async Task SweepExpiredLeases(Platform platform, int maxAutoResumesPerHour)
    {
        var pendingEvents = new List<(Guid Id, string Type, object Detail)>();
        var requeued = false;
        await using (var conn = await platform.Data.OpenConnectionAsync())
        await using (var tx = await conn.BeginTransactionAsync())
        {
            var rows = await conn.QueryAsync<(Guid Id, int Attempt, string? Checkpoint, int Steps, int ModelRounds, string Status)>("""
                SELECT t.id,t.attempt,t.checkpoint::text AS checkpoint,
                       (SELECT count(*)::int FROM task_steps s WHERE s.task_id=t.id) AS steps,
                       t.model_calls AS model_rounds,t.status
                FROM tasks t WHERE t.status='running' AND t.lease_until<now()
                  AND t.status NOT IN ('waiting_approval','waiting_human','cancelled')
                  AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.task_id=t.id AND a.status='pending')
                FOR UPDATE OF t SKIP LOCKED
                """, transaction: tx);
            foreach (var task in rows)
            {
                if (IsExcluded(task.Status)) continue;
                var ledger = TaskCheckpoint.Read(task.Checkpoint);
                var now = DateTimeOffset.UtcNow;
                var started = DateTimeOffset.TryParse((string?)ledger["attemptStartedAt"], out var at) ? at : now;
                var lastProgress = DateTimeOffset.TryParse((string?)ledger["lastProgressAt"], out var progressAt) ? progressAt : DateTimeOffset.MinValue;
                var progress = lastProgress > started;
                var attempts = ledger["attempts"] as JsonArray ?? new JsonArray();
                attempts.Add(new JsonObject {
                    ["n"] = task.Attempt, ["startedAt"] = started.ToString("O"), ["endedAt"] = now.ToString("O"),
                    ["endReason"] = "lease_expired", ["stepsAtEnd"] = task.Steps, ["progress"] = progress
                });
                while (attempts.Count > 16) attempts.RemoveAt(0);
                var withinHour = RecentAutoResumes(attempts, now);
                var noProgress = ConsecutiveNoProgress(attempts);
                ledger["v"] = 1; ledger["stepsUsed"] = task.Steps; ledger["modelRounds"] = task.ModelRounds;
                ledger["attempts"] = attempts; ledger["secondsUsed"] = (int?)ledger["secondsBeforeAttempt"] + Math.Max(0, (int)(now - started).TotalSeconds);
                ledger["lastLeaseAt"] = now.ToString("O");
                var json = TaskCheckpoint.Bounded(ledger);
                if (withinHour >= maxAutoResumesPerHour)
                {
                    await conn.ExecuteAsync("UPDATE tasks SET status='waiting_human',waiting_reason='resume_exhausted',checkpoint=@json::jsonb,lease_owner=NULL,lease_until=NULL,resume_after=NULL,updated_at=now() WHERE id=@id AND status='running'", new { task.Id, json }, tx);
                    pendingEvents.Add((task.Id, "resume_exhausted", new { attempt = task.Attempt, resumesInLastHour = withinHour }));
                }
                else if (noProgress >= 2)
                {
                    var lastCall = TaskCheckpoint.Id((string?)ledger["lastToolCallId"]);
                    await conn.ExecuteAsync("UPDATE tasks SET status='waiting_human',waiting_reason='no_progress',checkpoint=@json::jsonb,lease_owner=NULL,lease_until=NULL,resume_after=NULL,updated_at=now() WHERE id=@id AND status='running'", new { task.Id, json }, tx);
                    pendingEvents.Add((task.Id, "no_progress", new { attempt = task.Attempt, consecutiveAttempts = noProgress, lastToolCallId = lastCall }));
                }
                else
                {
                    var delay = BackoffSeconds(noProgress);
                    await conn.ExecuteAsync("UPDATE tasks SET status='queued',waiting_reason='lease_expired',checkpoint=@json::jsonb,lease_owner=NULL,lease_until=NULL,resume_after=now()+(@delay * interval '1 second'),updated_at=now() WHERE id=@id AND status='running'", new { task.Id, json, delay }, tx);
                    pendingEvents.Add((task.Id, "resume_scheduled", new { attempt = task.Attempt, reason = "lease_expired", backoffSeconds = delay, stepsUsed = task.Steps }));
                    requeued = true;
                }
            }
            await tx.CommitAsync();
        }
        foreach (var item in pendingEvents) await Event(platform, item.Id, item.Type, item.Detail);
        if (requeued) platform.Tasks.Pulse();
    }

    public static bool WaitsForKey(string? status, string? reason) => status == "waiting_resource" && reason is "connect_openrouter" or "no_openrouter_key";

    public static async Task ResumeKeyWaiters(Platform platform, Guid owner)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        var ids = (await conn.QueryAsync<Guid>("""
            UPDATE tasks t SET status='queued', waiting_reason=NULL, error=NULL, error_code=NULL,
                lease_owner=NULL, lease_until=NULL, lease_epoch=lease_epoch+1, updated_at=now()
            FROM bots b WHERE t.bot_id=b.id AND b.owner_id=@owner
              AND t.status='waiting_resource' AND t.waiting_reason IN ('connect_openrouter','no_openrouter_key')
              AND EXISTS (SELECT 1 FROM secrets s WHERE s.owner_user_id=@owner AND s.provider='openrouter'
                  AND s.name='default' AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>now()))
            RETURNING t.id
            """, new { owner })).ToList();
        foreach (var id in ids)
            await Event(platform, id, "resource_resumed", new { resource = "openrouter" });
        if (ids.Count > 0) platform.Tasks.Pulse();
    }

    public static async Task Event(Platform platform, Guid taskId, string type, object detail)
    {
        var json = InjectionFilter.ScrubJson(System.Text.Json.JsonSerializer.Serialize(detail));
        await using var conn = await platform.Data.OpenConnectionAsync();
        await conn.ExecuteAsync("INSERT INTO task_run_events (task_id,type,detail) VALUES (@taskId,@type,CAST(@json AS jsonb))", new { taskId, type, json });
        await platform.Publish(new { type, taskId, detail = System.Text.Json.JsonSerializer.Deserialize<object>(json) });
    }
}
