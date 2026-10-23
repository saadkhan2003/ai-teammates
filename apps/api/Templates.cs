using System.Text.Json;
using System.Text.RegularExpressions;
using Dapper;
using Npgsql;

namespace Teammates.Api;

public sealed record TemplateRoutine(string Cron, string Title, string Instruction);
public sealed record BotTemplate(int SchemaVersion, string Name, string Role, string Instructions, string AvatarShape, string AvatarColor, IReadOnlyList<TemplateRoutine> Routines, IReadOnlyList<string> PluginIds);

public static class Templates
{
    public const int MaxJsonBytes = 8192;
    private static readonly string[] Fields = ["schemaVersion", "name", "role", "instructions", "avatarShape", "avatarColor", "routines", "pluginIds"];

    public static (BotTemplate? Template, string? Error) Clean(BotTemplate source)
    {
        if (source.SchemaVersion != 1) return (null, "Unsupported template version.");
        if (source.Name.Length is < 1 or > 80 || source.Role.Length > 120 || source.Instructions.Length > 4000) return (null, "Template field is too long.");
        if (Dlp.HasStrict(source.Instructions) || source.Instructions.Contains("secret://", StringComparison.OrdinalIgnoreCase)) return (null, "Instructions contain a secret-shaped value and cannot be shared.");
        if (source.AvatarShape.Length > 0 && !Regex.IsMatch(source.AvatarShape, @"^blob(1[0-5]|[1-9])$")) return (null, "Invalid avatar shape.");
        if (source.AvatarColor.Length > 0 && !Regex.IsMatch(source.AvatarColor, @"^#[0-9a-fA-F]{6}$")) return (null, "Invalid avatar color.");
        if (source.Routines.Count > 20 || source.PluginIds.Count > 30) return (null, "Too many template entries.");
        foreach (var routine in source.Routines)
        {
            var fields = routine.Cron.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            var ranges = new[] { (0, 59), (0, 23), (1, 31), (1, 12), (0, 7) };
            if (fields.Length != 5 || fields.Where((field, index) => !ValidCronField(field, ranges[index].Item1, ranges[index].Item2)).Any()) return (null, "Invalid cron schedule.");
            if (routine.Title.Length > 100 || routine.Instruction.Length > 1000 || Dlp.HasStrict(routine.Instruction) || routine.Instruction.Contains("secret://", StringComparison.OrdinalIgnoreCase)) return (null, "Routine contains invalid or secret-shaped content.");
        }
        var clean = source with { PluginIds = source.PluginIds.Where(id => Regex.IsMatch(id, @"^[a-zA-Z0-9._-]{1,100}$")).Distinct().Take(30).ToArray() };
        return (clean, null);
    }

    private static bool ValidCronField(string field, int min, int max)
    {
        foreach (var part in field.Split(','))
        {
            if (part == "*") continue;
            if (part.StartsWith("*/", StringComparison.Ordinal))
            {
                if (!int.TryParse(part[2..], out var step) || step < 1 || step > max) return false;
                continue;
            }
            var span = part.Split('-');
            if (span.Length is < 1 or > 2 || !int.TryParse(span[0], out var start) || start < min || start > max) return false;
            if (span.Length == 2 && (!int.TryParse(span[1], out var end) || end < start || end > max)) return false;
        }
        return true;
    }

