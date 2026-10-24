using Teammates.Compute;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using Npgsql;

namespace Teammates.Api;

public sealed class PageDocument
{
    public Guid Id { get; set; }
    public Guid OwnerId { get; set; }
    public Guid BotId { get; set; }
    public Guid? ConversationId { get; set; }
    public string Title { get; set; } = "";
    public string Kind { get; set; } = "";
    public int CurrentVersion { get; set; }
    public string ShareMode { get; set; } = "private";
    public DateTime UpdatedAt { get; set; }
    public string Source { get; set; } = "";
    public int Version { get; set; }
    public string Summary { get; set; } = "";
}
public sealed class PageRevision
{
    public int Version { get; set; }
    public int AddedLines { get; set; }
    public int RemovedLines { get; set; }
    public string Author { get; set; } = "";
    public string Summary { get; set; } = "";
    public DateTime CreatedAt { get; set; }
}
public sealed class PageLink
{
    public Guid Id { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? RevokedAt { get; set; }
}

public sealed class PagesStore(NpgsqlDataSource data)
{
    public const int MaxSourceBytes = 256 * 1024;
    public static string HashToken(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();
    public static string NewToken() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    public static bool Valid(string title, string kind, string source, string summary = "") =>
        !string.IsNullOrWhiteSpace(title) && title.Length <= 160 && kind is "report" or "dashboard" or "tracker" or "plan" or "other"
        && Encoding.UTF8.GetByteCount(source) <= MaxSourceBytes && summary.Length <= 500 && !Dlp.HasStrict(source) && !Dlp.HasStrict(title) && !Dlp.HasStrict(summary);
    public static (int Added, int Removed) Diff(string before, string after)
    {
        static Dictionary<string, int> Lines(string text) => (text.Length == 0 ? Array.Empty<string>() : text.Replace("\r\n", "\n").Split('\n')).GroupBy(line => line).ToDictionary(group => group.Key, group => group.Count());
        var a = Lines(before); var b = Lines(after);
        var added = b.Sum(pair => Math.Max(0, pair.Value - a.GetValueOrDefault(pair.Key)));
        var removed = a.Sum(pair => Math.Max(0, pair.Value - b.GetValueOrDefault(pair.Key)));
        return (added, removed);
    }
    public static string? Source(JsonElement b)
    {
        if (!b.TryGetProperty("source", out var source)) return null;
        if (source.ValueKind != JsonValueKind.String) throw new ArgumentException("invalid_source");
        return source.GetString();
    }
    public static bool IsTool(string tool) => tool is "write_page" or "edit_page";
    public static string Get(JsonElement b, string key) => b.ValueKind == JsonValueKind.Object && b.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    public async Task<IEnumerable<dynamic>> List(Guid owner, Guid bot, string query, string kind)
    {
        await using var c = await data.OpenConnectionAsync();
        return await c.QueryAsync("""
            SELECT id,title,kind,current_version,updated_at,conversation_id FROM pages
            WHERE owner_id=@owner AND bot_id=@bot AND (@kind='' OR kind=@kind) AND title ILIKE @query
            ORDER BY updated_at DESC,id LIMIT 200
            """, new { owner, bot, kind, query = "%" + query[..Math.Min(query.Length, 160)] + "%" });
    }
    public async Task<PageDocument?> Read(Guid owner, Guid id, int? version = null)
    {
        await using var c = await data.OpenConnectionAsync();
        return await c.QuerySingleOrDefaultAsync<PageDocument>("""
            SELECT p.*,v.source,v.version,v.summary FROM pages p JOIN page_versions v ON v.page_id=p.id AND v.version=coalesce(@version,p.current_version)
            WHERE p.id=@id AND p.owner_id=@owner
            """, new { owner, id, version });
    }
    public async Task<PageDocument?> Save(Guid owner, Guid bot, Guid? chat, Guid? id, string title, string kind, string? source, string summary, string author, int? restore = null, JsonElement edits = default)
    {
        await using var c = await data.OpenConnectionAsync(); await using var tx = await c.BeginTransactionAsync();
        // Validate bot and conversation ownership even for direct API calls.
        if (!await c.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM bots WHERE id=@bot AND owner_id=@owner)", new { bot, owner }, tx)) return null;
        if (chat != null && !await c.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM conversations WHERE id=@chat AND bot_id=@bot)", new { chat, bot }, tx)) return null;
        var version = 1; var previousSource = "";
        if (id != null)
        {
            var old = await c.QuerySingleOrDefaultAsync<PageDocument>("""
                SELECT p.* FROM pages p
                WHERE p.id=@id AND p.owner_id=@owner AND p.bot_id=@bot FOR UPDATE OF p
                """, new { id, owner, bot }, tx);
            if (old == null) return null;
            old.Source = await c.ExecuteScalarAsync<string>("SELECT source FROM page_versions WHERE page_id=@id AND version=@version", new { id, version = old.CurrentVersion }, tx) ?? "";
            previousSource = old.Source;
            title = old.Title; kind = old.Kind; chat = old.ConversationId; version = old.CurrentVersion + 1;
            if (restore != null)
            {
                source = await c.QuerySingleOrDefaultAsync<string>("SELECT source FROM page_versions WHERE page_id=@id AND version=@restore", new { id, restore }, tx);
                if (source == null) return null;
                summary = "Restored version " + restore;
            }
            else if (source == null && edits.ValueKind == JsonValueKind.Array)
            {
                source = old.Source;
                if (edits.GetArrayLength() > 50) throw new ArgumentException("too_many_edits");
                foreach (var edit in edits.EnumerateArray())
                {
                    if (edit.ValueKind != JsonValueKind.Object || !edit.TryGetProperty("find", out var f) || f.ValueKind != JsonValueKind.String || !edit.TryGetProperty("replace", out var r) || r.ValueKind != JsonValueKind.String) throw new ArgumentException("invalid_edit");
                    var find = Get(edit, "find"); var replacement = Get(edit, "replace");
                    var index = source.IndexOf(find, StringComparison.Ordinal);
                    if (find.Length == 0 || index < 0 || source.IndexOf(find, index + find.Length, StringComparison.Ordinal) >= 0) throw new ArgumentException("edit_find_must_match_once");
                    source = source[..index] + replacement + source[(index + find.Length)..];
                    if (Encoding.UTF8.GetByteCount(source) > MaxSourceBytes) throw new ArgumentException("page_too_large");
                }
            }
        }
        if (source == null || !Valid(title, kind, source, summary)) throw new ArgumentException("invalid_page_or_sensitive_content");
        source = OutputRedactor.Redact(source);
        if (id == null)
        {
            id = Guid.NewGuid();
            await c.ExecuteAsync("INSERT INTO pages(id,owner_id,bot_id,conversation_id,title,kind) VALUES(@id,@owner,@bot,@chat,@title,@kind)", new { id, owner, bot, chat, title, kind }, tx);
        }
        else await c.ExecuteAsync("UPDATE pages SET current_version=@version,updated_at=now() WHERE id=@id AND owner_id=@owner", new { id, owner, version }, tx);
        var diff = Diff(previousSource, source);
        await c.ExecuteAsync("INSERT INTO page_versions(page_id,version,source,author,summary,added_lines,removed_lines) VALUES(@id,@version,@source,@author,@summary,@added,@removed)", new { id, version, source, author, summary, added = diff.Added, removed = diff.Removed }, tx);
        await tx.CommitAsync();
        return await Read(owner, id.Value, version);
    }
    public async Task<IEnumerable<PageRevision>> History(Guid owner, Guid id)
    {
        await using var c = await data.OpenConnectionAsync();
        return await c.QueryAsync<PageRevision>("SELECT v.version,v.author,v.summary,v.created_at,v.added_lines,v.removed_lines FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.id=@id AND p.owner_id=@owner ORDER BY version DESC LIMIT 200", new { owner, id });
    }
    public async Task<(Guid Id, string Token)?> Share(Guid owner, Guid id)
    {
        var token = NewToken(); var hash = HashToken(token); var link = Guid.NewGuid();
        await using var c = await data.OpenConnectionAsync(); await using var tx = await c.BeginTransactionAsync();
        if (await c.ExecuteAsync("UPDATE pages SET share_mode='link' WHERE id=@id AND owner_id=@owner", new { id, owner }, tx) == 0) return null;
        await c.ExecuteAsync("INSERT INTO page_share_links(id,page_id,owner_id,created_by,token_hash) VALUES(@link,@id,@owner,@owner,@hash)", new { link, id, owner, hash }, tx);
        await tx.CommitAsync(); return (link, token);
    }
    public async Task<IEnumerable<PageLink>> Links(Guid owner, Guid id)
    {
        await using var c = await data.OpenConnectionAsync();
        return await c.QueryAsync<PageLink>("SELECT id,created_at,revoked_at FROM page_share_links WHERE page_id=@id AND owner_id=@owner ORDER BY created_at DESC LIMIT 200", new { owner, id });
    }
    public async Task<bool> Revoke(Guid owner, Guid id, Guid link)
    {
        await using var c = await data.OpenConnectionAsync(); await using var tx = await c.BeginTransactionAsync();
        // Same lock order as Share prevents share_mode races.
        await c.ExecuteAsync("SELECT id FROM pages WHERE id=@id AND owner_id=@owner FOR UPDATE", new { id, owner }, tx);
        var count = await c.ExecuteAsync("UPDATE page_share_links SET revoked_at=coalesce(revoked_at,now()) WHERE id=@link AND page_id=@id AND owner_id=@owner", new { id, link, owner }, tx);
        await c.ExecuteAsync("UPDATE pages SET share_mode='private' WHERE id=@id AND owner_id=@owner AND NOT EXISTS(SELECT 1 FROM page_share_links WHERE page_id=@id AND revoked_at IS NULL)", new { id, owner }, tx);
        await tx.CommitAsync(); return count > 0;
    }
    public async Task<object?> Shared(string token)
    {
        if (token.Length != 64 || token.Any(ch => !Uri.IsHexDigit(ch))) return null;
        await using var c = await data.OpenConnectionAsync();
        // Public response deliberately omits all owner, bot and conversation identifiers.
        return await c.QuerySingleOrDefaultAsync("""
            SELECT p.title,p.kind,p.current_version,v.source FROM page_share_links l JOIN pages p ON p.id=l.page_id AND p.owner_id=l.owner_id
            JOIN page_versions v ON v.page_id=p.id AND v.version=p.current_version
            WHERE l.token_hash=@hash AND l.revoked_at IS NULL AND p.share_mode='link'
            """, new { hash = HashToken(token) });
    }
}

public static class PagesRoutes
{
    public static void Map(WebApplication app, Platform platform)
    {
        app.Use(async (ctx, next) =>
        {
            var path = ctx.Request.Path.Value ?? "";
            if (ctx.Request.Method is "POST" or "PUT" && (path.StartsWith("/api/pages/", StringComparison.Ordinal) || path.StartsWith("/api/bots/", StringComparison.Ordinal) && path.EndsWith("/pages", StringComparison.Ordinal)))
            {
                const long cap = 2 * 1024 * 1024;
                if (ctx.Request.ContentLength > cap) { ctx.Response.StatusCode = 413; return; }
                var feature = ctx.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>();
                if (feature is { IsReadOnly: false }) feature.MaxRequestBodySize = cap;
            }
            await next(ctx);
        });
        var store = new PagesStore(platform.Data);
        var group = app.MapGroup("/api");
        group.AddEndpointFilter(async (invocation, next) =>
        {
            var ctx = invocation.HttpContext;
            // Refuse oversized envelopes before JSON binding when Content-Length is supplied.
            ctx.Response.Headers.CacheControl = "no-store";
            var owner = await Routes.RequireUser(ctx, platform);
            if (owner == null) return Results.Unauthorized();
            if (!PagesRateLimit.Allow(owner.Value, 120)) return Results.StatusCode(429);
            ctx.Items["page_owner"] = owner.Value;
            try { return await next(invocation); }
            catch (ArgumentException) { return Results.BadRequest(new { error = "Invalid page content or edit. Maximum source size is 256 KB." }); }
        });
        group.MapGet("/bots/{bot:guid}/pages", async (HttpContext ctx, Guid bot, string? q, string? kind) =>
        {
            var owner = (Guid)ctx.Items["page_owner"]!;
            if (!await Routes.Owns(platform, owner, bot)) return Results.NotFound();
            return Results.Json(await store.List(owner, bot, q ?? "", kind ?? ""));
        });
        group.MapPost("/bots/{bot:guid}/pages", async (HttpContext ctx, Guid bot, JsonElement b) =>
        {
            var owner = (Guid)ctx.Items["page_owner"]!;
            Guid? chat = Guid.TryParse(PagesStore.Get(b, "conversationId"), out var cid) ? cid : null;
            var result = await store.Save(owner, bot, chat, null, PagesStore.Get(b, "title"), PagesStore.Get(b, "kind"), PagesStore.Source(b), "Created page", "user");
            if (result == null) return Results.NotFound();
            await platform.Audit(owner.ToString(), "page.create", bot, null, new { result.Id, version = result.Version });
            return Results.Json(result);
        }).WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(2 * 1024 * 1024));
        group.MapGet("/pages/{id:guid}", async (HttpContext ctx, Guid id, int? version) =>
        {
            var result = await store.Read((Guid)ctx.Items["page_owner"]!, id, version);
            return result == null ? Results.NotFound() : Results.Json(result);
        });
        group.MapGet("/pages/{id:guid}/versions", async (HttpContext ctx, Guid id) =>
        {
            var owner = (Guid)ctx.Items["page_owner"]!;
            if (await store.Read(owner, id) == null) return Results.NotFound();
            return Results.Json(await store.History(owner, id));
        });
        group.MapPut("/pages/{id:guid}", async (HttpContext ctx, Guid id, JsonElement b) =>
        {
            var owner = (Guid)ctx.Items["page_owner"]!; var old = await store.Read(owner, id);
            if (old == null) return Results.NotFound();
            var result = await store.Save(owner, old.BotId, old.ConversationId, id, old.Title, old.Kind, PagesStore.Source(b), PagesStore.Get(b, "summary"), "user", edits: b.TryGetProperty("edits", out var edits) ? edits : default);
            await platform.Audit(owner.ToString(), "page.edit", old.BotId, null, new { id, version = result?.Version });
            return Results.Json(result);
        }).WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(2 * 1024 * 1024));
        group.MapPost("/pages/{id:guid}/restore/{version:int}", async (HttpContext ctx, Guid id, int version) =>
        {
            var owner = (Guid)ctx.Items["page_owner"]!; var old = await store.Read(owner, id);
            if (old == null) return Results.NotFound();
            var result = await store.Save(owner, old.BotId, old.ConversationId, id, old.Title, old.Kind, null, "", "user", version);
            if (result == null) return Results.NotFound();
            await platform.Audit(owner.ToString(), "page.restore", old.BotId, null, new { id, restoredFrom = version, result.Version });
            return Results.Json(result);
        });
        group.MapGet("/pages/{id:guid}/shares", async (HttpContext ctx, Guid id) =>
        {
            var owner = (Guid)ctx.Items["page_owner"]!;
            if (await store.Read(owner, id) == null) return Results.NotFound();
            return Results.Json(await store.Links(owner, id));
        });
        group.MapPost("/pages/{id:guid}/shares", async (HttpContext ctx, Guid id) =>
        {
            var owner = (Guid)ctx.Items["page_owner"]!; var result = await store.Share(owner, id);
            if (result == null) return Results.NotFound();
            await platform.Audit(owner.ToString(), "page.share", null, null, new { id, linkId = result.Value.Id });
            return Results.Json(new { id = result.Value.Id, url = "/p/" + result.Value.Token });
        });
        group.MapDelete("/pages/{id:guid}/shares/{link:guid}", async (HttpContext ctx, Guid id, Guid link) =>
        {
            var owner = (Guid)ctx.Items["page_owner"]!;
            if (!await store.Revoke(owner, id, link)) return Results.NotFound();
            await platform.Audit(owner.ToString(), "page.revoke", null, null, new { id, link }); return Results.NoContent();
        });
        app.MapGet("/api/public/pages/{token}", async (HttpContext ctx, string token) =>
        {
            ctx.Response.Headers.CacheControl = "no-store"; ctx.Response.Headers["Referrer-Policy"] = "no-referrer";
            var ip = ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";
            var rateKey = new Guid(SHA256.HashData(Encoding.UTF8.GetBytes("pages-public:" + ip)).AsSpan(0, 16));
            if (!PagesRateLimit.Allow(rateKey, 120)) return Results.StatusCode(429);
            var result = await store.Shared(token); return result == null ? Results.NotFound() : Results.Json(result);
        });
    }

