using System.Text.Json.Nodes;
using Dapper;

namespace Teammates.Api;

public static class LearnedRoutes
{
    public static void Map(WebApplication app, Platform p)
    {
        app.MapGet("/api/bots/{id:guid}/learned", async (HttpContext ctx, Guid id) =>
        {
            var user = await Routes.RequireUser(ctx,p); if (user is null) return Results.Unauthorized();
            if (!await Routes.Owns(p,user.Value,id)) return Results.StatusCode(403);
            await using var c = await p.Data.OpenConnectionAsync();
            var rows = await c.QueryAsync("""
                SELECT id,learned_kind AS kind,content,learned_source::text AS source,created_at,updated_at FROM memories
                WHERE bot_id=@id AND owner_id=@user AND learned_kind IS NOT NULL AND status='active' AND deleted_at IS NULL
                ORDER BY updated_at DESC LIMIT 50
                """, new { id,user });
            return Results.Json(rows.Select(r => new { id=(Guid)r.id,kind=(string)r.kind,text=BriefValidator.Clean((string)r.content),
                source=JsonNode.Parse(BriefValidator.Clean((string)r.source)),createdAt=(DateTime)r.created_at,updatedAt=(DateTime)r.updated_at }));
        });
        app.MapDelete("/api/bots/{id:guid}/learned/{noteId:guid}", async (HttpContext ctx,Guid id,Guid noteId) =>
        {
            var user = await Routes.RequireUser(ctx,p); if (user is null) return Results.Unauthorized();
            if (!await Routes.Owns(p,user.Value,id)) return Results.StatusCode(403);
            await using var c = await p.Data.OpenConnectionAsync(); await using var tx = await c.BeginTransactionAsync();
            await c.ExecuteAsync("SELECT id FROM bots WHERE id=@id FOR UPDATE", new { id },tx);
            var changed = await c.ExecuteAsync("""
                UPDATE memories SET status='deleted',deleted_at=now(),updated_at=now()
                WHERE id=@noteId AND bot_id=@id AND owner_id=@user AND learned_kind IS NOT NULL AND status IN ('active','pending')
                """, new { id,noteId,user },tx);
            if (changed==0) return Results.NotFound();
            await c.ExecuteAsync("INSERT INTO memory_events(memory_id,bot_id,owner_id,actor,action) VALUES(@noteId,@id,@user,'user','delete')",new { noteId,id,user },tx);
            await tx.CommitAsync();
            await p.Audit(user.Value.ToString(),"learning.deleted",id,null,new { noteId });
            return Results.NoContent();
        });
    }
}
