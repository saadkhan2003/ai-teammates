using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Collections.Concurrent;
using Dapper;
using Npgsql;

namespace Teammates.Api;

public static class MemoryWriteLimits
{
    private sealed class Bucket { public readonly object Gate = new(); public readonly Queue<DateTimeOffset> Hits = new(); }
    private static readonly ConcurrentDictionary<Guid, Bucket> Buckets = new();

    public static bool Allow(Guid user, int limit = 60)
    {
        var bucket = Buckets.GetOrAdd(user, _ => new Bucket());
        lock (bucket.Gate)
        {
            var now = DateTimeOffset.UtcNow;
            while (bucket.Hits.TryPeek(out var oldest) && now - oldest >= TimeSpan.FromMinutes(1)) bucket.Hits.Dequeue();
            if (bucket.Hits.Count >= limit) return false;
            bucket.Hits.Enqueue(now);
            return true;
        }
    }
}

public static class MemoryGuard
{
    private static readonly Regex Otp = new(@"(?:otp|one[- ]time|verification|2fa|recovery|backup)\s*(?:code)?\s*(?:is|:|=)?\s*[A-Z0-9-]{4,10}", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex Credential = new(@"\b(password|passcode|pin|passphrase|api key|token|secret|private key)\s*(is|:|=)\s*\S+", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex Token = new(@"(?:eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}|\bsk_live_[A-Za-z0-9]{12,}|\bBearer\s+[A-Za-z0-9._~+/-]{12,})", RegexOptions.Compiled);
    private static readonly Regex Email = new(@"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex Phone = new(@"(?<!\w)(?<!ticket )(?<!ticket #)(?<!issue )(?<!case )(?<!version )(?<!build )(?<!id )(?:\+\d[\d ()-]{8,}\d|(?:\d[ ()-]?){10,})(?!\w)", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex GuidText = new(@"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex Address = new(@"\b\d{1,6}\s+[\w.'-]+(?:\s+[\w.'-]+){0,4}\s+(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr|court|ct)\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex Imperative = new(@"\b(when you see|whenever|if .* then|send .* to|forward .* to|email .* to)\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex UnsafeRule = new(@"\b(?:never ask for approval|don't ask for approval|do not ask for approval|skip (?:all )?approvals?|always allow shell|disable (?:the )?(?:policygate|policy gate|dlp)|ignore (?:all )?(?:previous|prior) instructions?|reveal (?:the )?(?:secret|password|token|key)s?|grant (?:yourself )?(?:permission|permissions|access)|bypass (?:the )?(?:approval|policy|security))\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex Word = new(@"[\p{L}\p{N}]{2,}", RegexOptions.Compiled);
    private static readonly Regex DateAnchor = new(@"^as of \d{4}-\d{2}-\d{2},?\s*", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly HashSet<string> Stop = new(StringComparer.OrdinalIgnoreCase) { "the", "and", "for", "with", "that", "this", "from", "into", "are", "was", "were", "have", "has", "had", "you", "your", "about", "after", "before", "not", "but", "its", "their", "they", "them", "user", "prefers", "prefer" };

    public static string? Check(string content, string kind, string userText, bool explicitRequest, bool peer, bool routine, string author, int maxChars)
    {
        if (string.IsNullOrWhiteSpace(content)) return "empty";
        if (content.Length > maxChars) return "too_long";
        if (Dlp.HasStrict(content) || content.Contains("secret://", StringComparison.OrdinalIgnoreCase) || Credential.IsMatch(content) || Token.IsMatch(content) || HighEntropy(content)) return "credential_shaped";
        if (Otp.IsMatch(content)) return "otp_shaped";
        if (kind == "rule" && UnsafeRule.IsMatch(content)) return "unsafe_rule";
        if (Email.IsMatch(content) || HasPhone(content) || Address.IsMatch(content) || Regex.IsMatch(content, @"\b(?:date of birth|born on|dob)\s*(?:is|:)?\s*\d", RegexOptions.IgnoreCase)) return "use_vault";
        if (Dlp.IsHealthOrFinance(content) && !explicitRequest) return "sensitive_requires_explicit";
        if (peer && kind != "journal") return "peer_limited";
        if (routine && (kind != "journal" || author != "routine")) return "routine_limited";
        if ((peer || routine) && (kind == "profile" || kind == "rule" || kind == "fact")) return "origin_limited";
        if (Imperative.IsMatch(content) && !(kind == "rule" && explicitRequest)) return "injection_shaped";
        if (InjectionFilter.Strip(content) != content) return "injection_shaped";
        if (kind is "profile" or "rule" or "fact" && !explicitRequest && !Grounded(content, userText)) return "not_grounded";
        return null;
    }

    public static bool Grounded(string note, string source)
    {
        var words = Words(DateAnchor.Replace(note, ""));
        if (words.Count == 0) return false;
        var sourceWords = Words(source);
        return words.Count(word => sourceWords.Contains(word)) / (double)words.Count >= 0.60;
    }

    private static HashSet<string> Words(string text) => Word.Matches(text.ToLowerInvariant()).Select(m => m.Value).Where(w => !Stop.Contains(w) && !int.TryParse(w, out _)).ToHashSet(StringComparer.OrdinalIgnoreCase);

    private static bool HighEntropy(string text)
    {
        foreach (Match match in Regex.Matches(text, @"(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])"))
        {
            var value = match.Value;
            if (Guid.TryParse(value, out _) || Regex.IsMatch(value, "^[a-fA-F0-9]{40,64}$")) continue;
            var counts = value.GroupBy(c => c).Select(g => g.Count() / (double)value.Length);
            var entropy = -counts.Sum(p => p * Math.Log2(p));
            if (entropy >= 3.5) return true;
        }
        return false;
    }

    private static bool HasPhone(string text)
    {
        var guids = GuidText.Matches(text);
        return Phone.Matches(text).Any(phone => !guids.Any(guid => phone.Index >= guid.Index && phone.Index + phone.Length <= guid.Index + guid.Length));
    }
}

public sealed class MemoryStore(Platform platform)
{
    public static string Normalize(string content)
    {
        var value = Regex.Replace(content.Trim().ToLowerInvariant(), @"^as of \d{4}-\d{2}-\d{2},?\s*", "", RegexOptions.IgnoreCase);
        value = Regex.Replace(value, @"\s+", " ").Trim();
        return value.TrimEnd('.', '!', '?', ';', ':');
    }

    public static string Hash(string content) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Normalize(content)))).ToLowerInvariant();

    public async Task<object> Save(Guid botId, Guid ownerId, Guid? taskId, string content, string kind = "profile", string actor = "agent", string visibility = "", string userText = "", bool explicitRequest = false, bool peer = false, bool routine = false, int? maxChars = null, Guid? supersedesId = null, bool notice = true, Guid? conversationId = null)
    {
        var cfg = platform.Configuration;
        if (!new[] { "profile", "journal", "rule", "fact", "summary" }.Contains(kind)) return new { saved = false, reason = "invalid_kind" };
        var max = maxChars ?? (actor == "user" ? GetInt(cfg["Memory:UserMaxChars"], 1000) : GetInt(cfg["Memory:AgentMaxChars"], 400));
        var reason = MemoryGuard.Check(content, kind, userText, explicitRequest, peer, routine, actor, max);
        if (reason != null)
        {
            await platform.Audit("memory", "memory.blocked", botId, taskId, new { reason, kind });
            return new { saved = false, reason };
        }
        if (kind == "rule") visibility = "bot";
        if (Dlp.IsHealthOrFinance(content)) visibility = "bot";
        var hash = Hash(content);
        var emb = Embedder.VectorLiteral(content);
        await using var conn = await platform.Data.OpenConnectionAsync();
        await using var tx = await conn.BeginTransactionAsync();
        var settings = await conn.QuerySingleOrDefaultAsync<(string Mode, bool ShareOwner)>("SELECT mode, share_owner FROM bot_memory_settings WHERE bot_id=@bot", new { bot = botId }, tx);
        if (settings.Mode == null) settings = ("auto", true);
        if (settings.Mode == "off" || string.Equals(cfg["MEMORY_NOTES"] ?? cfg["Memory:Notes"], "off", StringComparison.OrdinalIgnoreCase)) return new { saved = false, reason = "memory_off" };
        if (string.IsNullOrWhiteSpace(visibility)) visibility = kind == "profile" && settings.ShareOwner ? "owner" : "bot";
        if (visibility == "owner" && (kind != "profile" || !settings.ShareOwner)) visibility = "bot";
        var duplicate = await conn.QuerySingleOrDefaultAsync<(Guid Id, string Content)>("SELECT id, content FROM memories WHERE bot_id=@bot AND kind=@kind AND content_hash=@hash AND status IN ('active','pending')", new { bot = botId, kind, hash }, tx);
        if (duplicate.Id != Guid.Empty)
        {
            await conn.ExecuteAsync("UPDATE memories SET last_confirmed_at=now() WHERE id=@id", new { id = duplicate.Id }, tx);
            await tx.CommitAsync();
            return new { id = duplicate.Id, saved = false, duplicate = true };
        }
        if (kind != "rule")
        {
            var nearest = (await conn.QueryAsync<(Guid Id, string Content)>("SELECT id,content FROM memories WHERE bot_id=@bot AND owner_id=@owner AND kind=@kind AND status IN ('active','pending') AND content IS NOT NULL ORDER BY updated_at DESC LIMIT 50", new { bot = botId, owner = ownerId, kind }, tx))
                .Select(item => new { item.Id, Score = Similarity(Normalize(content), Normalize(item.Content)) })
                .FirstOrDefault(item => item.Score >= 0.92);
            if (nearest != null)
            {
                await conn.ExecuteAsync("UPDATE memories SET last_confirmed_at=now() WHERE id=@id", new { id = nearest.Id }, tx);
                await tx.CommitAsync();
                return new { id = nearest.Id, saved = false, duplicate = true };
            }
        }
        if (taskId is { } rateTask)
        {
            var taskWrites = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM memories WHERE source_task_id=@task AND status IN ('active','pending','superseded')", new { task = rateTask }, tx);
            if ((routine && taskWrites >= 1) || taskWrites >= GetInt(cfg["Memory:PerTask"], 5)) return new { saved = false, reason = "rate_limited" };
            if (peer)
            {
                var threadWrites = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM memories m JOIN tasks t ON t.id=m.source_task_id WHERE t.origin_thread_id=(SELECT origin_thread_id FROM tasks WHERE id=@task) AND m.author='peer' AND m.status IN ('active','pending')", new { task = rateTask }, tx);
                if (threadWrites >= 3) return new { saved = false, reason = "rate_limited" };
            }
        }
        var caps = await conn.QuerySingleAsync<(int Count, int Hour, int Day, int Rules)>("SELECT count(*) FILTER (WHERE status IN ('active','pending'))::int, count(*) FILTER (WHERE created_at>now()-interval '1 hour')::int, count(*) FILTER (WHERE created_at>now()-interval '1 day')::int, count(*) FILTER (WHERE kind='rule' AND status IN ('active','pending'))::int FROM memories WHERE bot_id=@bot", new { bot = botId }, tx);
        if (caps.Hour >= GetInt(cfg["Memory:PerBotPerHour"], 30) || caps.Day >= GetInt(cfg["Memory:PerBotPerDay"], 100)) return new { saved = false, reason = "rate_limited" };
        if (caps.Count >= GetInt(cfg["Memory:PerBotMax"], 500))
        {
            var evictedId = await conn.ExecuteScalarAsync<Guid?>("UPDATE memories SET status='deleted', deleted_at=now() WHERE id=(SELECT id FROM memories WHERE bot_id=@bot AND status='active' AND kind='journal' AND author='agent' AND NOT pinned ORDER BY updated_at LIMIT 1) RETURNING id", new { bot = botId }, tx);
            if (evictedId == null) return new { saved = false, reason = "notes_full" };
            await Event(conn, tx, evictedId.Value, botId, ownerId, "system", "evict", taskId, null, null, null);
        }
        if (kind == "rule")
        {
            var priorRules = await conn.QueryAsync<(Guid Id, string Content)>("SELECT id, content FROM memories WHERE bot_id=@bot AND owner_id=@owner AND kind='rule' AND status='active' ORDER BY created_at DESC LIMIT 20", new { bot = botId, owner = ownerId }, tx);
            var norm = Normalize(content);
            foreach (var rule in priorRules)
            {
                if (Normalize(rule.Content) == norm || Similarity(norm, Normalize(rule.Content)) >= 0.72)
                {
                    supersedesId ??= rule.Id;
                    break;
                }
            }
            if (supersedesId == null && caps.Rules >= GetInt(cfg["Memory:RuleMax"], 20)) return new { saved = false, reason = "notes_full" };
        }
        var status = settings.Mode == "ask" && !explicitRequest ? "pending" : "active";
        var source = await conn.QuerySingleOrDefaultAsync<(Guid? Message, bool Exists)>("SELECT source_message_id, true FROM tasks WHERE id=@task", new { task = taskId }, tx);
        var previousContent = supersedesId is { } previousId
            ? await conn.ExecuteScalarAsync<string?>("SELECT content FROM memories WHERE id=@id AND bot_id=@bot AND owner_id=@owner AND status='active'", new { id = previousId, bot = botId, owner = ownerId }, tx)
            : null;
        var similar = kind == "rule" ? Array.Empty<object>() : (await conn.QueryAsync<(Guid Id, string Content)>("SELECT id,content FROM memories WHERE bot_id=@bot AND owner_id=@owner AND kind=@kind AND status='active' AND content IS NOT NULL ORDER BY updated_at DESC LIMIT 50", new { bot = botId, owner = ownerId, kind }, tx))
            .Select(item => new { item.Id, item.Content, Score = Similarity(Normalize(content), Normalize(item.Content)) })
            .Where(item => item.Score >= 0.80 && item.Score < 0.92)
            .Take(5).Select(item => (object)new { id = item.Id, text = item.Content }).ToArray();
        var id = await conn.ExecuteScalarAsync<Guid>("""
            INSERT INTO memories (bot_id, owner_id, content, source, importance, embedding, kind, visibility, conversation_id, status, author, sensitive, content_hash, supersedes_id, source_message_id, source_task_id, last_confirmed_at, effective_at)
            VALUES (@bot,@owner,@content,@actor,@importance,@emb::vector,@kind,@visibility,@conversation,@status,@actor,@sensitive,@hash,@supersedes,@message,@task,now(),current_date) RETURNING id
            """, new { bot = botId, owner = ownerId, content, actor, importance = 0.6, emb, kind, visibility, conversation = conversationId, status, sensitive = Dlp.IsHealthOrFinance(content), hash, supersedes = supersedesId, message = source.Message, task = taskId }, tx);
        if (supersedesId is { } previous)
        {
            await conn.ExecuteAsync("UPDATE memories SET status='superseded', updated_at=now() WHERE id=@id AND bot_id=@bot AND owner_id=@owner AND kind=@kind AND status='active'", new { id = previous, bot = botId, owner = ownerId, kind }, tx);
            await Event(conn, tx, previous, botId, ownerId, actor, "superseded", taskId, null, hash, null);
        }
        await Event(conn, tx, id, botId, ownerId, actor, supersedesId == null ? "create" : "update", taskId, null, hash, 1);
        await tx.CommitAsync();
        if (notice && taskId is { } task) await Notice(botId, task, supersedesId == null ? (status == "pending" ? "suggested" : "saved") : "updated", id, kind, content, previousContent);
        return new { id, saved = true, status, similar };
    }

    public async Task<object> Forget(Guid botId, Guid owner, Guid taskId, Guid id)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        var row = await conn.QuerySingleOrDefaultAsync<(string Content, string Kind, string Hash)>("UPDATE memories SET status='deleted', deleted_at=now() WHERE id=@id AND bot_id=@bot AND owner_id=@owner AND status='active' RETURNING content, kind, content_hash", new { id, bot = botId, owner });
        if (row.Content == null) return new { ok = false, reason = "not_found" };
        await conn.ExecuteAsync("INSERT INTO memory_events(memory_id,bot_id,owner_id,actor,action,task_id,before_hash) VALUES(@id,@bot,@owner,'agent','delete',@task,@hash)", new { id, bot = botId, owner, task = taskId, hash = row.Hash });
        await platform.Audit("memory", "memory.deleted", botId, taskId, new { id, kind = row.Kind, hash = row.Hash });
        await Notice(botId, taskId, "forgot", id, row.Kind, row.Content);
        return new { ok = true, forgotten = true, id, undoUntil = DateTimeOffset.UtcNow.AddMinutes(10) };
    }

    public async Task<object> ForgetText(Guid botId, Guid owner, Guid taskId, string query)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        var rows = (await conn.QueryAsync<(Guid Id, string Content)>("""
            SELECT id, content FROM memories WHERE bot_id=@bot AND owner_id=@owner AND status='active'
              AND content IS NOT NULL AND (content ILIKE @contains OR to_tsvector('english',content) @@ plainto_tsquery('english',@query))
            ORDER BY (content ILIKE @contains) DESC, updated_at DESC LIMIT 4
            """, new { bot = botId, owner, query, contains = "%" + query + "%" })).ToArray();
        if (rows.Length == 0) return new { ok = false, reason = "not_found" };
        if (rows.Length > 1) return new { ok = false, reason = "ambiguous", candidates = rows.Select(x => new { id = x.Id, text = x.Content }).ToArray() };
        return await Forget(botId, owner, taskId, rows[0].Id);
    }

