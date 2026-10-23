using System.Text.Json;
using Dapper;

namespace Teammates.Api;

/// <summary>Message actions in the chat: soft delete and retry (docs/BOT_MESSAGING.md section 10).</summary>
public static class ChatActions
{
    private static readonly string[] Active = { "running", "planning", "queued", "waiting_human", "waiting_approval", "waiting_resource" };
    private static readonly string[] Retryable = { "failed", "cancelled" };

    public static bool IsRunning(string? status) => status is "running" or "planning";
    public static bool CanRetry(string? status) => status != null && Retryable.Contains(status);

    public static async Task<IResult> Delete(Platform platform, Guid user, Guid messageId)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        var row = await conn.QuerySingleOrDefaultAsync(
            """
            SELECT m.id, m.kind, m.content, m.deleted_at, m.task_id, c.bot_id, c.id AS conversation_id
            FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN bots b ON b.id=c.bot_id
            WHERE m.id=@messageId AND b.owner_id=@user
            """, new { messageId, user });
        if (row == null) return Results.NotFound();
        if (row.deleted_at != null) return Results.NoContent();
        var running = await conn.ExecuteScalarAsync<int>(
            "SELECT count(*) FROM tasks t WHERE t.status IN ('running','planning') AND (t.source_message_id=@messageId OR t.id=@taskId)",
            new { messageId, taskId = (Guid?)row.task_id });
        if (running > 0) return Results.Json(new { error = "task_running" }, statusCode: 409);
        if ((string)row.kind == "question" && !((string)row.content).Contains("\"answer\""))
            return Results.Json(new { error = "open_question" }, statusCode: 409);
        await using var tx = await conn.BeginTransactionAsync();
        await conn.ExecuteAsync("UPDATE messages SET content='', metadata='{}'::jsonb, deleted_at=now() WHERE id=@messageId", new { messageId }, tx);
        await conn.ExecuteAsync("DELETE FROM message_reactions WHERE message_id=@messageId", new { messageId }, tx);
        await tx.CommitAsync();
        await platform.Audit("user:" + user, "chat.message_deleted", (Guid)row.bot_id, null, new { messageId });
        await platform.Publish(new { type = "message.deleted", messageId, conversationId = (Guid)row.conversation_id });
        return Results.NoContent();
    }

    public static async Task<IResult> Retry(Platform platform, Guid user, Guid messageId)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        var row = await conn.QuerySingleOrDefaultAsync(
            """
            SELECT m.id, m.role, m.task_id, m.deleted_at, c.bot_id, c.id AS conversation_id
            FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN bots b ON b.id=c.bot_id
            WHERE m.id=@messageId AND b.owner_id=@user
            """, new { messageId, user });
        if (row == null) return Results.NotFound();
        if (row.deleted_at != null) return Results.Json(new { error = "not_retryable" }, statusCode: 409);
        Guid? source = (string)row.role == "user"
            ? messageId
            : await conn.ExecuteScalarAsync<Guid?>("SELECT source_message_id FROM tasks WHERE id=@t", new { t = (Guid?)row.task_id });
        if (source == null) return Results.Json(new { error = "not_retryable" }, statusCode: 409);
        var latest = await conn.QuerySingleOrDefaultAsync(
            "SELECT id, status, title, instruction, kind, priority, created_at FROM tasks WHERE source_message_id=@source ORDER BY created_at DESC LIMIT 1", new { source });
        if (latest == null) return Results.Json(new { error = "not_retryable" }, statusCode: 409);
        var status = (string)latest.status;
        if (Active.Contains(status)) return Results.Json(new { error = IsRunning(status) ? "task_running" : "already_queued", taskId = (Guid)latest.id }, statusCode: 409);
        if (!CanRetry(status)) return Results.Json(new { error = "not_retryable" }, statusCode: 409);
        var recent = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM tasks WHERE source_message_id=@source AND created_at > now() - interval '5 seconds'", new { source });
        if (recent > 0) return Results.Json(new { error = "retry_too_soon" }, statusCode: 429);
        var taskId = await conn.ExecuteScalarAsync<Guid>(
            "INSERT INTO tasks (bot_id, conversation_id, title, instruction, kind, priority, status, source_message_id) VALUES (@bot, @conversation, @title, @instruction, @kind, @priority, 'queued', @source) RETURNING id",
            new { bot = (Guid)row.bot_id, conversation = (Guid)row.conversation_id, title = (string)latest.title, instruction = (string)latest.instruction, kind = (string)latest.kind, priority = (int)latest.priority, source });
        await platform.Audit("user:" + user, "chat.message_retried", (Guid)row.bot_id, taskId, new { messageId, source });
        await platform.Publish(new { type = "task", taskId });
        platform.Tasks.Pulse();
        return Results.Json(new { taskId, status = "queued" });
    }
}
