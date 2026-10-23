using Dapper;
using System.Text.Json;
using Teammates.Compute;

namespace Teammates.Api;

public sealed record ResumeNoticeState(int Count, int Attempt, string Reason, int StepsUsed, string Current, DateTimeOffset FirstAt, DateTimeOffset LastAt);

public static class ResumeNotices
{
    public static string BuildNotice(int count, int attempt, string reason, int stepsUsed, string current, DateTimeOffset firstAt, DateTimeOffset lastAt) =>
        InjectionFilter.ScrubJson(JsonSerializer.Serialize(new { type = "resume", @event = "resumed", count, attempt, reason = Safe(reason), stepsUsed = Math.Max(0, stepsUsed), current = Safe(current), firstAt = firstAt.ToString("O"), lastAt = lastAt.ToString("O") }));

    public static string BuildCompactedNotice(Guid taskId, int archived, int keptSteps) =>
        InjectionFilter.ScrubJson(JsonSerializer.Serialize(new { type = "resume", @event = "compacted", taskId, archived = Math.Max(0, archived), keptSteps = Math.Max(0, keptSteps) }));

    public static string BuildCard(string reason, Guid taskId, int stepsUsed, int maxSteps, int secondsUsed, int maxSeconds, string current) =>
        InjectionFilter.ScrubJson(JsonSerializer.Serialize(new { type = "resume_card", reason = Safe(reason), state = "open", taskId, stepsUsed = Math.Max(0, stepsUsed), maxSteps = Math.Max(0, maxSteps), secondsUsed = Math.Max(0, secondsUsed), maxSeconds = Math.Max(0, maxSeconds), current = Safe(current) }));

    public static (bool Collapse, string? Content) Collapse(string? existingContent, int attempt, string reason, int stepsUsed, string current, DateTimeOffset now)
    {
        try
        {
            using var doc = JsonDocument.Parse(existingContent ?? "{}");
            var root = doc.RootElement;
            if (root.GetProperty("type").GetString() != "resume" || root.GetProperty("event").GetString() != "resumed") return (false, null);
            if (!DateTimeOffset.TryParse(root.GetProperty("lastAt").GetString(), out var lastAt) || now - lastAt > TimeSpan.FromMinutes(15) || now < lastAt) return (false, null);
            var first = DateTimeOffset.TryParse(root.GetProperty("firstAt").GetString(), out var firstAt) ? firstAt : lastAt;
            var count = root.TryGetProperty("count", out var c) && c.TryGetInt32(out var n) ? n : 1;
            return (true, BuildNotice(count + 1, attempt, reason, stepsUsed, current, first, now));
        }
        catch (JsonException) { return (false, null); }
        catch (InvalidOperationException) { return (false, null); }
        catch (KeyNotFoundException) { return (false, null); }
    }

    public static bool IsCardReason(string reason) => reason is "budget_reached" or "no_progress" or "resume_exhausted" or "context_exhausted";
    public static bool IsResumeReason(string reason) => Reliability.IsAutoResumeReason(reason);
    public static bool ShouldInsertCard(bool hasOpenCard) => !hasOpenCard;

    public static string ChangeCardState(string content, string state)
    {
        using var doc = JsonDocument.Parse(content);
        var root = doc.RootElement;
        if (root.GetProperty("type").GetString() != "resume_card" || root.GetProperty("state").GetString() != "open") return content;
        var values = new Dictionary<string, object?>();
        foreach (var property in root.EnumerateObject()) values[property.Name] = JsonSerializer.Deserialize<object>(property.Value.GetRawText());
        values["state"] = state is "continued" or "stopped" ? state : "open";
        return InjectionFilter.ScrubJson(JsonSerializer.Serialize(values));
    }

    private static string Safe(string? text) => InjectionFilter.Strip(Dlp.Redact(OutputRedactor.Redact(text ?? "")));

