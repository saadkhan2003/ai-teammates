using System.Text.Json;
using Dapper;
using Npgsql;

namespace Teammates.Api;

public static class ReactionRules
{
    public static bool BotMayReact(string? messageRole) =>
        string.Equals(messageRole, "user", StringComparison.Ordinal);
}

public static class Reactions
{
    public static async Task<IResult> Post(HttpContext ctx, Platform platform, Guid messageId, JsonElement body)
    {
        var user = await User(ctx, platform);
        if (user == null) return Results.Unauthorized();
        var emoji = body.TryGetProperty("emoji", out var emojiEl) ? emojiEl.GetString() : null;
        var outcome = await Mutate(platform, "user", user.Value, messageId, emoji, removeOnly: false);
        return ToResult(outcome);
    }

    public static async Task<IResult> Delete(HttpContext ctx, Platform platform, Guid messageId)
    {
        var user = await User(ctx, platform);
        if (user == null) return Results.Unauthorized();
        var outcome = await Mutate(platform, "user", user.Value, messageId, null, removeOnly: true);
        if (outcome.Status is 200 or 204) return Results.NoContent();
        return ToResult(outcome);
    }

    public static async Task<object> BotTool(Platform platform, Guid botId, string messageId, string emoji)
    {
        if (!Guid.TryParse(messageId, out var id))
            return new { ok = false, reason = "message_not_found" };
        var outcome = await Mutate(platform, "bot", botId, id, emoji, removeOnly: false);
        if (outcome.Status != 200)
            return new { ok = false, reason = outcome.Error ?? "denied" };
        return new { ok = true, action = outcome.Action };
    }

    private static IResult ToResult(Outcome outcome)
    {
        if (outcome.Status == 204) return Results.NoContent();
        if (outcome.Status != 200)
            return Results.Json(new { error = outcome.Error }, statusCode: outcome.Status);
        return Results.Json(new { action = outcome.Action, reaction = outcome.Reaction });
    }

    private static async Task<Guid?> User(HttpContext ctx, Platform platform)
    {
        var header = ctx.Request.Cookies["teammates_session"];
        return await platform.UserForSession(header);
    }

