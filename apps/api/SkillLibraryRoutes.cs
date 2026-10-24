using System.Text.Json;
using System.Text;
using System.Text.RegularExpressions;
using Dapper;
using Teammates.Compute;

namespace Teammates.Api;

public static class SkillLibraryRoutes
{
    public const int MaxBodyLength = 32 * 1024;
    public const int MaxCatalogEntries = 60;
    public const int MaxCatalogCharacters = 4000;

    public static bool Valid(string name, string title, string hint, string body) =>
        name.Length <= 80 && Regex.IsMatch(name, "^[a-z0-9]+(?:-[a-z0-9]+)*$") && !string.IsNullOrWhiteSpace(title) && title.Length <= 120 &&
        !string.IsNullOrWhiteSpace(hint) && hint.Length <= 240 && hint.IndexOfAny(['\n', '\r']) < 0 && !string.IsNullOrWhiteSpace(body) &&
        Encoding.UTF8.GetByteCount(body) <= MaxBodyLength && !Dlp.HasStrict(body);

    public static bool CanBotEdit(string source, bool ownerAllows = false) => source == "bot" || source == "user" && ownerAllows;
    public static bool CanOwnerMutate(string source) => source != "builtin";
    public static bool VisibleToBot(Guid skillOwner, Guid botOwner, Guid? scopedBot, Guid botId) => skillOwner == botOwner && (scopedBot is null || scopedBot == botId);

    public static IReadOnlyList<string> FormatCatalog(IEnumerable<(string Name, string WhenToUse, string Source)> skills)
    {
        var lines = new List<string>();
        var chars = 0;
        foreach (var (name, hint, _) in skills.OrderBy(x => x.Source == "builtin" ? 0 : x.Source == "user" ? 1 : 2).ThenBy(x => x.Name, StringComparer.Ordinal).Take(MaxCatalogEntries))
        {
            var line = $"{name}: {hint.Replace('\n', ' ').Replace('\r', ' ')}";
            if (chars + line.Length + (lines.Count == 0 ? 0 : 1) > MaxCatalogCharacters) break;
            lines.Add(line);
            chars += line.Length + (lines.Count == 1 ? 0 : 1);
        }
        return lines;
    }

