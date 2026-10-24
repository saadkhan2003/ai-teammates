using System.Text.Json;
using Dapper;
using Npgsql;

namespace Teammates.Api;

public sealed partial class MemoryStore
{
    // This is an additional guarded writer to memories, not a separate memory store.
    public async Task<Guid?> SaveLearned(NpgsqlConnection c, NpgsqlTransaction tx, ApprovalSignal s, LearnedPreference preference)
    {
        if (!new[] { "preference", "quality_bar", "approved_decision", "avoid" }.Contains(preference.Kind)) return null;
        var text = ApprovalSignals.Clip(preference.Text, 400);
        var source = s.Data.GetProperty("text").GetString() + " " + s.Data.GetProperty("excerpt").GetString();
        // Reject credentials/unsafe policy instructions before and after redaction. No automatic sensitive notes.
        if (MemoryGuard.CheckLearned(preference.Text, source) is not null ||
            MemoryGuard.Check(text, "journal", source, false, false, false, "agent", 400) is not null) return null;
        await c.ExecuteAsync("SELECT id FROM bots WHERE id=@bot AND owner_id=@owner FOR UPDATE", new { bot = s.BotId, owner = s.UserId }, tx);
        if (string.Equals(platform.Configuration["MEMORY_NOTES"] ?? platform.Configuration["Memory:Notes"], "off", StringComparison.OrdinalIgnoreCase)) return null;
        var mode = await c.ExecuteScalarAsync<string?>("SELECT mode FROM bot_memory_settings WHERE bot_id=@bot", new { bot = s.BotId }, tx) ?? "auto";
        if (mode == "off") return null;
        // Including deleted/superseded notes here makes replay idempotent and preserves delete tombstones.
        var already = await c.ExecuteScalarAsync<Guid?>("SELECT id FROM memories WHERE bot_id=@bot AND owner_id=@owner AND @signal=ANY(signal_ids) LIMIT 1", new { bot = s.BotId, owner = s.UserId, signal = s.Id }, tx);
        if (already != null) return already;
        var rows = (await c.QueryAsync<LearnedRow>("""
            SELECT id,content,status,learned_kind AS kind,learned_topic AS topic,source_message_id AS message_id
            FROM memories WHERE bot_id=@bot AND owner_id=@owner AND learned_kind IS NOT NULL
            ORDER BY updated_at DESC LIMIT 300
            """, new { bot = s.BotId, owner = s.UserId }, tx)).ToArray();
        var hash = Hash(text);
        var duplicate = rows.FirstOrDefault(r => Normalize(r.Content) == Normalize(text) || Similarity(Normalize(r.Content), Normalize(text)) >= .92);
        if (duplicate != null && duplicate.Status != "superseded")
        {
            // Never revive a deleted note. Link new confirming signals so replay also stays suppressed.
            await c.ExecuteAsync("UPDATE memories SET signal_ids=array_append(signal_ids,@signal),last_confirmed_at=now(),updated_at=now() WHERE id=@id", new { duplicate.Id, signal = s.Id }, tx);
            return duplicate.Id;
        }
        var correction = s.Kind != "positive";
        var previous = correction ? rows.FirstOrDefault(r => r.Status is "active" or "pending" &&
            (r.Topic == preference.Topic || (s.MessageId != null && r.MessageId == s.MessageId) || Similarity(Normalize(r.Content), Normalize(text)) >= .45)) : null;
        if (previous != null)
        {
            await c.ExecuteAsync("UPDATE memories SET status='superseded',updated_at=now() WHERE id=@id", new { previous.Id }, tx);
            await c.ExecuteAsync("INSERT INTO memory_events(memory_id,bot_id,owner_id,actor,action,detail) VALUES(@id,@bot,@owner,'user','superseded',@detail::jsonb)", new { previous.Id, bot = s.BotId, owner = s.UserId, detail = JsonSerializer.Serialize(new { signalId = s.Id }) }, tx);
        }
        var sourceJson = JsonSerializer.Serialize(new { messageId = s.MessageId, conversationId = s.ConversationId, taskId = s.SourceTaskId,
            excerpt = ApprovalSignals.Clip(s.Data.GetProperty("excerpt").GetString()), signal = s.Signal, text = s.Data.GetProperty("text").GetString() });
        var id = await c.ExecuteScalarAsync<Guid>("""
            INSERT INTO memories(bot_id,owner_id,kind,content,content_hash,visibility,author,status,source,embedding,
                learned_kind,learned_topic,signal_ids,learned_source,source_message_id,source_task_id,supersedes_id,last_confirmed_at)
            VALUES(@bot,@owner,'journal',@text,@hash,'bot','user',@status,'approval_signal',@embedding::vector,
                @kind,@topic,ARRAY[@signal]::uuid[],@source::jsonb,@message,@task,@previous,now()) RETURNING id
            """, new { bot = s.BotId, owner = s.UserId, text, hash, status = mode == "ask" ? "pending" : "active", embedding = Embedder.VectorLiteral(text),
                kind = preference.Kind, topic = preference.Topic, signal = s.Id, source = sourceJson, message = s.MessageId, task = s.SourceTaskId, previous = previous?.Id }, tx);
        await c.ExecuteAsync("INSERT INTO memory_events(memory_id,bot_id,owner_id,actor,action,detail) VALUES(@id,@bot,@owner,'user','learned',@detail::jsonb)", new { id, bot = s.BotId, owner = s.UserId, detail = JsonSerializer.Serialize(new { signalId = s.Id }) }, tx);
        // Keep at most 50 active or pending learned notes. Prefer decisions/quality bars over older generic notes.
        await c.ExecuteAsync("""
            UPDATE memories SET status='superseded',updated_at=now() WHERE id IN (
                SELECT id FROM memories WHERE bot_id=@bot AND owner_id=@owner AND learned_kind IS NOT NULL AND status IN ('active','pending')
                ORDER BY CASE learned_kind WHEN 'quality_bar' THEN 1 WHEN 'approved_decision' THEN 1 ELSE 0 END DESC,updated_at DESC,id
                OFFSET 50)
            """, new { bot = s.BotId, owner = s.UserId }, tx);
        return id;
    }
    private sealed class LearnedRow
    {
        public Guid Id { get; set; } public Guid? MessageId { get; set; }
        public string Content { get; set; } = ""; public string Status { get; set; } = ""; public string Kind { get; set; } = ""; public string Topic { get; set; } = "";
    }
}