    private static async Task<Outcome> Mutate(Platform platform, string actorType, Guid actorId, Guid messageId, string? emoji, bool removeOnly)
    {
        if (!removeOnly && !EmojiRules.IsSingleEmoji(emoji))
            return Outcome.Fail(400, "invalid_emoji");
        await using var conn = await platform.Data.OpenConnectionAsync();
        await using var tx = await conn.BeginTransactionAsync();
        var message = await conn.QuerySingleOrDefaultAsync<MessageRow>(
            """
            SELECT m.id, m.conversation_id, m.role, c.bot_id, b.owner_id
            FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            JOIN bots b ON b.id = c.bot_id
            WHERE m.id = @id
            FOR UPDATE OF m
            """,
            new { id = messageId }, tx);
        if (message == null) return Outcome.Fail(404, "message_not_found");
        var participant = actorType == "user" ? actorId == message.OwnerId : actorId == message.BotId;
        if (!participant) return Outcome.Fail(403, "not_participant");
        if (actorType == "bot" && !ReactionRules.BotMayReact(message.Role)) return Outcome.Fail(400, "not_user_message");

        var existing = await conn.QuerySingleOrDefaultAsync<ReactionRow>(
            """
            SELECT id, message_id, actor_type::text AS actor_type, actor_id, emoji, created_at
            FROM message_reactions
            WHERE message_id = @id AND actor_type = @actor::reaction_actor AND actor_id = @actorId
            FOR UPDATE
            """,
            new { id = messageId, actor = actorType, actorId }, tx);

        var events = new List<object>();
        string action;
        object? reaction;
        if (removeOnly || (existing != null && existing.Emoji == emoji))
        {
            if (existing == null)
            {
                await tx.CommitAsync();
                return new Outcome(204, null, "removed", null);
            }
            await conn.ExecuteAsync("DELETE FROM message_reactions WHERE id=@id", new { id = existing.Id }, tx);
            action = "removed";
            reaction = Shape(existing);
            events.Add(await Emit(conn, tx, message.ConversationId, "message.reaction.removed", existing));
            if (actorType == "user" && message.Role == "assistant")
                await Feedback(conn, tx, message.BotId, actorId, message.ConversationId, message.Id, existing.Emoji, "removed");
        }
        else if (existing == null)
        {
            var created = await conn.QuerySingleAsync<ReactionRow>(
                """
                INSERT INTO message_reactions (message_id, actor_type, actor_id, emoji)
                VALUES (@id, @actor::reaction_actor, @actorId, @emoji)
                RETURNING id, message_id, actor_type::text AS actor_type, actor_id, emoji, created_at
                """,
                new { id = messageId, actor = actorType, actorId, emoji }, tx);
            action = "added";
            reaction = Shape(created);
            events.Add(await Emit(conn, tx, message.ConversationId, "message.reaction.added", created));
            if (actorType == "user" && message.Role == "assistant")
                await Feedback(conn, tx, message.BotId, actorId, message.ConversationId, message.Id, created.Emoji, "reacted");
        }
        else
        {
            events.Add(await Emit(conn, tx, message.ConversationId, "message.reaction.removed", existing));
            var created = await conn.QuerySingleAsync<ReactionRow>(
                """
                UPDATE message_reactions SET emoji=@emoji, created_at=now() WHERE id=@id
                RETURNING id, message_id, actor_type::text AS actor_type, actor_id, emoji, created_at
                """,
                new { id = existing.Id, emoji }, tx);
            action = "replaced";
            reaction = Shape(created);
            events.Add(await Emit(conn, tx, message.ConversationId, "message.reaction.added", created));
            if (actorType == "user" && message.Role == "assistant")
                await Feedback(conn, tx, message.BotId, actorId, message.ConversationId, message.Id, created.Emoji, "reacted");
        }
        await tx.CommitAsync();
        foreach (var evt in events) await platform.Publish(evt);
        return new Outcome(200, null, action, reaction);
    }

    private static async Task Feedback(NpgsqlConnection conn, NpgsqlTransaction tx, Guid botId, Guid userId, Guid conversationId, Guid messageId, string emoji, string action)
    {
        await ApprovalSignals.Reaction(conn, tx, botId, userId, conversationId, messageId, emoji, action == "removed");
    }

    private static async Task<object> Emit(NpgsqlConnection conn, NpgsqlTransaction tx, Guid conversationId, string type, ReactionRow row)
    {
        var seq = await conn.ExecuteScalarAsync<long>("UPDATE conversations SET event_seq = event_seq + 1 WHERE id=@id RETURNING event_seq", new { id = conversationId }, tx);
        return new
        {
            seq,
            type,
            messageId = row.MessageId,
            actorType = row.ActorType,
            actorId = row.ActorId,
            emoji = row.Emoji,
            createdAt = DateTime.SpecifyKind(row.CreatedAt, DateTimeKind.Utc)
        };
    }

    private static object Shape(ReactionRow row) => new
    {
        id = row.Id,
        messageId = row.MessageId,
        actorType = row.ActorType,
        actorId = row.ActorId,
        emoji = row.Emoji,
        createdAt = DateTime.SpecifyKind(row.CreatedAt, DateTimeKind.Utc)
    };

    private sealed class MessageRow
    {
        public Guid Id { get; set; }
        public Guid ConversationId { get; set; }
        public string Role { get; set; } = "";
        public Guid BotId { get; set; }
        public Guid OwnerId { get; set; }
    }

    private sealed class ReactionRow
    {
        public Guid Id { get; set; }
        public Guid MessageId { get; set; }
        public string ActorType { get; set; } = "";
        public Guid ActorId { get; set; }
        public string Emoji { get; set; } = "";
        public DateTime CreatedAt { get; set; }
    }

    private sealed record Outcome(int Status, string? Error, string? Action, object? Reaction)
    {
        public static Outcome Fail(int status, string error) => new(status, error, null, null);
    }
}
