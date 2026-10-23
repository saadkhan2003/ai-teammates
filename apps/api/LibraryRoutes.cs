using System.Text;
using Dapper;

namespace Teammates.Api;

public static class LibraryTime
{
    public static (DateTimeOffset Today, DateTimeOffset Week) Boundaries(DateTimeOffset now, TimeZoneInfo zone)
    {
        var local = TimeZoneInfo.ConvertTime(now, zone);
        var localToday = DateTime.SpecifyKind(local.Date, DateTimeKind.Unspecified);
        var today = new DateTimeOffset(TimeZoneInfo.ConvertTimeToUtc(localToday, zone), TimeSpan.Zero);
        var weekLocal = localToday.AddDays(-6);
        var week = new DateTimeOffset(TimeZoneInfo.ConvertTimeToUtc(weekLocal, zone), TimeSpan.Zero);
        return (today, week);
    }

    public static string Cursor(DateTimeOffset createdAt, Guid id)
    {
        var raw = $"{createdAt.ToUniversalTime():O}|{id:D}";
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(raw)).TrimEnd('=').Replace('+','-').Replace('/','_');
    }

    public static bool TryCursor(string? cursor, out DateTimeOffset createdAt, out Guid id)
    {
        createdAt = default; id = default;
        if (string.IsNullOrWhiteSpace(cursor)) return false;
        try
        {
            var value = cursor.Replace('-','+').Replace('_','/');
            value += new string('=', (4 - value.Length % 4) % 4);
            var parts = Encoding.UTF8.GetString(Convert.FromBase64String(value)).Split('|');
            return parts.Length == 2 && DateTimeOffset.TryParse(parts[0], out createdAt) && Guid.TryParse(parts[1], out id);
        }
        catch (FormatException) { return false; }
    }
}

public static class LibraryRoutes
{
    private sealed record Row(Guid Id, Guid? ArtifactId, string Name, string Kind, string Ext, string Mime, long SizeBytes, string Source, string Direction, DateTimeOffset CreatedAt, DateTimeOffset? PinnedAt, string? ThumbKey);
    private sealed record Group(string Key, string Label, long Total, IReadOnlyList<object> Items, string? NextCursor);
    private static readonly (string Key, string Label)[] Groups = [("today", "Today"), ("week", "This week"), ("older", "Older")];

    public static void Map(WebApplication app, Platform platform)
    {
        app.MapGet("/api/bots/{id:guid}/library", async (HttpContext ctx, Guid id, int? limit, string? cursor, string? group, string? kind) =>
        {
            var owner = await Routes.RequireUser(ctx, platform);
            if (owner == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync(ctx.RequestAborted);
            var zoneName = await conn.ExecuteScalarAsync<string?>("SELECT u.timezone FROM users u JOIN bots b ON b.owner_id=u.id WHERE u.id=@owner AND b.id=@bot", new { owner, bot = id });
            if (zoneName == null) return Results.NotFound();
            if (!RoutineTime.TryZone(zoneName, out var zone)) zone = TimeZoneInfo.Utc;
            var now = DateTimeOffset.UtcNow;
            var (today, week) = LibraryTime.Boundaries(now, zone);
            var pageSize = Math.Clamp(limit ?? 5, 1, 50);
            var screenshotView = string.Equals(kind, "screenshots", StringComparison.OrdinalIgnoreCase);
            var visibility = screenshotView ? "source = 'screenshot'" : "source <> 'screenshot'";
            var selected = Groups.Where(g => group == null || string.Equals(group, g.Key, StringComparison.OrdinalIgnoreCase)).ToArray();
            if (selected.Length == 0) return Results.BadRequest(new { error = "invalid_group" });
            if (group != null && cursor != null && !LibraryTime.TryCursor(cursor, out _, out _)) return Results.BadRequest(new { error = "invalid_cursor" });

            var pinned = group == null
                ? await Fetch(conn, id, pageSize, "pinned_at IS NOT NULL", null, null, null, true, visibility)
                : [];
            var resultGroups = new List<Group>();
            foreach (var item in selected)
            {
                var (where, from, to) = item.Key switch
                {
                    "today" => ("created_at >= @from AND created_at <= @to", today, now),
                    "week" => ("created_at >= @from AND created_at < @to", week, today),
                    _ => ("created_at < @to", default(DateTimeOffset), week)
                };
                var total = await conn.ExecuteScalarAsync<long>($"SELECT count(*) FROM library_items WHERE bot_id=@bot AND deleted_at IS NULL AND {visibility} AND {where}", new { bot = id, from, to });
                DateTimeOffset? before = null; Guid? beforeId = null;
                if (group != null && cursor != null && LibraryTime.TryCursor(cursor, out var parsed, out var parsedId)) { before = parsed; beforeId = parsedId; }
                var rows = await Fetch(conn, id, pageSize + 1, where, from, to, before == null ? null : (before.Value, beforeId!.Value), false, visibility);
                var hasMore = rows.Count > pageSize;
                if (hasMore) rows.RemoveAt(rows.Count - 1);
                var next = hasMore && rows.Count > 0 ? LibraryTime.Cursor(rows[^1].CreatedAt, rows[^1].Id) : null;
                resultGroups.Add(new Group(item.Key, item.Label, total, rows.Select(ToItem).ToArray(), next));
            }
            return Results.Json(new { pinned = pinned.Select(ToItem), groups = resultGroups });
        });
    }

    private static async Task<List<Row>> Fetch(System.Data.IDbConnection conn, Guid bot, int limit, string where, DateTimeOffset? from, DateTimeOffset? to, (DateTimeOffset At, Guid Id)? cursor, bool pinned, string visibility)
    {
        var cursorSql = cursor == null ? "" : " AND (created_at,id) < (@cursorAt,@cursorId)";
        var order = pinned ? "pinned_at DESC,created_at DESC,id DESC" : "created_at DESC,id DESC";
        var sql = $"SELECT id,artifact_id,name,kind,ext,mime,size_bytes,source,direction,created_at,pinned_at,thumb_key FROM library_items WHERE bot_id=@bot AND deleted_at IS NULL AND {visibility} AND {where}{cursorSql} ORDER BY {order} LIMIT @limit";
        return (await conn.QueryAsync<Row>(sql, new { bot, from, to, cursorAt = cursor?.At, cursorId = cursor?.Id, limit })).AsList();
    }

    private static object ToItem(Row row) => new { id = row.Id, name = row.Name, kind = row.Kind, ext = row.Ext, mime = row.Mime, sizeBytes = row.SizeBytes, source = row.Source, direction = row.Direction, createdAt = row.CreatedAt, thumbUrl = row.Kind is "image" or "screenshots" && row.ArtifactId != null ? $"/api/artifacts/{row.Id}/download" : null, pinned = row.PinnedAt != null };
}