    public static void Map(WebApplication app, Platform platform)
    {
        app.MapGet("/api/bots/{id:guid}/skill-library", async (HttpContext ctx, Guid id) =>
        {
            var owner = await Routes.RequireUser(ctx, platform);
            if (owner is null || !await Routes.Owns(platform, owner.Value, id)) return Results.Unauthorized();
            await using var c = await platform.Data.OpenConnectionAsync();
            await SeedBuiltins(c, owner.Value);
            var rows = await c.QueryAsync("""
                SELECT id,name,title,when_to_use,kind,source,version,allow_bot_edit,created_by,created_at,updated_at,bot_id
                FROM skill_library WHERE owner_id=@owner AND archived_at IS NULL AND (bot_id IS NULL OR bot_id=@id)
                ORDER BY CASE source WHEN 'builtin' THEN 0 WHEN 'user' THEN 1 ELSE 2 END, name LIMIT 60
                """, new { owner, id });
            return Results.Json(rows);
        });

        app.MapGet("/api/skill-library/{id:guid}", async (HttpContext ctx, Guid id) =>
        {
            var owner = await Routes.RequireUser(ctx, platform);
            if (owner is null) return Results.Unauthorized();
            await using var c = await platform.Data.OpenConnectionAsync();
            var row = await c.QuerySingleOrDefaultAsync("SELECT id,name,title,when_to_use,kind,source,version,allow_bot_edit,created_by,created_at,updated_at,body FROM skill_library WHERE id=@id AND owner_id=@owner AND archived_at IS NULL", new { id, owner });
            return row is null ? Results.NotFound() : Results.Json(row);
        });

        app.MapPost("/api/bots/{id:guid}/skill-library", async (HttpContext ctx, Guid id, JsonElement b) =>
        {
            var owner = await Routes.RequireUser(ctx, platform);
            if (owner is null || !await Routes.Owns(platform, owner.Value, id)) return Results.Unauthorized();
            var name = Get(b, "name"); var title = Get(b, "title"); var hint = Get(b, "whenToUse"); var body = Get(b, "body");
            var allowBotEdit = b.TryGetProperty("allowBotEdit", out var abe) && abe.ValueKind == JsonValueKind.True;
            if (!Valid(name, title, hint, body)) return Results.BadRequest(new { error = "invalid_skill_or_sensitive_content" });
            body = OutputRedactor.Redact(body);
            Guid? bot = null;
            if (b.TryGetProperty("botId", out var bi))
            {
                if (bi.ValueKind != JsonValueKind.String || !Guid.TryParse(bi.GetString(), out var botValue)) return Results.BadRequest(new { error = "invalid_bot_scope" });
                bot = botValue;
            }
            if (bot is not null && (bot != id || !await Routes.Owns(platform, owner.Value, bot.Value))) return Results.BadRequest(new { error = "invalid_bot_scope" });
            await using var c = await platform.Data.OpenConnectionAsync(); await using var tx = await c.BeginTransactionAsync();
            var sid = await c.ExecuteScalarAsync<Guid>("""
                INSERT INTO skill_library(owner_id,tenant_id,bot_id,name,title,when_to_use,body,source,created_by,allow_bot_edit)
                VALUES(@owner,NULL,@bot,@name,@title,@hint,@body,'user',@actor,@allowBotEdit) RETURNING id
                """, new { owner = owner.Value, bot, name, title, hint, body, actor = owner.Value.ToString(), allowBotEdit }, tx);
            await c.ExecuteAsync("INSERT INTO skill_revisions(skill_id,version,body,author,reason) VALUES(@sid,0,'',@author,'initial creation')", new { sid, author = owner.Value.ToString() }, tx);
            await tx.CommitAsync();
            await platform.Audit(owner.Value.ToString(), "skill.create", bot, null, new { id = sid, name });
            return Results.Json(new { id = sid, version = 1 });
        });

        app.MapPut("/api/skill-library/{id:guid}", async (HttpContext ctx, Guid id, JsonElement b) =>
        {
            var owner = await Routes.RequireUser(ctx, platform); if (owner is null) return Results.Unauthorized();
            var name = Get(b, "name"); var title = Get(b, "title"); var hint = Get(b, "whenToUse"); var body = Get(b, "body");
            if (!Valid(name, title, hint, body)) return Results.BadRequest(new { error = "invalid_skill_or_sensitive_content" }); body = OutputRedactor.Redact(body);
            await using var c = await platform.Data.OpenConnectionAsync(); await using var tx = await c.BeginTransactionAsync();
            var current = await c.QuerySingleOrDefaultAsync<(Guid? BotId, string Source, int Version, string Body)>("SELECT bot_id,source,version,body FROM skill_library WHERE id=@id AND owner_id=@owner AND archived_at IS NULL FOR UPDATE", new { id, owner }, tx);
            if (current.Version == 0) return Results.NotFound();
            if (!CanOwnerMutate(current.Source)) return Results.Json(new { error = "builtin_skills_are_read_only" }, statusCode: 403);
            await c.ExecuteAsync("INSERT INTO skill_revisions(skill_id,version,body,author,reason) VALUES(@id,@version,@body,@author,'owner update')", new { id, version = current.Version, body = current.Body, author = owner.ToString() }, tx);
            var allowBotEdit = b.TryGetProperty("allowBotEdit", out var abe) && abe.ValueKind == JsonValueKind.True;
            await c.ExecuteAsync("UPDATE skill_library SET name=@name,title=@title,when_to_use=@hint,body=@body,allow_bot_edit=@allowBotEdit,version=version+1,updated_at=now() WHERE id=@id", new { id, name, title, hint, body, allowBotEdit }, tx);
            await tx.CommitAsync();
            await platform.Audit(owner.Value.ToString(), "skill.update", current.BotId, null, new { id, name });
            return Results.Ok(new { version = current.Version + 1 });
        });

        app.MapPost("/api/skill-library/{id:guid}/archive", async (HttpContext ctx, Guid id) =>
        {
            var owner = await Routes.RequireUser(ctx, platform); if (owner is null) return Results.Unauthorized();
            await using var c = await platform.Data.OpenConnectionAsync();
            var row = await c.QuerySingleOrDefaultAsync<(Guid? BotId, string Source)>("UPDATE skill_library SET archived_at=now() WHERE id=@id AND owner_id=@owner AND source<>'builtin' AND archived_at IS NULL RETURNING bot_id,source", new { id, owner });
            if (row.Source is null) return Results.NotFound();
            await platform.Audit(owner.Value.ToString(), "skill.archive", row.BotId, null, new { id }); return Results.Ok();
        });

        app.MapGet("/api/skill-library/{id:guid}/revisions", async (HttpContext ctx, Guid id) =>
        {
            var owner = await Routes.RequireUser(ctx, platform); if (owner is null) return Results.Unauthorized();
            await using var c = await platform.Data.OpenConnectionAsync();
            if (await c.ExecuteScalarAsync<int>("SELECT count(*) FROM skill_library WHERE id=@id AND owner_id=@owner", new { id, owner }) == 0) return Results.NotFound();
            return Results.Json(await c.QueryAsync("SELECT id,version,body,author,reason,created_at FROM skill_revisions WHERE skill_id=@id ORDER BY version DESC", new { id }));
        });

        app.MapPost("/api/skill-library/{id:guid}/revert/{version:int}", async (HttpContext ctx, Guid id, int version) =>
        {
            var owner = await Routes.RequireUser(ctx, platform); if (owner is null) return Results.Unauthorized();
            await using var c = await platform.Data.OpenConnectionAsync(); await using var tx = await c.BeginTransactionAsync();
            var current = await c.QuerySingleOrDefaultAsync<(int Version, string Body, string Source, Guid? BotId)>("SELECT version,body,source,bot_id FROM skill_library WHERE id=@id AND owner_id=@owner AND archived_at IS NULL FOR UPDATE", new { id, owner }, tx);
            if (current.Version == 0) return Results.NotFound();
            if (!CanOwnerMutate(current.Source)) return Results.Json(new { error = "builtin_skills_are_read_only" }, statusCode: 403);
            var old = await c.QuerySingleOrDefaultAsync<string>("SELECT body FROM skill_revisions WHERE skill_id=@id AND version=@version", new { id, version }, tx);
            if (old is null) return Results.NotFound();
            await c.ExecuteAsync("INSERT INTO skill_revisions(skill_id,version,body,author,reason) VALUES(@id,@version,@body,@author,'before owner revert')", new { id, version = current.Version, body = current.Body, author = owner.ToString() }, tx);
            await c.ExecuteAsync("UPDATE skill_library SET body=@old,version=version+1,updated_at=now() WHERE id=@id", new { id, old }, tx);
            await tx.CommitAsync(); await platform.Audit(owner.Value.ToString(), "skill.revert", current.BotId, null, new { id, revertedTo = version });
            return Results.Ok(new { version = current.Version + 1 });
        });

        app.MapPost("/internal/skills/{bot:guid}/write", async (HttpContext ctx, Guid bot, JsonElement b) =>
        {
            if (!Worker(ctx, platform)) return Results.Unauthorized();
            var name = Get(b, "name"); var title = Get(b, "title"); var hint = Get(b, "when_to_use"); var body = Get(b, "body");
            if (!Valid(name, title, hint, body)) return Results.BadRequest(new { error = "invalid_or_sensitive_skill" });
            body = OutputRedactor.Redact(body);
            await using var c = await platform.Data.OpenConnectionAsync(); await using var tx = await c.BeginTransactionAsync();
            var owner = await c.ExecuteScalarAsync<Guid?>("SELECT owner_id FROM bots WHERE id=@bot", new { bot }, tx);
            if (owner is null) return Results.NotFound();
            var old = await c.QuerySingleOrDefaultAsync<(Guid Id, int Version, string Body, string Source, bool AllowBotEdit)>("""
                SELECT id,version,body,source,allow_bot_edit FROM skill_library WHERE owner_id=@owner AND name=@name AND archived_at IS NULL
                    AND (bot_id=@bot OR bot_id IS NULL)
                ORDER BY (bot_id=@bot) DESC LIMIT 1 FOR UPDATE
                """, new { owner, bot, name }, tx);
            Guid sid;
            if (old.Id == Guid.Empty)
            {
                sid = await c.ExecuteScalarAsync<Guid>("INSERT INTO skill_library(owner_id,tenant_id,bot_id,name,title,when_to_use,body,source,created_by) VALUES(@owner,NULL,@bot,@name,@title,@hint,@body,'bot',@bot::text) RETURNING id", new { owner, bot, name, title, hint, body }, tx);
                await c.ExecuteAsync("INSERT INTO skill_revisions(skill_id,version,body,author,reason) VALUES(@sid,0,'',@bot,'initial creation')", new { sid, bot }, tx);
            }
            else
            {
                if (!CanBotEdit(old.Source, old.AllowBotEdit)) return Results.Json(new { error = "bot_may_edit_only_bot_authored_skills" }, statusCode: 403);
                sid = old.Id;
                await c.ExecuteAsync("INSERT INTO skill_revisions(skill_id,version,body,author,reason) VALUES(@sid,@version,@body,@bot,'bot update')", new { sid, version = old.Version, body = old.Body, bot }, tx);
                await c.ExecuteAsync("UPDATE skill_library SET title=@title,when_to_use=@hint,body=@body,version=version+1,updated_at=now() WHERE id=@sid", new { sid, title, hint, body }, tx);
            }
            await tx.CommitAsync(); await platform.Audit(bot.ToString(), old.Id == Guid.Empty ? "skill.bot_create" : "skill.bot_write", bot, null, new { id = sid, name });
            return Results.Json(new { id = sid, version = old.Id == Guid.Empty ? 1 : old.Version + 1 });
        });

        app.MapGet("/internal/skills/{bot:guid}/catalog", async (HttpContext ctx, Guid bot) =>
        {
            if (!Worker(ctx, platform)) return Results.Unauthorized();
            await using var c = await platform.Data.OpenConnectionAsync();
            var owner = await c.ExecuteScalarAsync<Guid?>("SELECT owner_id FROM bots WHERE id=@bot", new { bot });
            if (owner is null) return Results.NotFound();
            await SeedBuiltins(c, owner.Value);
            var rows = await c.QueryAsync<(string Name, string WhenToUse, string Source)>("""
                SELECT name,when_to_use AS "WhenToUse",source FROM skill_library s WHERE owner_id=@owner AND archived_at IS NULL AND (bot_id IS NULL OR bot_id=@bot)
                    AND (s.bot_id=@bot OR NOT EXISTS (SELECT 1 FROM skill_library private WHERE private.owner_id=s.owner_id AND private.bot_id=@bot AND private.name=s.name AND private.archived_at IS NULL))
                ORDER BY CASE source WHEN 'builtin' THEN 0 WHEN 'user' THEN 1 ELSE 2 END,name LIMIT 60
                """, new { owner, bot });
            return Results.Json(new { catalog = FormatCatalog(rows) });
        });

        app.MapGet("/internal/skills/{bot:guid}/{name}", async (HttpContext ctx, Guid bot, string name) =>
        {
            if (!Worker(ctx, platform)) return Results.Unauthorized();
            await using var c = await platform.Data.OpenConnectionAsync();
            var owner = await c.ExecuteScalarAsync<Guid?>("SELECT owner_id FROM bots WHERE id=@bot", new { bot });
            if (owner is null) return Results.NotFound();
            await SeedBuiltins(c, owner.Value);
            var rows = (await c.QueryAsync<(string Name, string Title, string Body, int Version)>("""
                SELECT name,title,body,version FROM skill_library WHERE owner_id=@owner AND name=@name AND archived_at IS NULL AND (bot_id IS NULL OR bot_id=@bot)
                ORDER BY (bot_id=@bot) DESC, CASE source WHEN 'builtin' THEN 0 WHEN 'user' THEN 1 ELSE 2 END LIMIT 1
                """, new { owner, bot, name })).ToArray();
            var row = rows.FirstOrDefault();
            if (row.Name is null)
            {
                var matches = await c.QueryAsync<string>("SELECT DISTINCT name FROM skill_library WHERE owner_id=@owner AND archived_at IS NULL AND (bot_id IS NULL OR bot_id=@bot) ORDER BY name", new { owner, bot });
                var close = matches.Select(n => (Name: n, Distance: EditDistance(name, n))).Where(x => x.Distance <= Math.Max(2, name.Length / 3)).OrderBy(x => x.Distance).ThenBy(x => x.Name).Take(3).Select(x => x.Name);
                return Results.NotFound(new { error = "unknown_skill", message = close.Any() ? "Unknown skill. Close matches: " + string.Join(", ", close) : "Unknown skill. No close matches." });
            }
            return Results.Json(new { row.Name, row.Title, row.Body, row.Version });
        });
    }

