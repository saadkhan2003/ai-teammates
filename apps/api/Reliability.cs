using Dapper;

namespace Teammates.Api;

public static class TaskErrors
{
    public static (string Code, string Text) Describe(string? code) => code switch
    {
        "connect_openrouter" or "no_openrouter_key" => ("no_openrouter_key", "No platform key set. Add one in Settings > Vault."),
        "provider rejected the request" or "provider_error" => ("provider_error", "The request was rejected. Check the key in Settings > Vault."),
        "step_budget" or "time_budget" or "repeat_loop" or "invalid_repeat" or "model round cap reached" => ("run_limit", "The task stopped after reaching a run limit. Try a smaller request."),
        "denied" => ("denied", "The requested action was denied."),
        _ => ("worker_error", "The task could not finish. Please retry or check the service status.")
    };
}

public static class Reliability
{
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