    public async Task<object> Update(Guid botId, Guid owner, Guid taskId, Guid id, string content, string userText = "", bool explicitRequest = false, string actor = "agent")
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        var row = await conn.QuerySingleOrDefaultAsync<(string Kind, string Visibility, string Status, Guid? ConversationId)>("SELECT kind, visibility, status, conversation_id FROM memories WHERE id=@id AND bot_id=@bot AND owner_id=@owner", new { id, bot = botId, owner });
        if (row.Kind == null || row.Status != "active") return new { saved = false, reason = "not_found" };
        return await Save(botId, owner, taskId, content, row.Kind, actor, row.Visibility, userText, explicitRequest, supersedesId: id, conversationId: row.ConversationId);
    }

    public async Task<object> Search(Guid botId, Guid owner, string query, int limit = 8, string? kind = null, bool peer = false, Guid? conversationId = null)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        if (string.Equals(platform.Configuration["MEMORY_NOTES"] ?? platform.Configuration["Memory:Notes"] ?? "shadow", "off", StringComparison.OrdinalIgnoreCase))
            return new { matches = Array.Empty<object>() };
        if (await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM bot_memory_settings WHERE bot_id=@bot AND mode='off'", new { bot = botId }) > 0)
            return new { matches = Array.Empty<object>() };
        var rows = (await conn.QueryAsync("""
            SELECT id, content, kind, created_at AS date, visibility, author FROM memories
            WHERE owner_id=@owner AND (bot_id=@bot OR visibility='owner') AND status='active' AND deleted_at IS NULL
              AND (@kind IS NULL OR kind=@kind) AND (NOT @peer OR kind='rule')
              AND (conversation_id IS NULL OR conversation_id=@conversation)
              AND to_tsvector('english', coalesce(content,'')) @@ plainto_tsquery('english', @query)
            ORDER BY ts_rank(to_tsvector('english', content), plainto_tsquery('english', @query)) DESC, updated_at DESC LIMIT @limit
            """, new { bot = botId, owner, query, limit = Math.Clamp(limit, 1, 20), kind, peer, conversation = conversationId })).ToList();
        if (rows.Count > 0)
        {
            var ids = rows.Select(row => (Guid)row.id).ToArray();
            await conn.ExecuteAsync("UPDATE memories SET last_used_at=now(),use_count=use_count+1 WHERE id=ANY(@ids)", new { ids });
        }
        return new { matches = rows };
    }

    private static int GetInt(string? value, int fallback) => int.TryParse(value, out var parsed) && parsed > 0 ? parsed : fallback;
    private static double Similarity(string a, string b)
    {
        var left = Regex.Matches(a, @"[\p{L}\p{N}]+").Select(m => m.Value).ToHashSet(StringComparer.Ordinal);
        var right = Regex.Matches(b, @"[\p{L}\p{N}]+").Select(m => m.Value).ToHashSet(StringComparer.Ordinal);
        if (left.Count == 0 || right.Count == 0) return 0;
        return left.Intersect(right).Count() / (double)left.Union(right).Count();
    }
    private static Task Event(NpgsqlConnection conn, NpgsqlTransaction tx, Guid id, Guid bot, Guid owner, string actor, string action, Guid? task, string? before, string? after, int? version) => conn.ExecuteAsync("INSERT INTO memory_events(memory_id,bot_id,owner_id,actor,action,task_id,before_hash,after_hash,version) VALUES(@id,@bot,@owner,@actor,@action,@task,@before,@after,@version)", new { id, bot, owner, actor, action, task, before, after, version }, tx);
    private async Task Notice(Guid bot, Guid task, string action, Guid id, string kind, string content, string? previous = null)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        var conversation = await conn.ExecuteScalarAsync<Guid?>("SELECT conversation_id FROM tasks WHERE id=@id", new { id = task });
        if (conversation == null) return;
        var json = System.Text.Json.JsonSerializer.Serialize(new { type = "memory", action, memoryId = id, kind, content, previous });
        await conn.ExecuteAsync("INSERT INTO messages(conversation_id,role,kind,content,task_id) VALUES(@conversation,'assistant','memory',@json,@task)", new { conversation, json, task });
        await platform.Publish(new { type = "task", taskId = task, botId = bot });
    }
}
