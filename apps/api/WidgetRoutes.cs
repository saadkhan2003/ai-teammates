using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using Dapper;
using Npgsql;

namespace Teammates.Api;

public static class WidgetRoutes
{
    private static readonly ConcurrentDictionary<Guid, Queue<DateTimeOffset>> Limits = new();
    public static void Map(WebApplication app, Platform platform)
    {
        app.MapPost("/api/bots/{id:guid}/widget-actions", async (HttpContext ctx, Guid id, JsonElement body, CancellationToken ct) =>
        {
            var owner = await Routes.RequireUser(ctx, platform);
            if (owner == null) return Results.Unauthorized();
            var origin = ctx.Request.Headers.Origin.ToString();
            if (origin.Length > 0 && (!Uri.TryCreate(origin, UriKind.Absolute, out var parsed) || !string.Equals(parsed.Authority, ctx.Request.Host.Value, StringComparison.OrdinalIgnoreCase))) return Results.StatusCode(403);
            var q = Limits.GetOrAdd(owner.Value, _ => new Queue<DateTimeOffset>());
            lock (q) { var cutoff = DateTimeOffset.UtcNow.AddMinutes(-1); while (q.TryPeek(out var t) && t < cutoff) q.Dequeue(); if (q.Count >= 30) return Results.StatusCode(429); q.Enqueue(DateTimeOffset.UtcNow); }
            if (!body.TryGetProperty("widget_id", out var wid) || wid.ValueKind != JsonValueKind.String || !body.TryGetProperty("action", out var action) || action.ValueKind != JsonValueKind.String || !body.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object) return Results.BadRequest(new { error = "invalid_widget_action" });
            var widgetId = wid.GetString()!; var actionName = action.GetString()!;
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var bot = await conn.QuerySingleOrDefaultAsync<(Guid ConversationId, string Name)>("SELECT c.id, b.name FROM bots b JOIN conversations c ON c.bot_id=b.id WHERE b.id=@id AND b.owner_id=@owner", new { id, owner });
            if (bot.ConversationId == Guid.Empty) return Results.NotFound();
            var stored = await conn.QuerySingleOrDefaultAsync<string>("SELECT part->'widget' AS widget FROM messages m CROSS JOIN LATERAL jsonb_array_elements(m.metadata->'parts') part WHERE m.conversation_id=@conversation AND part->>'type'='widget' AND part->'widget'->>'id'=@widgetId ORDER BY m.created_at DESC LIMIT 1", new { conversation = bot.ConversationId, widgetId });
            if (stored == null) return Results.NotFound();
            using var doc = JsonDocument.Parse(stored);
            var widget = doc.RootElement;
            if (WidgetSchema.Validate(widget) is { } invalid) return Results.BadRequest(new { error = invalid });
            JsonElement selected = default;
            if (widget.TryGetProperty("actions", out var actions) && actions.ValueKind == JsonValueKind.Array) selected = actions.EnumerateArray().FirstOrDefault(a => a.TryGetProperty("action", out var v) && v.GetString() == actionName);
            if (widget.TryGetProperty("submit", out var submit) && submit.TryGetProperty("action", out var submitAction) && submitAction.GetString() == actionName) selected = submit;
            if (selected.ValueKind != JsonValueKind.Object) return Results.BadRequest(new { error = "action_not_in_widget" });
            var requiresApproval = selected.TryGetProperty("requires_approval", out var approvalFlag) && approvalFlag.ValueKind == JsonValueKind.True;
            var content = "Widget action: " + actionName + "\nPayload: " + Dlp.Redact(payload.GetRawText());
            var message = await conn.ExecuteScalarAsync<Guid>("INSERT INTO messages(conversation_id,role,content) VALUES(@conversation,'user',@content) RETURNING id", new { conversation = bot.ConversationId, content });
            var instruction = "The user submitted an action in an interactive chat widget. Perform the requested action only after following the normal safety and approval rules. Action: " + actionName + "\nPayload: " + Dlp.Redact(payload.GetRawText());
            var task = await conn.ExecuteScalarAsync<Guid>("INSERT INTO tasks(bot_id,conversation_id,title,instruction,kind,priority,status,waiting_reason,source_message_id) VALUES(@id,@conversation,@title,@instruction,'chat',10,@status,@reason,@message) RETURNING id", new { id, conversation = bot.ConversationId, title = "Widget action: " + actionName, instruction, status = requiresApproval ? "waiting_approval" : "queued", reason = requiresApproval ? "widget_action_approval" : null, message });
            Guid? approvalId = null;
            if (requiresApproval)
            {
                approvalId = await conn.ExecuteScalarAsync<Guid>("INSERT INTO approvals(bot_id,task_id,action,target,proposed,reason,evidence,risk_class,summary) VALUES(@id,@task,'widget_action',@target,@proposed::jsonb,'A widget action requires your approval.','',@risk,@summary) RETURNING id", new { id, task, target = actionName, proposed = payload.GetRawText(), risk = ActionClasses.BotManage, summary = "Approve widget action: " + actionName });
                await platform.Notify(owner.Value, "approval", "Approval needed", "Widget action: " + actionName);
            }
            await platform.Audit(owner.Value.ToString(), "widget.action_requested", id, task, new { widgetId, action = actionName, requiresApproval });
            await platform.Publish(new { type = "task", taskId = task, status = requiresApproval ? "waiting_approval" : "queued" });
            if (!requiresApproval) platform.Tasks.Pulse();
            return Results.Json(new { messageId = message, taskId = task, approvalId, status = requiresApproval ? "waiting_approval" : "queued" });
        });
    }

    public static async Task<object> SendFromBot(Platform platform, Guid botId, Guid taskId, JsonElement args, CancellationToken ct)
    {
        if (!args.TryGetProperty("widget", out var widget)) throw new InvalidOperationException("send_widget requires widget");
        if (WidgetSchema.Validate(widget) is { } invalid) throw new InvalidOperationException(invalid);
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var conversation = await conn.ExecuteScalarAsync<Guid?>("SELECT conversation_id FROM tasks WHERE id=@task AND bot_id=@bot", new { task = taskId, bot = botId });
        if (conversation == null) throw new InvalidOperationException("task conversation unavailable");
        var text = widget.TryGetProperty("title", out var title) ? title.GetString() ?? "" : "";
        var metadata = JsonSerializer.Serialize(new { parts = new[] { new { type = "widget", widget = JsonSerializer.Deserialize<object>(widget.GetRawText()) } } });
        var messageId = await conn.ExecuteScalarAsync<Guid>("INSERT INTO messages(conversation_id,role,content,metadata,task_id) VALUES(@conversation,'assistant',@text,@metadata::jsonb,@task) RETURNING id", new { conversation, text, metadata, task = taskId });
        await platform.Publish(new { type = "message", botId, taskId, messageId });
        return new { messageId, widgetId = widget.GetProperty("id").GetString() };
    }
}