    private static async Task SeedBuiltins(System.Data.IDbConnection c, Guid owner)
    {
        var directory = Directory.Exists("/skills/builtin") ? "/skills/builtin" : Path.Combine(AppContext.BaseDirectory, "skills", "builtin");
        if (!Directory.Exists(directory)) return;
        foreach (var path in Directory.GetFiles(directory, "*.md").OrderBy(x => x, StringComparer.Ordinal))
        {
            var data = await File.ReadAllTextAsync(path);
            var match = Regex.Match(data, "(?s)^---\\s*\\nname:\\s*([a-z0-9-]+)\\s*\\nwhen_to_use:\\s*(.*?)\\s*\\n---\\s*\\n(.*)$");
            if (!match.Success) continue;
            await c.ExecuteAsync("""
                INSERT INTO skill_library(owner_id,tenant_id,name,title,when_to_use,body,source,created_by)
                VALUES(@owner,NULL,@name,@name,@hint,@body,'builtin','system') ON CONFLICT DO NOTHING
                """, new { owner, name = match.Groups[1].Value, hint = match.Groups[2].Value.Trim(), body = match.Groups[3].Value });
        }
    }

    private static int EditDistance(string a, string b)
    {
        var row = Enumerable.Range(0, b.Length + 1).ToArray();
        for (var i = 1; i <= a.Length; i++)
        {
            var prev = row[0]; row[0] = i;
            for (var j = 1; j <= b.Length; j++) { var old = row[j]; row[j] = Math.Min(Math.Min(row[j] + 1, row[j - 1] + 1), prev + (a[i - 1] == b[j - 1] ? 0 : 1)); prev = old; }
        }
        return row[b.Length];
    }

    private static string Get(JsonElement b, string n) => b.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
    private static bool Worker(HttpContext ctx, Platform p) => ctx.Request.Headers.Authorization == "Bearer " + p.WorkerToken;
}
