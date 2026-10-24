using System.Text.Json;
using System.Text.Json.Nodes;
using Dapper;
using Npgsql;
namespace Teammates.Api;

public static class EventProjection
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public static async Task<JsonObject> Enrich(NpgsqlDataSource data, object payload)
    {
        var evt = JsonSerializer.SerializeToNode(payload, Json)!.AsObject();
        Guid? Id(string name) => Guid.TryParse(evt[name]?.ToString(), out var id) ? id : null;
        var taskId=Id("taskId"); var botId=Id("botId"); var conversation=Id("conversationId"); var messageId=Id("messageId");
        if (taskId == null && botId == null && conversation == null && messageId == null) return new JsonObject { ["type"]=evt["type"]?.DeepClone() };
        await using var conn = await data.OpenConnectionAsync();
        if (taskId != null)
        {
            var task = await conn.QuerySingleOrDefaultAsync("SELECT id,bot_id,conversation_id,title,status,kind,waiting_reason,error,error_code,model_calls FROM tasks WHERE id=@taskId",new { taskId });
            if (task == null) return new JsonObject { ["type"]="invalidate" };
            var safeTask = Platform.ToDict((object)task); botId=(Guid)safeTask["botId"]!; conversation=(Guid?)safeTask["conversationId"];
            evt["task"]=JsonSerializer.SerializeToNode(safeTask,Json);
        }
        if (messageId != null && conversation == null) conversation=await conn.ExecuteScalarAsync<Guid?>("SELECT conversation_id FROM messages WHERE id=@messageId",new {messageId});
        if (conversation != null && botId == null) botId=await conn.ExecuteScalarAsync<Guid?>("SELECT bot_id FROM conversations WHERE id=@conversation",new {conversation});
        if (botId == null) return new JsonObject { ["type"]="invalidate" };
        var owner=await conn.ExecuteScalarAsync<Guid?>("SELECT owner_id FROM bots WHERE id=@botId",new {botId});
        if (owner == null) return new JsonObject { ["type"]="invalidate" };
        evt["ownerId"]=owner.Value; evt["botId"]=botId.Value;
        if (conversation != null) evt["conversationId"]=conversation.Value;
        var type=evt["type"]?.ToString();
        if (type is "task" or "task.started" or "message" or "bot.updated" or "approval" or "error" || type?.StartsWith("message.", StringComparison.Ordinal) == true)
        {
            var bot=await conn.QuerySingleAsync("SELECT b.id,b.name,b.role,b.status,b.avatar,b.avatar_shape,b.avatar_color,b.section,b.notifications_enabled,b.is_primary,b.bio,b.peer_messaging, (EXISTS(SELECT 1 FROM approvals a WHERE a.bot_id=b.id AND a.status='pending') OR EXISTS(SELECT 1 FROM tasks t WHERE t.bot_id=b.id AND t.status IN ('waiting_human','waiting_approval'))) AS attention FROM bots b WHERE b.id=@botId",new {botId});
            evt["bot"]=JsonSerializer.SerializeToNode(Platform.ToDict((object)bot),Json);
        }
        if (conversation != null && (type is "task" or "task.started" or "message" or "error" || type?.StartsWith("message.", StringComparison.Ordinal) == true))
        {
            // Exact message updates (including old reactions) use a single-row projection;
            // task completion/acceptance sends only messages belonging to that task.
            var messages = await conn.QueryAsync("""
                SELECT m.id,m.role,m.content,m.created_at,m.metadata::text AS metadata,m.metadata->>'client_id' AS client_id,
                    m.reply_to_message_id,m.deleted_at,m.kind,COALESCE(m.task_id,t.id) AS request_id,t.status AS task_status
                FROM messages m LEFT JOIN LATERAL (SELECT id,status FROM tasks WHERE id=m.task_id OR source_message_id=m.id ORDER BY created_at DESC LIMIT 1) t ON true
                WHERE m.conversation_id=@conversation AND
                  ((@messageId::uuid IS NOT NULL AND m.id=@messageId) OR (@messageId::uuid IS NULL AND (@taskId::uuid IS NULL OR t.id=@taskId)))
                ORDER BY m.created_at DESC,m.id DESC LIMIT 10
                """,new {conversation,messageId,taskId});
            var rows=new List<Dictionary<string,object?>>();
            foreach (var raw in messages.Reverse())
            {
                var row=Platform.ToDict((object)raw); var id=(Guid)row["id"]!;
                if (row.Remove("metadata",out var meta) && meta is string text)
                {
                    var obj=JsonNode.Parse(text)?.AsObject();
                    foreach(var field in new[]{"parts","skill","attachments","videoAnalysis"}) if(obj?[field] is {} value) row[field]=value.DeepClone();
                }
                row["deleted"]=row["deletedAt"] != null;
                row["reactions"]=(await conn.QueryAsync("SELECT id,actor_type::text AS actor_type,actor_id,emoji,created_at FROM message_reactions WHERE message_id=@id ORDER BY created_at",new {id})).Select(Platform.ToDict).ToArray();
                rows.Add(row);
            }
            evt["messages"]=JsonSerializer.SerializeToNode(rows,Json);
        }
        if ((type == "approval" || taskId != null) && botId != null)
            evt["approvals"]=JsonSerializer.SerializeToNode((await conn.QueryAsync("SELECT id,action,target,reason,status,risk_class,summary FROM approvals WHERE bot_id=@botId AND status='pending'",new {botId})).Select(Platform.ToDict),Json);
        return JsonNode.Parse(Dlp.Redact(evt.ToJsonString()))!.AsObject();
    }
    public static bool Visible(string frame, Guid user)
    {
        try
        {
            var data=string.Join("\n",frame.Split('\n').Where(l=>l.StartsWith("data:",StringComparison.Ordinal)).Select(l=>l[5..].TrimStart()));
            using var doc=JsonDocument.Parse(data);
            return !doc.RootElement.TryGetProperty("ownerId",out var owner) || owner.ValueKind == JsonValueKind.String && owner.TryGetGuid(out var id) && id == user;
        }
        catch (JsonException) { return false; }
    }
}