    public static (BotTemplate? Template, string? Error) Parse(JsonElement json)
    {
        if (json.ValueKind != JsonValueKind.Object) return (null, "Template must be a JSON object.");
        foreach (var prop in json.EnumerateObject()) if (!Fields.Contains(prop.Name, StringComparer.Ordinal)) return (null, "Unknown template field.");
        try
        {
            var template = JsonSerializer.Deserialize<BotTemplate>(json.GetRawText(), new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            return template == null ? (null, "Invalid template.") : Clean(template);
        }
        catch (JsonException) { return (null, "Invalid template."); }
    }

    public static void Map(WebApplication app, Platform platform)
    {
        app.MapPost("/api/templates/preview", async (HttpContext ctx, JsonElement body) =>
        {
            if (await Routes.RequireUser(ctx, platform) == null) return Results.Unauthorized();
            if (JsonSerializer.SerializeToUtf8Bytes(body).Length > MaxJsonBytes) return Results.BadRequest(new { error = "Template is too large." });
            var (template, error) = Parse(body);
            return template == null ? Results.BadRequest(new { error }) : Results.Json(template);
        });

        app.MapPost("/api/bots/{id:guid}/template", async (HttpContext ctx, Guid id) =>
        {
            var user = await Routes.RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Routes.Owns(platform, user.Value, id)) return Results.NotFound();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var bot = await conn.QuerySingleAsync<(string Name, string Role, string Instructions, string AvatarShape, string AvatarColor)>("SELECT name, role, instructions, avatar_shape, avatar_color FROM bots WHERE id=@id", new { id });
            var routines = (await conn.QueryAsync<TemplateRoutine>("SELECT cron, name AS title, instruction FROM routines WHERE bot_id=@id ORDER BY created_at LIMIT 20", new { id })).ToArray();
            var plugins = (await conn.QueryAsync<string>("SELECT pc.id FROM plugins p JOIN plugin_catalog pc ON pc.id=p.catalog_id WHERE p.bot_id=@id AND p.status='installed' AND pc.id IS NOT NULL", new { id })).ToArray();
            var (clean, error) = Clean(new BotTemplate(1, bot.Name, bot.Role, bot.Instructions, bot.AvatarShape, bot.AvatarColor, routines, plugins));
            if (clean == null) return Results.BadRequest(new { error });
            var json = JsonSerializer.Serialize(clean);
            if (System.Text.Encoding.UTF8.GetByteCount(json) > MaxJsonBytes) return Results.BadRequest(new { error = "Template is too large." });
            await platform.Audit(user.Value.ToString(), "bot.template_exported", id, null, new { schemaVersion = 1 });
            return Results.Json(new { template = json });
        });

        app.MapPost("/api/bots/{id:guid}/clone", async (HttpContext ctx, Guid id, CancellationToken ct) =>
        {
            var user = await Routes.RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!await Routes.Owns(platform, user.Value, id)) return Results.NotFound();
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            await using var tx = await conn.BeginTransactionAsync(ct);
            var source = await conn.QuerySingleAsync<(string Name, string Role, string Instructions, string AvatarShape, string AvatarColor)>("SELECT name, role, instructions, avatar_shape, avatar_color FROM bots WHERE id=@id", new { id }, tx);
            var quota = await conn.QuerySingleOrDefaultAsync<int?>("SELECT max_bots FROM user_quotas WHERE user_id=@user", new { user }, tx);
            var count = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM bots WHERE owner_id=@user", new { user }, tx);
            if (count >= (quota.GetValueOrDefault() == 0 ? 8 : quota!.Value)) return Results.Json(new { error = "quota", reason = "max_bots" }, statusCode: 403);
            var cloneId = Guid.NewGuid(); var conversation = Guid.NewGuid(); var token = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
            var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(token))).ToLowerInvariant();
            var name = (source.Name.Length > 74 ? source.Name[..74] : source.Name) + " copy";
            await conn.ExecuteAsync("INSERT INTO bots (id, owner_id, name, role, instructions, token_hash, avatar_shape, avatar_color) VALUES (@cloneId, @user, @name, @role, @instructions, @hash, @avatarShape, @avatarColor)", new { cloneId, user, name, source.Role, source.Instructions, hash, avatarShape = source.AvatarShape, avatarColor = source.AvatarColor }, tx);
            await conn.ExecuteAsync("INSERT INTO conversations (id, bot_id, title) VALUES (@conversation, @cloneId, 'Desk')", new { conversation, cloneId }, tx);
            await conn.ExecuteAsync("INSERT INTO control_locks (bot_id, holder, epoch) VALUES (@cloneId, 'agent', 1)", new { cloneId }, tx);
            await conn.ExecuteAsync("INSERT INTO routines (bot_id, name, cron, timezone, instruction, enabled) SELECT @cloneId, name, cron, timezone, instruction, false FROM routines WHERE bot_id=@id", new { cloneId, id }, tx);
            await tx.CommitAsync(ct);
            await platform.Audit(user.Value.ToString(), "bot.cloned", cloneId, null, new { sourceBotId = id });
            return Results.Json(new { id = cloneId, name, conversationId = conversation });
        });
    }
}