    public static async Task<object> Tool(Platform platform, Guid owner, Guid bot, Guid task, string tool, JsonElement args)
    {
        if (!PagesRateLimit.Allow(owner, 60)) throw new ToolHalt("denied", "page_rate_limited");
        await using var c = await platform.Data.OpenConnectionAsync();
        var context = await c.QuerySingleOrDefaultAsync<(Guid Id, Guid? Chat, Guid? Origin)>("SELECT id,conversation_id AS chat,origin_thread_id AS origin FROM tasks WHERE id=@task AND bot_id=@bot", new { task, bot });
        if (context.Id == Guid.Empty || context.Origin != null) throw new ToolHalt("denied", "page_requires_owner_chat");
        var store = new PagesStore(platform.Data);
        Guid? id = null;
        if (tool == "edit_page")
        {
            if (args.TryGetProperty("page_id", out _))
            {
                if (!Guid.TryParse(PagesStore.Get(args, "page_id"), out var supplied)) throw new ToolHalt("invalid", "invalid_page_id");
                id = supplied;
            }
            else id = await c.ExecuteScalarAsync<Guid?>("SELECT id FROM pages WHERE owner_id=@owner AND bot_id=@bot AND conversation_id=@chat ORDER BY updated_at DESC LIMIT 1", new { owner, bot, chat = context.Chat });
            if (id == null) throw new ToolHalt("not_found", "no_page_in_chat");
            // The tool cannot cross a bot's chat boundary, even for the same owner.
            if (!await c.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM pages WHERE id=@id AND owner_id=@owner AND bot_id=@bot AND conversation_id=@chat)", new { id, owner, bot, chat = context.Chat })) throw new ToolHalt("not_found", "page_not_in_chat");
        }
        try
        {
            var page = await store.Save(owner, bot, context.Chat, id, PagesStore.Get(args, "title"), PagesStore.Get(args, "kind"), PagesStore.Source(args), PagesStore.Get(args, "summary"), "bot", edits: args.TryGetProperty("edits", out var edits) ? edits : default);
            if (page == null) throw new ToolHalt("not_found", "page_not_found");
            await platform.Audit(bot.ToString(), id == null ? "page.create" : "page.edit", bot, task, new { page.Id, page.Version });
            if (context.Chat != null)
            {
                var metadata = JsonSerializer.Serialize(new { page = new { id = page.Id, title = page.Title, kind = page.Kind, version = page.Version } });
                var mid = await c.ExecuteScalarAsync<Guid>("INSERT INTO messages(conversation_id,role,kind,content,metadata,task_id) VALUES(@chat,'assistant','page',@title,@metadata::jsonb,@task) RETURNING id", new { chat = context.Chat, task, title = page.Title, metadata });
                await platform.Publish(new { type = "message", botId = bot, conversationId = context.Chat, id = mid });
            }
            return new { ok = true, page_id = page.Id, title = page.Title, kind = page.Kind, version = page.Version };
        }
        catch (ArgumentException) { throw new ToolHalt("invalid", "invalid_page_content_or_edits"); }
    }
}


public static class PagesRateLimit
{
    private sealed class Bucket { public readonly object Gate = new(); public DateTime Start = DateTime.UtcNow; public int Hits; }
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<Guid, Bucket> Buckets = new();
    public static bool Allow(Guid key, int limit)
    {
        if (Buckets.Count > 10000)
        {
            foreach (var pair in Buckets.Where(p => DateTime.UtcNow - p.Value.Start > TimeSpan.FromMinutes(2))) Buckets.TryRemove(pair.Key, out _);
            if (Buckets.Count > 10000 && !Buckets.ContainsKey(key)) return false;
        }
        var bucket = Buckets.GetOrAdd(key, _ => new Bucket());
        lock (bucket.Gate)
        {
            var now = DateTime.UtcNow;
            if (now - bucket.Start >= TimeSpan.FromMinutes(1)) { bucket.Start = now; bucket.Hits = 0; }
            if (bucket.Hits >= limit) return false;
            bucket.Hits++; return true;
        }
    }
}
