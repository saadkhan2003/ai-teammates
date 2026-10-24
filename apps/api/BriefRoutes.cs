using System.Text.Json;
using System.Text.Json.Nodes;
using Dapper;
using Teammates.Compute;

namespace Teammates.Api;

public static class BriefRoutes
{
    public static void Map(WebApplication app, Platform p)
    {
        app.MapGet("/api/tasks/{id:guid}/brief", async (HttpContext ctx, Guid id) =>
        {
            var user = await Routes.RequireUser(ctx, p); if (user is null) return Results.Unauthorized();
            await using var c = await p.Data.OpenConnectionAsync();
            var owner = await c.ExecuteScalarAsync<Guid?>("SELECT b.owner_id FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE t.id=@id", new { id });
            if (owner is null) return Results.NotFound();
            if (!BriefStore.CanRead(user.Value, owner.Value)) return Results.StatusCode(403);
            var row = await c.QuerySingleOrDefaultAsync<BriefRow>("""
                SELECT t.id AS task_id,t.title,t.status,tb.version,tb.markdown,tb.brief::text,tb.quality::text,tb.thought_ms,tb.created_at
                FROM task_briefs tb JOIN tasks t ON t.id=tb.task_id WHERE tb.task_id=@id
                """, new { id });
            if (row is null) return Results.NotFound();
            var steering = await c.QueryAsync<SteeringRow>("SELECT id,text,created_at FROM task_brief_steering WHERE task_id=@id ORDER BY created_at,id", new { id });
            var brief = JsonNode.Parse(row.Brief)!.AsObject();
            var refs = BriefValidator.Array(brief["references"]).OfType<JsonObject>().Select(r =>
            {
                var path = BriefValidator.Text(r["path_or_url"]); var kind = BriefValidator.Text(r["kind"]);
                var url = Uri.TryCreate(path, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https" ? path : null;
                return new { kind, path, name = Path.GetFileName(path.Split('?')[0]), url };
            });
            return Results.Json(new { taskId = id, row.Title, row.Version, row.Markdown, brief, quality = JsonNode.Parse(row.Quality),
                thoughtSeconds = row.ThoughtMs / 1000d, references = refs, steering, row.Status, row.CreatedAt });
        });
        app.MapPost("/api/tasks/{id:guid}/brief/steer", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await Routes.RequireUser(ctx, p); if (user is null) return Results.Unauthorized();
            var text = body.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() ?? "" : "";
            if (!BriefStore.ValidSteering(text)) return Results.BadRequest(new { error = "text must contain 1 to 4000 characters" });
            text = BriefValidator.Clean(text).Trim();
            if (!BriefStore.ValidSteering(text)) return Results.BadRequest(new { error = "text is empty after redaction" });
            await using var c = await p.Data.OpenConnectionAsync();
            var task = await c.QuerySingleOrDefaultAsync<(Guid? Bot, Guid Owner)>("SELECT t.bot_id,b.owner_id FROM task_briefs tb JOIN tasks t ON t.id=tb.task_id JOIN bots b ON b.id=t.bot_id WHERE t.id=@id", new { id });
            if (task.Bot is null) return Results.NotFound();
            if (!BriefStore.CanRead(user.Value, task.Owner)) return Results.StatusCode(403);
            await using var tx = await c.BeginTransactionAsync();
            var row = await c.QuerySingleAsync<SteeringRow>("INSERT INTO task_brief_steering(task_id,text,actor) VALUES(@id,@text,@actor) RETURNING id,text,created_at", new { id, text, actor = user }, tx);
            await BriefStore.AddLesson(c, task.Bot.Value, task.Owner, id, text, "steer", tx);
            await tx.CommitAsync();
            await p.Audit(user.Value.ToString(), "brief.steered", task.Bot.Value, id, new { steeringId = row.Id, text });
            await p.Publish(new { type = "task", taskId = id, botId = task.Bot.Value });
            return Results.Json(row, statusCode: 202);
        });
        app.MapGet("/api/bots/{id:guid}/brief-lessons", async (HttpContext ctx, Guid id) =>
        {
            var user = await Routes.RequireUser(ctx, p); if (user is null) return Results.Unauthorized();
            if (!await Routes.Owns(p, user.Value, id)) return Results.StatusCode(403);
            await using var c = await p.Data.OpenConnectionAsync();
            var rows = await c.QueryAsync("SELECT id,lesson,source,source_task_id,created_at FROM brief_lessons WHERE bot_id=@id AND owner_id=@user ORDER BY created_at DESC LIMIT 100", new { id, user });
            return Results.Json(rows.Select(row => { var d = Platform.ToDict(row); d["lesson"] = BriefValidator.Clean((string)row.lesson); return d; }));
        });
        app.MapDelete("/api/bots/{id:guid}/brief-lessons/{lessonId:guid}", async (HttpContext ctx, Guid id, Guid lessonId) =>
        {
            var user = await Routes.RequireUser(ctx, p); if (user is null) return Results.Unauthorized();
            if (!await Routes.Owns(p, user.Value, id)) return Results.StatusCode(403);
            await using var c = await p.Data.OpenConnectionAsync();
            var n = await c.ExecuteAsync("DELETE FROM brief_lessons WHERE id=@lessonId AND bot_id=@id AND owner_id=@user", new { lessonId, id, user });
            if (n == 0) return Results.NotFound();
            await p.Audit(user.Value.ToString(), "brief.lesson_deleted", id, null, new { lessonId });
            return Results.NoContent();
        });
        // Read on every model step; transcript markers provide durable, restart-safe delivery.
        app.MapGet("/internal/tasks/{id:guid}/brief/steering", async (HttpContext ctx, Guid id, int epoch) =>
        {
            if (!Worker(ctx, p)) return Results.Unauthorized();
            await using var c = await p.Data.OpenConnectionAsync();
            if (await c.ExecuteScalarAsync<int>("SELECT count(*) FROM tasks WHERE id=@id AND status='running' AND lease_epoch=@epoch", new { id, epoch }) != 1) return Results.StatusCode(409);
            var notes = await c.QueryAsync<SteeringRow>("SELECT id,text,created_at FROM task_brief_steering WHERE task_id=@id ORDER BY created_at,id", new { id });
            return Results.Json(new { steering = notes.Select(n => new { n.Id, text = BriefValidator.Clean(n.Text), n.CreatedAt }) });
        });
        app.MapPost("/api/test/briefs/seed", async (HttpContext ctx, JsonElement body) =>
        {
            if (BriefStore.SeedStatus(p.TestHooks) == 404) return Results.NotFound();
            var user = await Routes.RequireUser(ctx, p); if (user is null) return Results.Unauthorized();
            if (!body.TryGetProperty("botId", out var bi) || !bi.TryGetGuid(out var bot)) return Results.BadRequest();
            if (!await Routes.Owns(p, user.Value, bot)) return Results.StatusCode(403);
            await using var c = await p.Data.OpenConnectionAsync();
            Guid? conversation = body.TryGetProperty("conversationId", out var ci) && ci.ValueKind == JsonValueKind.String && ci.TryGetGuid(out var conv) ? conv : null;
            conversation ??= await c.ExecuteScalarAsync<Guid?>("SELECT id FROM conversations WHERE bot_id=@bot ORDER BY created_at LIMIT 1", new { bot });
            if (conversation is null || await c.ExecuteScalarAsync<int>("SELECT count(*) FROM conversations WHERE id=@conversation AND bot_id=@bot", new { conversation, bot }) != 1) return Results.BadRequest();
            var parent = Guid.NewGuid(); var child = Guid.NewGuid();
            var b = SeedBrief(); var quality = BriefQuality.Score(b); var markdown = BriefRenderer.Render(b);
            await using var tx = await c.BeginTransactionAsync();
            await c.ExecuteAsync("INSERT INTO tasks(id,bot_id,conversation_id,title,instruction,status,kind) VALUES(@parent,@bot,@conversation,'Prepare typography brief','Seed brief','completed','chat')", new { parent, bot, conversation }, tx);
            await c.ExecuteAsync("INSERT INTO tasks(id,bot_id,conversation_id,parent_task_id,title,instruction,status) VALUES(@child,@bot,@conversation,@parent,'Polish typography',@markdown,'waiting_human')", new { child, bot, conversation, parent, markdown }, tx);
            await BriefStore.Save(c, tx, child, bot, parent, new(b, markdown, quality, 4250));
            var message = await c.ExecuteScalarAsync<Guid>("INSERT INTO messages(conversation_id,task_id,role,content) VALUES(@conversation,@parent,'assistant','I prepared a brief for the typography pass.') RETURNING id", new { conversation, parent }, tx);
            await tx.CommitAsync();
            await p.Audit(user.Value.ToString(), "brief.test_seeded", bot, child, new { message });
            await p.Publish(new { type = "task", taskId = child, botId = bot });
            return Results.Json(new { taskId = child, parentTaskId = parent, conversationId = conversation, messageId = message });
        });
    }
    public static JsonObject SeedBrief() => JsonNode.Parse("""
        {"goal":"Make chat and sidebar typography feel thin and readable in both themes.","kind":"ui","priority":"high","effort":"medium",
         "context":{"quote":"The text looks bold and heavy.","author":"Saad","mood":"frustrated","background":"Use notes 36 and 41 as exact typography guidance."},
         "references":[{"kind":"note","path_or_url":"/workspace/ui-handoff/SAAD_UI_NOTES.md","why":"Notes 36 and 41 specify typography."},{"kind":"screenshot","path_or_url":"/workspace/ui-handoff/briefs-frames/f6.5.png","why":"Match stroke weight side by side."}],
         "scope":{"in":["apps/web"],"out":["apps/api","services/agent"]},"non_goals":["Do not change behavior or navigation."],
         "rules":["Inter variable body 380–400; labels 450–500; headings at most 600.","Primary dark text #e7e9ea; muted secondary text; preserve light theme."],
         "checklist":["Audit sidebar names, chat bubbles, Library rows, tabs and dialogs."],
         "acceptance":[{"criterion":"Both themes match reference stroke weight at the same zoom.","check":"Attach light and dark side-by-side screenshot crops and a Playwright typography snapshot."}],
         "assumptions":["Keep the note-36 type sizes."],"gate":"Push only after every acceptance check and all suites are green.",
         "report_back":"Return screenshot paths in both themes, snapshot results, per-suite test counts and commit SHA."}
        """)!.AsObject();
    private static bool Worker(HttpContext ctx, Platform p)
    {
        var value = ctx.Request.Headers.Authorization.ToString();
        var supplied = System.Text.Encoding.UTF8.GetBytes(value.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? value[7..].Trim() : "");
        var expected = System.Text.Encoding.UTF8.GetBytes(p.WorkerToken);
        return expected.Length > 0 && expected.Length == supplied.Length && System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(expected, supplied);
    }
    public sealed class BriefRow
    {
        public string Title { get; set; } = ""; public string Status { get; set; } = ""; public int Version { get; set; }
        public string Markdown { get; set; } = ""; public string Brief { get; set; } = ""; public string Quality { get; set; } = "";
        public int ThoughtMs { get; set; } public DateTimeOffset CreatedAt { get; set; }
    }
    public sealed class SteeringRow { public Guid Id { get; set; } public string Text { get; set; } = ""; public DateTimeOffset CreatedAt { get; set; } }
}
