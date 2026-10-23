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
    private sealed record Row(Guid Id, Guid? ArtifactId, string Name, string Kind, string Ext, string Mime, long SizeBytes, string Source, string Direction, DateTimeOffset CreatedAt, DateTimeOffset? PinnedAt, string? ThumbKey, string ThumbState, string DlpState, Guid? MessageId, Guid? PageId);
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
                resultGroups.Add(new Group(item.Key, item.Label, total, rows.Select(row => ToItem(row, id)).ToArray(), next));
            }
            return Results.Json(new { pinned = pinned.Select(row => ToItem(row, id)), groups = resultGroups });
        });

        app.MapGet("/api/bots/{id:guid}/library/{item:guid}/thumb", async (HttpContext ctx, Guid id, Guid item, CancellationToken ct) =>
        {
            var owner = await Routes.RequireUser(ctx, platform);
            if (owner == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var row = await conn.QuerySingleOrDefaultAsync<(string? Key, string State, string Sha)>("SELECT li.thumb_key,li.thumb_state,a.sha256 FROM library_items li JOIN bots b ON b.id=li.bot_id LEFT JOIN artifacts a ON a.id=li.artifact_id WHERE li.id=@item AND li.bot_id=@bot AND b.owner_id=@owner AND li.deleted_at IS NULL", new { item, bot = id, owner });
            if (row.State != "ready" || string.IsNullOrEmpty(row.Key)) return Results.NotFound();
            using var obj = await platform.S3.GetObjectAsync(platform.Bucket, row.Key, ct);
            ctx.Response.ContentType = "image/webp";
            ctx.Response.Headers.CacheControl = "private, max-age=31536000, immutable";
            ctx.Response.Headers.ETag = $"\"{row.Sha}\"";
            await obj.ResponseStream.CopyToAsync(ctx.Response.Body, ct);
            return Results.Empty;
        });

        app.MapGet("/api/bots/{id:guid}/library/{item:guid}/content", async (HttpContext ctx, Guid id, Guid item, bool? inline, bool? confirm, CancellationToken ct) =>
        {
            var owner = await Routes.RequireUser(ctx, platform);
            if (owner == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var row = await conn.QuerySingleOrDefaultAsync<(string Name, string Ext, string Kind, string Sha, string Dlp, string Key, long Size, Guid? Artifact)>("SELECT li.name,li.ext,li.kind,li.sha256,li.dlp_state,a.object_key,a.size_bytes,li.artifact_id FROM library_items li JOIN bots b ON b.id=li.bot_id LEFT JOIN artifacts a ON a.id=li.artifact_id WHERE li.id=@item AND li.bot_id=@bot AND b.owner_id=@owner AND li.deleted_at IS NULL", new { item, bot = id, owner });
            if (string.IsNullOrEmpty(row.Key) || row.Artifact == null) return Results.NotFound();
            if (row.Dlp == "redacted" && inline != true && confirm != true) return Results.Json(new { error = "confirmation_required" }, statusCode: 409);
            var mime = LibraryKinds.ContentMime(row.Ext, row.Kind);
            var inlineSafe = inline == true && LibraryKinds.InlineSafe(row.Ext, row.Kind);
            var start = 0L; var end = row.Size - 1;
            var range = ctx.Request.Headers.Range.ToString();
            var partial = false;
            if (!string.IsNullOrEmpty(range) && range.StartsWith("bytes=", StringComparison.Ordinal) && !range.Contains(','))
            {
                var parts = range[6..].Split('-', 2);
                if (long.TryParse(parts[0], out var first) && first >= 0 && first < row.Size)
                {
                    start = first; if (parts.Length > 1 && long.TryParse(parts[1], out var last)) end = Math.Clamp(last, start, row.Size - 1); else end = row.Size - 1;
                    partial = true;
                }
                else if (string.IsNullOrEmpty(parts[0]) && parts.Length > 1 && long.TryParse(parts[1], out var suffix) && suffix > 0)
                { start = Math.Max(0, row.Size - suffix); end = row.Size - 1; partial = true; }
                else { ctx.Response.StatusCode = 416; ctx.Response.Headers["Content-Range"] = $"bytes */{row.Size}"; return Results.Empty; }
            }
            if (row.Dlp == "redacted" && inline == true && row.Size <= 2_000_000)
            {
                using var stored = await platform.S3.GetObjectAsync(platform.Bucket, row.Key, ct);
                using var buffer = new MemoryStream(); await stored.ResponseStream.CopyToAsync(buffer, ct);
                var clean = Dlp.Redact(Encoding.UTF8.GetString(buffer.ToArray()));
                var bytes = Encoding.UTF8.GetBytes(clean);
                start = 0; end = bytes.LongLength - 1; partial = false;
                if (!string.IsNullOrEmpty(range))
                {
                    var parts = range.StartsWith("bytes=", StringComparison.Ordinal) && !range.Contains(',') ? range[6..].Split('-', 2) : Array.Empty<string>();
                    if (parts.Length == 2 && long.TryParse(parts[0], out var first) && first >= 0 && first < bytes.LongLength)
                    { start = first; end = long.TryParse(parts[1], out var last) ? Math.Clamp(last, start, bytes.LongLength - 1) : bytes.LongLength - 1; partial = true; }
                    else if (parts.Length == 2 && parts[0].Length == 0 && long.TryParse(parts[1], out var suffix) && suffix > 0)
                    { start = Math.Max(0, bytes.LongLength - suffix); end = bytes.LongLength - 1; partial = true; }
                    else { ctx.Response.StatusCode = 416; ctx.Response.Headers["Content-Range"] = $"bytes */{bytes.LongLength}"; return Results.Empty; }
                }
                ctx.Response.StatusCode = partial ? 206 : 200;
                ctx.Response.ContentType = "text/plain; charset=utf-8"; ctx.Response.ContentLength = end - start + 1;
                ctx.Response.Headers.ETag = $"\"{row.Sha}\""; ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";
                ctx.Response.Headers["Content-Security-Policy"] = "sandbox; default-src 'none'";
                ctx.Response.Headers["Content-Disposition"] = "inline";
                if (partial) ctx.Response.Headers["Content-Range"] = $"bytes {start}-{end}/{bytes.LongLength}";
                await ctx.Response.Body.WriteAsync(bytes.AsMemory((int)start, (int)(end - start + 1)), ct); return Results.Empty;
            }
            var request = new Amazon.S3.Model.GetObjectRequest { BucketName = platform.Bucket, Key = row.Key };
            if (partial) request.ByteRange = new Amazon.S3.Model.ByteRange(start, end);
            using var obj = await platform.S3.GetObjectAsync(request, ct);
            ctx.Response.StatusCode = partial ? 206 : 200;
            ctx.Response.ContentType = mime;
            ctx.Response.ContentLength = end - start + 1;
            ctx.Response.Headers.ETag = $"\"{row.Sha}\"";
            ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";
            ctx.Response.Headers["Content-Security-Policy"] = "sandbox; default-src 'none'";
            ctx.Response.Headers["Content-Disposition"] = $"{(inlineSafe ? "inline" : "attachment")}; filename*=UTF-8''{Uri.EscapeDataString(row.Name)}";
            if (partial) ctx.Response.Headers["Content-Range"] = $"bytes {start}-{end}/{row.Size}";
            await obj.ResponseStream.CopyToAsync(ctx.Response.Body, ct);
            if (ctx.Response.StatusCode is 200 or 206 && ctx.Request.Method == "GET") await platform.Audit("user:" + owner, "library.downloaded", id, null, new { itemId = item });
            return Results.Empty;
        });

        app.MapPost("/api/bots/{id:guid}/library/{item:guid}/pin", async (HttpContext ctx, Guid id, Guid item, CancellationToken ct) =>
            await SetPinned(ctx, platform, id, item, true, ct));
        app.MapDelete("/api/bots/{id:guid}/library/{item:guid}/pin", async (HttpContext ctx, Guid id, Guid item, CancellationToken ct) =>
            await SetPinned(ctx, platform, id, item, false, ct));
        app.MapDelete("/api/bots/{id:guid}/library/{item:guid}", async (HttpContext ctx, Guid id, Guid item, CancellationToken ct) =>
        {
            var owner = await Routes.RequireUser(ctx, platform);
            if (owner == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var name = await conn.ExecuteScalarAsync<string?>("UPDATE library_items li SET deleted_at=now() FROM bots b WHERE li.id=@item AND li.bot_id=@bot AND b.id=li.bot_id AND b.owner_id=@owner AND li.deleted_at IS NULL RETURNING li.name", new { item, bot = id, owner });
            if (name == null) return Results.NotFound();
            await platform.Audit("user:" + owner, "library.deleted", id, null, new { itemId = item, name });
            return Results.Json(new { ok = true });
        });
    }

    private static async Task<List<Row>> Fetch(System.Data.IDbConnection conn, Guid bot, int limit, string where, DateTimeOffset? from, DateTimeOffset? to, (DateTimeOffset At, Guid Id)? cursor, bool pinned, string visibility)
    {
        var cursorSql = cursor == null ? "" : " AND (created_at,id) < (@cursorAt,@cursorId)";
        var order = pinned ? "pinned_at DESC,created_at DESC,id DESC" : "created_at DESC,id DESC";
        var sql = $"SELECT id,artifact_id,name,kind,ext,mime,size_bytes,source,direction,created_at,pinned_at,thumb_key,thumb_state,dlp_state,message_id,page_id FROM library_items WHERE bot_id=@bot AND deleted_at IS NULL AND {visibility} AND {where}{cursorSql} ORDER BY {order} LIMIT @limit";
        return (await conn.QueryAsync<Row>(sql, new { bot, from, to, cursorAt = cursor?.At, cursorId = cursor?.Id, limit })).AsList();
    }

    private static object ToItem(Row row, Guid bot) => new { id = row.Id, name = row.Name, kind = row.Kind, ext = row.Ext, mime = row.Mime, sizeBytes = row.SizeBytes, source = row.Source, direction = row.Direction, createdAt = row.CreatedAt, messageId = row.MessageId, pageId = row.PageId, dlpState = row.DlpState, thumbState = row.ThumbState, thumbUrl = row.ThumbState == "ready" ? $"/api/bots/{bot}/library/{row.Id}/thumb" : null, pinned = row.PinnedAt != null };

    private static async Task<IResult> SetPinned(HttpContext ctx, Platform platform, Guid bot, Guid item, bool pinned, CancellationToken ct)
    {
        var owner = await Routes.RequireUser(ctx, platform);
        if (owner == null) return Results.Unauthorized();
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var changed = await conn.ExecuteAsync("UPDATE library_items li SET pinned_at=CASE WHEN @pinned THEN now() ELSE NULL END FROM bots b WHERE li.id=@item AND li.bot_id=@bot AND b.id=li.bot_id AND b.owner_id=@owner AND li.deleted_at IS NULL", new { item, bot, owner, pinned });
        if (changed == 0) return Results.NotFound();
        await platform.Audit("user:" + owner, pinned ? "library.pinned" : "library.unpinned", bot, null, new { itemId = item });
        return Results.Json(new { ok = true, pinned });
    }
}
