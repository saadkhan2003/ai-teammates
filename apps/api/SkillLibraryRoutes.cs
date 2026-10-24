using System.Text.Json;
using System.Text.RegularExpressions;
using Dapper;
using Teammates.Compute;

namespace Teammates.Api;

public static class SkillLibraryRoutes
{
    static bool Safe(string name, string title, string hint, string body) =>
        Regex.IsMatch(name, "^[a-z0-9]+(?:-[a-z0-9]+)*$") && title.Length is > 0 and <= 120 && hint.Length is > 0 and <= 240 && body.Length <= 32768 && !Dlp.HasStrict(body);

    public static void Map(WebApplication app, Platform platform)
    {
        app.MapGet("/api/bots/{id:guid}/skill-library", async (HttpContext ctx, Guid id) => {
            var owner = await Routes.RequireUser(ctx, platform);
            if (owner is null || !await Routes.Owns(platform, owner.Value, id)) return Results.Unauthorized();
            await using var c = await platform.Data.OpenConnectionAsync();
            return Results.Json(await c.QueryAsync("SELECT id,name,title,when_to_use,kind,source,version,created_by,created_at,updated_at FROM skill_library WHERE owner_id=@owner AND archived_at IS NULL AND (bot_id IS NULL OR bot_id=@id) ORDER BY source,name LIMIT 60", new { owner, id }));
        });
        app.MapGet("/api/skill-library/{id:guid}", async (HttpContext ctx, Guid id) => {
            var owner = await Routes.RequireUser(ctx, platform); if (owner is null) return Results.Unauthorized();
            await using var c = await platform.Data.OpenConnectionAsync();
            var row = await c.QuerySingleOrDefaultAsync("SELECT s.* FROM skill_library s WHERE s.id=@id AND s.owner_id=@owner AND s.archived_at IS NULL", new { id, owner });
            return row is null ? Results.NotFound() : Results.Json(row);
        });
        app.MapPost("/api/bots/{id:guid}/skill-library", async (HttpContext ctx, Guid id, JsonElement b) => {
            var owner = await Routes.RequireUser(ctx, platform); if (owner is null || !await Routes.Owns(platform, owner.Value, id)) return Results.Unauthorized();
            var name=Get(b,"name"); var title=Get(b,"title"); var hint=Get(b,"whenToUse"); var body=Get(b,"body");
            if (!Safe(name,title,hint,body)) return Results.BadRequest(new { error="invalid_skill_or_sensitive_content" }); body=OutputRedactor.Redact(body);
            var bot = b.TryGetProperty("botId",out var bi) && bi.ValueKind==JsonValueKind.String ? Guid.Parse(bi.GetString()!) : (Guid?)null;
            if (bot is not null && bot != id) return Results.BadRequest();
            await using var c=await platform.Data.OpenConnectionAsync();
            var sid=await c.ExecuteScalarAsync<Guid>("INSERT INTO skill_library(owner_id,bot_id,name,title,when_to_use,body,source,created_by) VALUES(@owner,@bot,@name,@title,@hint,@body,'user',@actor) RETURNING id",new{owner,bot,name,title,hint,body,actor=owner.ToString()});
            await platform.Audit(owner.ToString(),"skill.create",bot,null,new{id=sid,name}); return Results.Json(new{id=sid});
        });
        app.MapPut("/api/skill-library/{id:guid}", async (HttpContext ctx, Guid id, JsonElement b) => {
            var owner=await Routes.RequireUser(ctx,platform); if(owner is null)return Results.Unauthorized();
            var name=Get(b,"name");var title=Get(b,"title");var hint=Get(b,"whenToUse");var body=Get(b,"body");if(!Safe(name,title,hint,body))return Results.BadRequest(new{error="invalid_skill_or_sensitive_content"});body=OutputRedactor.Redact(body);
            await using var c=await platform.Data.OpenConnectionAsync(); await using var tx=await c.BeginTransactionAsync();
            var current=await c.QuerySingleOrDefaultAsync<(Guid BotId,string Source,int Version,string Body)>("SELECT coalesce(bot_id,'00000000-0000-0000-0000-000000000000'::uuid),source,version,body FROM skill_library WHERE id=@id AND owner_id=@owner AND archived_at IS NULL FOR UPDATE",new{id,owner},tx);
            if(current.Version==0)return Results.NotFound();
            if(current.Source=="builtin")return Results.Json(new{error="builtin_skills_are_read_only"},statusCode:403);
            await c.ExecuteAsync("INSERT INTO skill_revisions(skill_id,version,body,author,reason) VALUES(@id,@version,@body,@author,'owner update')",new{id,version=current.Version,body=current.Body,author=owner.ToString()},tx);
            await c.ExecuteAsync("UPDATE skill_library SET name=@name,title=@title,when_to_use=@hint,body=@body,version=version+1,updated_at=now() WHERE id=@id",new{id,name,title,hint,body},tx);await tx.CommitAsync();
            await platform.Audit(owner.ToString(),"skill.update",current.BotId==Guid.Empty?null:current.BotId,null,new{id,name});return Results.Ok(new{version=current.Version+1});
        });
        app.MapPost("/api/skill-library/{id:guid}/archive", async(HttpContext ctx,Guid id)=>{var owner=await Routes.RequireUser(ctx,platform);if(owner is null)return Results.Unauthorized();await using var c=await platform.Data.OpenConnectionAsync();var n=await c.ExecuteAsync("UPDATE skill_library SET archived_at=now() WHERE id=@id AND owner_id=@owner AND source<>'builtin' AND archived_at IS NULL",new{id,owner});if(n>0)await platform.Audit(owner.ToString(),"skill.archive",null,null,new{id});return n==0?Results.NotFound():Results.Ok();});
        app.MapGet("/api/skill-library/{id:guid}/revisions",async(HttpContext ctx,Guid id)=>{var owner=await Routes.RequireUser(ctx,platform);if(owner is null)return Results.Unauthorized();await using var c=await platform.Data.OpenConnectionAsync();if(await c.ExecuteScalarAsync<int>("SELECT count(*) FROM skill_library WHERE id=@id AND owner_id=@owner",new{id,owner})==0)return Results.NotFound();return Results.Json(await c.QueryAsync("SELECT id,version,body,author,reason,created_at FROM skill_revisions WHERE skill_id=@id ORDER BY version DESC",new{id}));});
        app.MapPost("/api/skill-library/{id:guid}/revert/{version:int}",async(HttpContext ctx,Guid id,int version)=>{var owner=await Routes.RequireUser(ctx,platform);if(owner is null)return Results.Unauthorized();await using var c=await platform.Data.OpenConnectionAsync();await using var tx=await c.BeginTransactionAsync();var old=await c.QuerySingleOrDefaultAsync<string>("SELECT r.body FROM skill_revisions r JOIN skill_library s ON s.id=r.skill_id WHERE s.id=@id AND s.owner_id=@owner AND s.source<>'builtin' AND r.version=@version",new{id,owner,version},tx);if(old is null)return Results.NotFound();await c.ExecuteAsync("INSERT INTO skill_revisions(skill_id,version,body,author,reason) SELECT id,skill_library.version,skill_library.body,@author,'before owner revert' FROM skill_library WHERE id=@id",new{id,author=owner.ToString()},tx);await c.ExecuteAsync("UPDATE skill_library SET body=@old,version=version+1,updated_at=now() WHERE id=@id AND owner_id=@owner",new{id,owner,old},tx);await tx.CommitAsync();await platform.Audit(owner.ToString(),"skill.revert",null,null,new{id,version});return Results.Ok();});
        app.MapPost("/internal/skills/{bot:guid}/write",async(HttpContext ctx,Guid bot,JsonElement b)=>{if(!Worker(ctx,platform))return Results.Unauthorized();var name=Get(b,"name");var title=Get(b,"title");var hint=Get(b,"whenToUse");var body=Get(b,"body");if(!Safe(name,title,hint,body))return Results.BadRequest(new{error="invalid_or_sensitive_skill"});await using var c=await platform.Data.OpenConnectionAsync();var owner=await c.ExecuteScalarAsync<Guid?>("SELECT owner_id FROM bots WHERE id=@bot",new{bot});if(owner is null)return Results.NotFound();var old=await c.QuerySingleOrDefaultAsync<(Guid Id,int Version,string Body,string Source)>("SELECT id,version,body,source FROM skill_library WHERE owner_id=@owner AND bot_id=@bot AND name=@name AND archived_at IS NULL",new{owner,bot,name});Guid sid;if(old.Id==Guid.Empty){sid=await c.ExecuteScalarAsync<Guid>("INSERT INTO skill_library(owner_id,bot_id,name,title,when_to_use,body,source,created_by) VALUES(@owner,@bot,@name,@title,@hint,@body,'bot',@bot::text) RETURNING id",new{owner,bot,name,title,hint,body});}else{if(old.Source!="bot")return Results.Json(new{error="bot_may_edit_only_bot_authored_skills"},statusCode:403);sid=old.Id;await c.ExecuteAsync("INSERT INTO skill_revisions(skill_id,version,body,author,reason) VALUES(@sid,@version,@body,@bot,'bot update')",new{sid,version=old.Version,body=old.Body,bot});await c.ExecuteAsync("UPDATE skill_library SET title=@title,when_to_use=@hint,body=@body,version=version+1,updated_at=now() WHERE id=@sid",new{sid,title,hint,body});}await platform.Audit(bot.ToString(),"skill.bot_write",bot,null,new{id=sid,name});return Results.Json(new{id=sid});});
        app.MapGet("/internal/skills/{bot:guid}/catalog",async(HttpContext ctx,Guid bot)=>{if(!Worker(ctx,platform))return Results.Unauthorized();await using var c=await platform.Data.OpenConnectionAsync();var owner=await c.ExecuteScalarAsync<Guid?>("SELECT owner_id FROM bots WHERE id=@bot",new{bot});if(owner is null)return Results.NotFound();foreach(var path in Directory.Exists("/skills/builtin")?Directory.GetFiles("/skills/builtin","*.md"):Array.Empty<string>()){var data=await File.ReadAllTextAsync(path);var match=Regex.Match(data,"(?s)^---\\s*\\nname:\\s*([a-z0-9-]+)\\s*\\nwhen_to_use:\\s*(.*?)\\s*\\n---\\s*\\n(.*)$");if(!match.Success)continue;await c.ExecuteAsync("INSERT INTO skill_library(owner_id,name,title,when_to_use,body,source,created_by) SELECT @owner,@name,@title,@hint,@body,'builtin','system' WHERE NOT EXISTS (SELECT 1 FROM skill_library WHERE owner_id=@owner AND name=@name AND source='builtin')",new{owner,name=match.Groups[1].Value,title=match.Groups[1].Value,hint=match.Groups[2].Value,body=match.Groups[3].Value});}var rows=await c.QueryAsync<(string Name,string WhenToUse)>("SELECT name,when_to_use FROM skill_library WHERE owner_id=@owner AND archived_at IS NULL AND (bot_id IS NULL OR bot_id=@bot) ORDER BY source,name LIMIT 60",new{owner,bot});var lines=new List<string>();var chars=0;foreach(var r in rows){var line=$"{r.Name}: {r.WhenToUse}";if(chars+line.Length+1>4000)break;lines.Add(line);chars+=line.Length+1;}return Results.Json(new{catalog=lines});});
        app.MapGet("/internal/skills/{bot:guid}/{name}",async(HttpContext ctx,Guid bot,string name)=>{if(!Worker(ctx,platform))return Results.Unauthorized();await using var c=await platform.Data.OpenConnectionAsync();var row=await c.QuerySingleOrDefaultAsync("SELECT s.name,s.title,s.body,s.version FROM skill_library s JOIN bots b ON b.owner_id=s.owner_id WHERE b.id=@bot AND s.name=@name AND s.archived_at IS NULL AND (s.bot_id IS NULL OR s.bot_id=@bot) LIMIT 1",new{bot,name});return row is null?Results.NotFound(new{error="unknown_skill"}):Results.Json(row);});
    }
    static string Get(JsonElement b,string n)=>b.TryGetProperty(n,out var v)&&v.ValueKind==JsonValueKind.String?v.GetString()??"":"";
    static bool Worker(HttpContext ctx,Platform p)=>ctx.Request.Headers.Authorization=="Bearer "+p.WorkerToken;
}