    public static async Task Persist(Platform platform, Guid taskId, string type, object detail)
    {
        try
        {
            var raw = JsonSerializer.SerializeToElement(detail);
            var reason = raw.TryGetProperty("reason", out var r) ? r.GetString() ?? "" : "";
            await using var conn = await platform.Data.OpenConnectionAsync();
            var task = await conn.QuerySingleOrDefaultAsync<(Guid? ConversationId, int Attempt, int Steps, int? MaxSteps, int? MaxSeconds, string? Checkpoint)>("""
                SELECT conversation_id,attempt,(SELECT count(*)::int FROM task_steps WHERE task_id=t.id),budget_steps,budget_seconds,checkpoint::text
                FROM tasks t WHERE id=@taskId
                """, new { taskId });
            if (task.ConversationId == null) return;

            var ownerAction = type is "budget_continued" or "budget_raised" or "task_stopped" ||
                type == "resumed" && raw.TryGetProperty("source", out var source) && source.GetString() == "user_message";
            if (ownerAction)
            {
                var state = type == "task_stopped" ? "stopped" : "continued";
                var changed = await conn.ExecuteAsync("""
                    UPDATE messages SET content=jsonb_set(content::jsonb,'{state}',to_jsonb(@state::text),true)::text
                    WHERE id=(SELECT id FROM messages WHERE task_id=@taskId AND kind='text'
                        AND left(content,1)='{' AND content ~ '"type"\s*:\s*"resume_card"'
                        AND content ~ '"state"\s*:\s*"open"'
                        ORDER BY created_at DESC LIMIT 1)
                    """, new { taskId, state });
                if (changed > 0) await platform.Publish(new { type = "message", conversationId = task.ConversationId });
                return;
            }

            var stepsUsed = raw.TryGetProperty("stepsUsed", out var su) && su.TryGetInt32(out var steps) ? steps : task.Steps;
            var checkpoint = TaskCheckpoint.Read(task.Checkpoint);
            var current = await conn.ExecuteScalarAsync<string?>("SELECT title FROM task_plan_items WHERE task_id=@taskId ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,position LIMIT 1", new { taskId });
            string? content = null;
            var updatedExisting = false;
            if (type == "resumed" && IsResumeReason(reason))
            {
                var now = DateTimeOffset.UtcNow;
                var prior = await conn.QuerySingleOrDefaultAsync<string?>("SELECT content FROM messages WHERE task_id=@taskId AND kind='text' ORDER BY created_at DESC LIMIT 1", new { taskId });
                var collapse = Collapse(prior, task.Attempt, reason, stepsUsed, current ?? "", now);
                if (collapse.Collapse)
                {
                    content = collapse.Content;
                    await conn.ExecuteAsync("UPDATE messages SET content=@content WHERE id=(SELECT id FROM messages WHERE task_id=@taskId AND kind='text' ORDER BY created_at DESC LIMIT 1)", new { taskId, content });
                    updatedExisting = true;
                }
                else content = BuildNotice(1, task.Attempt, reason, stepsUsed, current ?? "", now, now);
            }
            else if (IsCardReason(type))
            {
                var open = await conn.ExecuteScalarAsync<bool>("""
                    SELECT EXISTS(SELECT 1 FROM messages WHERE task_id=@taskId AND kind='text'
                        AND left(content,1)='{' AND content ~ '"type"\s*:\s*"resume_card"'
                        AND content ~ '"state"\s*:\s*"open"'
                        AND content ~ ('"reason"\s*:\s*"' || @type || '"'))
                    """, new { taskId, type });
                if (!ShouldInsertCard(open)) return;
                var secondsUsed = (int?)checkpoint["secondsUsed"] ?? 0;
                content = BuildCard(type, taskId, stepsUsed, task.MaxSteps ?? 200, secondsUsed, task.MaxSeconds ?? 3600, current ?? "");
            }
            else if (type == "compacted")
            {
                var archived = raw.TryGetProperty("archived", out var archivedValue) && archivedValue.TryGetInt32(out var count) ? count : 0;
                var kept = raw.TryGetProperty("kept", out var keptValue) && keptValue.TryGetInt32(out var keptCount) ? keptCount : 20;
                content = BuildCompactedNotice(taskId, archived, Math.Min(20, kept));
            }
            if (content == null) return;
            if (!updatedExisting)
                await conn.ExecuteAsync("INSERT INTO messages(conversation_id,role,kind,content,task_id) VALUES(@conversation,'assistant','text',@content,@taskId)", new { conversation = task.ConversationId, content, taskId });
            await platform.Publish(new { type = "message", conversationId = task.ConversationId });
        }
        catch { /* A chat notice must never break the task event. */ }
    }
}
