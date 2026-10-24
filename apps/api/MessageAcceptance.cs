namespace Teammates.Api;

public static class MessageAcceptance
{
    // Reuse the primary key for deduplication without a schema migration. Metadata
    // also exposes client_id to clients that use a different local reconciliation key.
    public const string InsertSql = "INSERT INTO messages (id, conversation_id, role, content, metadata, reply_to_message_id) VALUES (@messageId, @id, 'user', @content, @metadata::jsonb || jsonb_build_object('client_id',@clientId::text), @replyTo) ON CONFLICT (id) DO NOTHING RETURNING id";
    public static object Started(Guid? botId, Guid taskId, Guid messageId, Guid clientId) => new { type = "task.started", botId, taskId, status = "queued", messageId, client_id = clientId };
}
