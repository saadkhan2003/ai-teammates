using System.Text.Json;
using System.Text.RegularExpressions;
using Dapper;
using Npgsql;

namespace Teammates.Api;

public sealed class ApprovalSignal
{
    public Guid Id { get; set; } public Guid BotId { get; set; } public Guid UserId { get; set; }
    public Guid? ConversationId { get; set; } public Guid? MessageId { get; set; } public Guid? SourceTaskId { get; set; }
    public string Kind { get; set; } = ""; public string Signal { get; set; } = ""; public string Detail { get; set; } = "{}";
    public JsonElement Data => JsonSerializer.Deserialize<JsonElement>(Detail);
}
public sealed record LearnedPreference(string Kind, string Text, string Topic);

public static class ApprovalSignals
{
    public static string? ReactionKind(string emoji) => emoji.TrimEnd('\ufe0f') switch
    {
        "👍" or "❤" or "🎉" or "🔥" or "👏" or "✅" or "💯" or "😍" => "positive",
        "👎" or "😕" or "😡" => "negative", _ => null
    };
    public static (string Kind, string Signal)? Classify(string text)
    {
        var t = text.Trim();
        if (Regex.IsMatch(t, @"^(?:redo|regenerate|try again|start over)\b", RegexOptions.IgnoreCase)) return ("correction", "redo");
        if (Regex.IsMatch(t, @"^(?:no\b[,.!]?|that['’]s wrong\b|not like that\b|instead\b)", RegexOptions.IgnoreCase)) return ("correction", "reply");
        if (Regex.IsMatch(t, @"^(?:yes|perfect|looks amazing|love it|exactly)(?:[!. ,]|$)", RegexOptions.IgnoreCase)) return ("positive", "reply");
        return null;
    }
    // A caller-provided origin is never accepted by the public routes. All writers are authenticated human handlers.
    public static bool Trusted(Guid actor, Guid owner, string origin) => actor == owner && origin == "owner";
    public static string Clip(string? text, int length = 160)
    {
        var clean = BriefValidator.Clean(MessageParts.PlainText(text ?? ""));
        clean = Regex.Replace(clean, @"\s+", " ").Trim();
        return clean[..Math.Min(length, clean.Length)];
    }
    public static async Task Record(NpgsqlConnection c, NpgsqlTransaction? tx, Guid bot, Guid user,
        Guid? conversation, Guid? message, string kind, string signal, string text, string excerpt, string key, Guid? task = null)
    {
        // Verify tenant, conversation, source role and provenance at the write boundary, not just at the HTTP layer.
        var valid = await c.ExecuteScalarAsync<bool>("""
            SELECT EXISTS(SELECT 1 FROM bots b WHERE b.id=@bot AND b.owner_id=@user
              AND (@conversation::uuid IS NULL OR EXISTS(SELECT 1 FROM conversations v WHERE v.id=@conversation AND v.bot_id=b.id))
              AND (@task::uuid IS NULL OR EXISTS(SELECT 1 FROM tasks st WHERE st.id=@task AND st.bot_id=@bot))
              AND (@message::uuid IS NULL OR EXISTS(SELECT 1 FROM messages m LEFT JOIN tasks t ON t.id=m.task_id
                WHERE m.id=@message AND m.conversation_id=@conversation AND m.role='assistant' AND m.deleted_at IS NULL
                AND m.kind IN ('text','question') AND (t.id IS NULL OR (t.origin_thread_id IS NULL AND t.origin_depth=0 AND t.kind NOT IN ('peer','peer_reply','peer_notice'))))))
            """, new { bot, user, conversation, message, task }, tx);
        if (!valid) return;
        var detail = JsonSerializer.Serialize(new { text = Clip(text, 400), excerpt = Clip(excerpt) });
        await c.ExecuteAsync("""
            INSERT INTO approval_signals(bot_id,user_id,conversation_id,message_id,kind,signal,detail,dedupe_key,source_task_id)
            VALUES(@bot,@user,@conversation,@message,@kind,@signal,@detail::jsonb,@key,@task)
            ON CONFLICT(bot_id,dedupe_key) DO NOTHING
            """, new { bot, user, conversation, message, kind, signal, detail, key, task }, tx);
    }
    public static async Task Reaction(NpgsqlConnection c, NpgsqlTransaction tx, Guid bot, Guid user, Guid conversation, Guid message, string emoji, bool removed)
    {
        var key = "reaction:" + message;
        await c.QueryAsync<Guid>("SELECT id FROM approval_signals WHERE bot_id=@bot AND dedupe_key=@key FOR UPDATE", new { bot, key }, tx);
        // Until leased, replace the pending state and its provisional learned note. Toggle-off leaves no event.
        await c.ExecuteAsync("""
            UPDATE memories SET status='superseded',updated_at=now() WHERE learned_kind IS NOT NULL AND status IN ('active','pending')
              AND signal_ids && ARRAY(SELECT id FROM approval_signals WHERE bot_id=@bot AND dedupe_key=@key AND task_id IS NULL AND consumed_at IS NULL);
            DELETE FROM approval_signals WHERE bot_id=@bot AND dedupe_key=@key AND task_id IS NULL AND consumed_at IS NULL;
            """, new { bot, key }, tx);
        if (removed || ReactionKind(emoji) is not { } kind) return;
        // A consumed/leased state has its own immutable ID; a later reaction is a new state.
        await c.ExecuteAsync("UPDATE approval_signals SET dedupe_key=id::text WHERE bot_id=@bot AND dedupe_key=@key", new { bot, key }, tx);
        var source = await c.QuerySingleAsync<(string Content, Guid? Task)>("SELECT content,task_id FROM messages WHERE id=@message", new { message }, tx);
        await Record(c, tx, bot, user, conversation, message, kind, "reaction", emoji, source.Content, key, source.Task);
    }
    public static async Task UserMessage(NpgsqlConnection c, Guid bot, Guid user, Guid conversation, Guid userMessage, string text, Guid? target = null, string signal = "reply")
    {
        var classification = Classify(text); if (classification is null) return;
        var source = await c.QuerySingleOrDefaultAsync<(Guid Id, string Content, Guid? Task)>("""
            SELECT m.id,m.content,m.task_id FROM messages m WHERE m.conversation_id=@conversation AND m.role='assistant'
            AND m.deleted_at IS NULL AND (@target::uuid IS NULL OR m.id=@target)
            ORDER BY m.created_at DESC,m.id DESC LIMIT 1
            """, new { conversation, target });
        if (source.Id == Guid.Empty) return;
        await Record(c, null, bot, user, conversation, source.Id, classification.Value.Kind,
            classification.Value.Signal == "redo" ? "redo" : signal, text, source.Content, "message:" + userMessage, source.Task);
    }
    public static LearnedPreference Heuristic(ApprovalSignal s)
    {
        var text = s.Data.GetProperty("text").GetString() ?? "";
        var excerpt = s.Data.GetProperty("excerpt").GetString() ?? "";
        var shorter = Regex.IsMatch(text, @"\b(shorter|concise|brief|length|long|verbose)\b", RegexOptions.IgnoreCase);
        var topic = shorter ? "response_length" : s.Signal == "approval" || s.Signal == "pick" ? "decision:" + MemoryStore.Hash(excerpt)[..16] : "result:" + MemoryStore.Hash(excerpt)[..16];
        if (s.Kind != "positive") return new("avoid", shorter ? "Avoid long replies; the user asked for shorter responses." : "Avoid repeating this approach: " + Clip(text, 280), topic);
        if (s.Signal is "approval" or "pick") return new("approved_decision", "The user chose: " + Clip(text, 180) + ". Context: " + Clip(excerpt, 120), topic);
        return new("quality_bar", "The user approved this result: " + Clip(excerpt, 280), topic);
    }
    public static async Task<int> LearnPending(Platform p, Func<ApprovalSignal, CancellationToken, Task<LearnedPreference?>>? extract = null, CancellationToken ct = default, Guid? bot = null)
    {
        var count = 0;
        // Bounded batches, one quick request per signal, no task/compute creation.
        for (var i = 0; i < 16 && !ct.IsCancellationRequested; i++)
        {
            await using var c = await p.Data.OpenConnectionAsync(ct); await using var tx = await c.BeginTransactionAsync(ct);
            var s = await c.QuerySingleOrDefaultAsync<ApprovalSignal>("""
                SELECT *,detail::text AS detail FROM approval_signals WHERE learned_at IS NULL AND (@bot::uuid IS NULL OR bot_id=@bot)
                AND created_at < now()-interval '2 seconds' ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
                """, new { bot }, tx);
            if (s is null) break;
            LearnedPreference? note = null;
            if (extract != null)
            {
                try { using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromSeconds(3));
                    note = await extract(s, timeout.Token).WaitAsync(timeout.Token); }
                catch (Exception) when (!ct.IsCancellationRequested) { /* deterministic fallback, never log provider/source text */ }
            }
            note ??= Heuristic(s);
            await new MemoryStore(p).SaveLearned(c, tx, s, note);
            await c.ExecuteAsync("UPDATE approval_signals SET learned_at=now() WHERE id=@id", new { s.Id }, tx);
            await tx.CommitAsync(ct); count++;
        }
        return count;
    }
    public static async Task<string> Context(NpgsqlConnection c, Guid bot, string query, NpgsqlTransaction? tx = null)
    {
        var rows = await c.QueryAsync<(string Kind, string Content)>("""
            SELECT m.learned_kind AS kind,m.content FROM memories m JOIN bots b ON b.id=m.bot_id AND b.owner_id=m.owner_id
            WHERE m.bot_id=@bot AND m.learned_kind IS NOT NULL AND m.status='active' AND m.deleted_at IS NULL AND m.visibility='bot' AND NOT m.sensitive
            AND NOT EXISTS(SELECT 1 FROM bot_memory_settings WHERE bot_id=@bot AND mode='off')
            ORDER BY ts_rank(to_tsvector('english',m.content),plainto_tsquery('english',@query)) DESC,m.updated_at DESC LIMIT 12
            """, new { bot, query }, tx);
        return BriefStore.BoundedContext(rows.Select(r => (r.Kind switch { "quality_bar" => "Quality bar", "avoid" => "Avoid", "approved_decision" => "Decision", _ => "Preference" }) + ": " + r.Content), 1200);
    }
}

public sealed class ApprovalLearningWorker(Platform platform, Runtime runtime, ILogger<ApprovalLearningWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await ApprovalSignals.LearnPending(platform, runtime.ExtractPreference, stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception) { logger.LogWarning("Approval learning batch deferred"); }
            try { await Task.Delay(1000, stoppingToken); } catch (OperationCanceledException) { break; }
        }
    }
}
