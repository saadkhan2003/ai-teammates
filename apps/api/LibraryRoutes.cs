using System.Text;
using System.Security.Cryptography;
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

public static class LibraryFilters
{
    public static string? TypePredicate(string? type, string prefix = "") => type?.Trim().ToLowerInvariant() switch
    {
        "images" => $"{prefix}kind IN ('image','screenshots')",
        "documents" => $"{prefix}kind IN ('text','markdown','doc','unknown')",
        "spreadsheets" => $"{prefix}kind = 'sheet'",
        "pdfs" => $"{prefix}kind = 'pdf'",
        "video" => $"{prefix}kind = 'video'",
        "code" => $"{prefix}kind = 'code'",
        "screenshots" => $"{prefix}source = 'screenshot'",
        "pages" => $"{prefix}kind = 'page'",
        null or "" or "all" => "TRUE",
        _ => null
    };
}

public static class LibraryShareTokens
{
    public static string Create() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    public static string Hash(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();
    public static bool Matches(string token, string storedHash)
    {
        if (token.Length != 64 || storedHash.Length != 64 || !token.All(Uri.IsHexDigit) || !storedHash.All(Uri.IsHexDigit)) return false;
        return CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(token.ToLowerInvariant())), Convert.FromHexString(storedHash));
    }
}

public static class LibraryContentRange
{
    public static (long Start, long End, bool Partial, bool Valid) Resolve(string? header, long size)
    {
        var start = 0L;
        var end = Math.Max(0, size - 1);
        if (string.IsNullOrEmpty(header)) return (start, end, false, size > 0);
        if (!header.StartsWith("bytes=", StringComparison.Ordinal) || header.Contains(',')) return (start, end, false, false);
        var parts = header[6..].Split('-', 2);
        if (long.TryParse(parts[0], out var first) && first >= 0 && first < size)
        {
            start = first;
            end = parts.Length > 1 && long.TryParse(parts[1], out var last) ? Math.Clamp(last, start, size - 1) : size - 1;
            return (start, end, true, true);
        }
        if (parts[0].Length == 0 && parts.Length > 1 && long.TryParse(parts[1], out var suffix) && suffix > 0 && size > 0)
        {
            start = Math.Max(0, size - suffix);
            return (start, size - 1, true, true);
        }
        return (start, end, false, false);
    }
}

public static class LibraryRoutes
{
    private sealed record Row(Guid Id, Guid? ArtifactId, string Name, string Kind, string Ext, string Mime, long SizeBytes, string Source, string Direction, DateTime CreatedAtRaw, DateTime? PinnedAtRaw, string? ThumbKey, string ThumbState, string DlpState, Guid? MessageId, Guid? PageId)
    {
        public DateTimeOffset CreatedAt => new(DateTime.SpecifyKind(CreatedAtRaw, DateTimeKind.Utc));
        public DateTimeOffset? PinnedAt => PinnedAtRaw is { } p ? new DateTimeOffset(DateTime.SpecifyKind(p, DateTimeKind.Utc)) : null;
    }
    private sealed record Group(string Key, string Label, long Total, IReadOnlyList<object> Items, string? NextCursor);
    private static readonly (string Key, string Label)[] Groups = [("today", "Today"), ("week", "This week"), ("older", "Older")];

    public static void Map(WebApplication app, Platform platform)
    {
        app.MapGet("/api/bots/{id:guid}/library", async (HttpContext ctx, Guid id, int? limit, string? cursor, string? group, string? kind, string? q, string? type, string? direction) =>
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
            var screenshotView = string.Equals(type, "screenshots", StringComparison.OrdinalIgnoreCase) || string.Equals(kind, "screenshots", StringComparison.OrdinalIgnoreCase);
            var visibility = screenshotView ? "source = 'screenshot'" : "source <> 'screenshot'";
            var typeFilter = type?.Trim().ToLowerInvariant();
            var kindFilter = LibraryFilters.TypePredicate(typeFilter);
            if (kindFilter == null) return Results.BadRequest(new { error = "invalid_type" });
            var filters = $" AND ({kindFilter}) AND (@direction IS NULL OR direction=@direction)";
            if (direction is not null && direction is not ("in" or "out")) return Results.BadRequest(new { error = "invalid_direction" });
            if (!string.IsNullOrWhiteSpace(q))
            {
                var query = q.Trim();
                var searchVisibility = typeFilter == "screenshots" ? "li.source='screenshot'" : "li.source<>'screenshot'";
                var searchRows = await conn.QueryAsync<Row>($"""
                    SELECT li.id,li.artifact_id,li.name,li.kind,li.ext,li.mime,li.size_bytes,li.source,li.direction,
                           li.created_at AS created_at_raw,li.pinned_at AS pinned_at_raw,li.thumb_key,li.thumb_state,
                           li.dlp_state,li.message_id,li.page_id
                    FROM library_items li JOIN bots b ON b.id=li.bot_id
                    WHERE li.bot_id=@bot AND b.owner_id=@owner AND li.deleted_at IS NULL
                      AND {searchVisibility} AND ({LibraryFilters.TypePredicate(typeFilter, "li.")})
                      AND li.name ILIKE @prefix ESCAPE E'\\'
                      AND (@direction IS NULL OR li.direction=@direction)
                    ORDER BY li.created_at DESC,li.id DESC LIMIT @limit
                    """, new { bot = id, owner, prefix = EscapeLike(query) + "%", direction, limit = Math.Clamp(limit ?? 50, 1, 50) });
                return Results.Json(new { items = searchRows.Select(row => ToItem(row, id)) });
            }
            var selected = Groups.Where(g => group == null || string.Equals(group, g.Key, StringComparison.OrdinalIgnoreCase)).ToArray();
            if (selected.Length == 0) return Results.BadRequest(new { error = "invalid_group" });
            if (group != null && cursor != null && !LibraryTime.TryCursor(cursor, out _, out _)) return Results.BadRequest(new { error = "invalid_cursor" });

            var pinned = group == null
                ? await Fetch(conn, id, pageSize, "pinned_at IS NOT NULL", null, null, null, true, visibility, filters, direction)
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
                var total = await conn.ExecuteScalarAsync<long>($"SELECT count(*) FROM library_items WHERE bot_id=@bot AND deleted_at IS NULL AND {visibility} AND {where}{filters}", new { bot = id, from, to, direction });
                DateTimeOffset? before = null; Guid? beforeId = null;
                if (group != null && cursor != null && LibraryTime.TryCursor(cursor, out var parsed, out var parsedId)) { before = parsed; beforeId = parsedId; }
                var rows = await Fetch(conn, id, pageSize + 1, where, from, to, before == null ? null : (before.Value, beforeId!.Value), false, visibility, filters, direction);
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

        app.MapGet("/api/bots/{id:guid}/library/{item:guid}/content", async (HttpContext ctx, Guid id, Guid item, string? inline, string? confirm, CancellationToken ct) =>
        {
            var wantInline = inline is "1" or "true"; var wantConfirm = confirm is "1" or "true";
            var owner = await Routes.RequireUser(ctx, platform);
            if (owner == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var row = await conn.QuerySingleOrDefaultAsync<(string Name, string Ext, string Kind, string Sha, string Dlp, string Key, long Size, Guid? Artifact)>("SELECT li.name,li.ext,li.kind,li.sha256,li.dlp_state,a.object_key,a.size_bytes,li.artifact_id FROM library_items li JOIN bots b ON b.id=li.bot_id LEFT JOIN artifacts a ON a.id=li.artifact_id WHERE li.id=@item AND li.bot_id=@bot AND b.owner_id=@owner AND li.deleted_at IS NULL", new { item, bot = id, owner });
            if (string.IsNullOrEmpty(row.Key) || row.Artifact == null) return Results.NotFound();
            if (row.Dlp == "redacted" && !wantInline && !wantConfirm) return Results.Json(new { error = "confirmation_required" }, statusCode: 409);
            var mime = LibraryKinds.ContentMime(row.Ext, row.Kind);
            var inlineSafe = wantInline && LibraryKinds.InlineSafe(row.Ext, row.Kind);
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
            if (row.Dlp == "redacted" && wantInline && row.Size <= 2_000_000)
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

        app.MapPost("/api/bots/{id:guid}/library/{item:guid}/share", async (HttpContext ctx, Guid id, Guid item, ShareRequest request, CancellationToken ct) =>
        {
            var owner = await Routes.RequireUser(ctx, platform);
            if (owner == null) return Results.Unauthorized();
            if (request.ExpiresInDays is < 1 or > 30) return Results.BadRequest(new { error = "invalid_expiry" });
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var safe = await conn.QuerySingleOrDefaultAsync<(string Name, string Dlp, string? Key, long Size, string Kind)>("SELECT li.name,li.dlp_state,a.object_key AS key,li.size_bytes AS size,li.kind FROM library_items li JOIN bots b ON b.id=li.bot_id LEFT JOIN artifacts a ON a.id=li.artifact_id WHERE li.id=@item AND li.bot_id=@bot AND b.owner_id=@owner AND li.deleted_at IS NULL", new { item, bot = id, owner });
            if (safe.Name == null || safe.Dlp == "blocked" || LibraryKinds.IsDeniedName(safe.Name)) return Results.NotFound();
            if (safe.Key != null && safe.Size <= 2_000_000 && safe.Kind is "text" or "markdown" or "code" or "sheet")
            {
                using var stored = await platform.S3.GetObjectAsync(platform.Bucket, safe.Key, ct);
                using var memory = new MemoryStream(); await stored.ResponseStream.CopyToAsync(memory, ct);
                if (Dlp.IsHealthOrFinance(Dlp.Redact(Encoding.UTF8.GetString(memory.ToArray())))) return Results.Conflict(new { error = "share_confirmation_required" });
            }
            var token = LibraryShareTokens.Create();
            var hash = LibraryShareTokens.Hash(token);
            await conn.ExecuteAsync("INSERT INTO library_shares(token_hash,item_id,bot_id,created_by,expires_at) VALUES(@hash,@item,@bot,@owner,now()+(@days * interval '1 day'))", new { hash, item, bot = id, owner, days = request.ExpiresInDays });
            await platform.Audit("user:" + owner, "library.share_created", id, null, new { itemId = item, expiresInDays = request.ExpiresInDays });
            return Results.Json(new { url = $"{ctx.Request.Scheme}://{ctx.Request.Host}/s/{token}" });
        });

        app.MapGet("/api/bots/{id:guid}/library/{item:guid}/share", async (HttpContext ctx, Guid id, Guid item, CancellationToken ct) =>
        {
            var owner = await Routes.RequireUser(ctx, platform);
            if (owner == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var exists = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM library_items li JOIN bots b ON b.id=li.bot_id WHERE li.id=@item AND li.bot_id=@bot AND b.owner_id=@owner AND li.deleted_at IS NULL", new { item, bot = id, owner });
            if (exists == 0) return Results.NotFound();
            var shares = await conn.QueryAsync("SELECT id,created_at AS \"createdAt\",expires_at AS \"expiresAt\",revoked_at AS \"revokedAt\" FROM library_shares WHERE item_id=@item AND bot_id=@bot ORDER BY created_at DESC", new { item, bot = id });
            return Results.Json(new { shares });
        });

        app.MapDelete("/api/bots/{id:guid}/library/{item:guid}/share/{share:guid}", async (HttpContext ctx, Guid id, Guid item, Guid share, CancellationToken ct) =>
        {
            var owner = await Routes.RequireUser(ctx, platform);
            if (owner == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var changed = await conn.ExecuteAsync("UPDATE library_shares s SET revoked_at=now() FROM bots b WHERE s.id=@share AND s.item_id=@item AND s.bot_id=@bot AND b.id=s.bot_id AND b.owner_id=@owner AND s.revoked_at IS NULL", new { share, item, bot = id, owner });
            if (changed == 0) return Results.NotFound();
            await platform.Audit("user:" + owner, "library.share_revoked", id, null, new { itemId = item, shareId = share });
            return Results.Json(new { ok = true });
        });

        app.MapGet("/api/public/library/{token}", async (HttpContext ctx, string token, CancellationToken ct) =>
        {
            if (RateLimited(ctx, platform)) return Results.StatusCode(StatusCodes.Status429TooManyRequests);
            var share = await PublicShare(platform, token, ct);
            if (share == null) return Results.NotFound();
            SetPublicHeaders(ctx);
            return Results.Json(new { name = share.Name, kind = share.Kind, ext = share.Ext, mime = share.Mime, sizeBytes = share.Size, createdAt = share.CreatedAt, dlpState = share.Dlp, contentUrl = $"/api/public/library/{token}/content" });
        });

        app.MapGet("/api/public/library/{token}/content", async (HttpContext ctx, string token, CancellationToken ct) =>
        {
            if (RateLimited(ctx, platform)) return Results.StatusCode(StatusCodes.Status429TooManyRequests);
            var share = await PublicShare(platform, token, ct);
            if (share == null || share.Artifact == null || share.Key == null) return Results.NotFound();
            SetPublicHeaders(ctx);
            var inline = LibraryKinds.InlineSafe(share.Ext, share.Kind);
            if (share.Dlp == "redacted")
            {
                if (share.Size > 2_000_000 || share.Kind is not ("text" or "markdown" or "code" or "sheet")) return Results.NotFound();
                using var stored = await platform.S3.GetObjectAsync(platform.Bucket, share.Key, ct);
                using var memory = new MemoryStream(); await stored.ResponseStream.CopyToAsync(memory, ct);
                var bytes = Encoding.UTF8.GetBytes(Dlp.Redact(Encoding.UTF8.GetString(memory.ToArray())));
                var (start, end, partial, valid) = LibraryContentRange.Resolve(ctx.Request.Headers.Range.ToString(), bytes.LongLength);
                if (!valid) { ctx.Response.StatusCode = 416; ctx.Response.Headers["Content-Range"] = $"bytes */{bytes.LongLength}"; return Results.Empty; }
                ctx.Response.StatusCode = partial ? 206 : 200;
                ctx.Response.ContentType = "text/plain; charset=utf-8";
                ctx.Response.ContentLength = end - start + 1;
                ctx.Response.Headers["Content-Disposition"] = "inline";
                ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";
                ctx.Response.Headers["Content-Security-Policy"] = "sandbox; default-src 'none'";
                ctx.Response.Headers["Accept-Ranges"] = "bytes";
                ctx.Response.Headers.ETag = $"\"{share.Sha}\"";
                if (partial) ctx.Response.Headers["Content-Range"] = $"bytes {start}-{end}/{bytes.LongLength}";
                await ctx.Response.Body.WriteAsync(bytes.AsMemory((int)start, (int)(end - start + 1)), ct);
                await platform.Audit("public:share", "library.shared_downloaded", share.BotId, null, new { itemId = share.ItemId });
                return Results.Empty;
            }
            var (rangeStart, rangeEnd, isPartial, rangeValid) = LibraryContentRange.Resolve(ctx.Request.Headers.Range.ToString(), share.Size);
            if (!rangeValid) { ctx.Response.StatusCode = 416; ctx.Response.Headers["Content-Range"] = $"bytes */{share.Size}"; return Results.Empty; }
            var get = new Amazon.S3.Model.GetObjectRequest { BucketName = platform.Bucket, Key = share.Key };
            if (isPartial) get.ByteRange = new Amazon.S3.Model.ByteRange(rangeStart, rangeEnd);
            using var obj = await platform.S3.GetObjectAsync(get, ct);
            ctx.Response.StatusCode = isPartial ? 206 : 200;
            ctx.Response.ContentType = LibraryKinds.ContentMime(share.Ext, share.Kind);
            ctx.Response.ContentLength = rangeEnd - rangeStart + 1;
            ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";
            ctx.Response.Headers["Content-Security-Policy"] = "sandbox; default-src 'none'";
            ctx.Response.Headers["Accept-Ranges"] = "bytes";
            ctx.Response.Headers.ETag = $"\"{share.Sha}\"";
            if (isPartial) ctx.Response.Headers["Content-Range"] = $"bytes {rangeStart}-{rangeEnd}/{share.Size}";
            ctx.Response.Headers["Content-Disposition"] = $"{(inline ? "inline" : "attachment")}; filename*=UTF-8''{Uri.EscapeDataString(share.Name)}";
            await obj.ResponseStream.CopyToAsync(ctx.Response.Body, ct);
            await platform.Audit("public:share", "library.shared_downloaded", share.BotId, null, new { itemId = share.ItemId });
            return Results.Empty;
        });

        app.MapGet("/s/{token}", async (HttpContext ctx, string token, CancellationToken ct) =>
        {
            if (RateLimited(ctx, platform)) return Results.StatusCode(StatusCodes.Status429TooManyRequests);
            var share = await PublicShare(platform, token, ct);
            if (share == null) return Results.NotFound();
            SetPublicHeaders(ctx);
            return Results.Json(new { name = share.Name, kind = share.Kind, mime = share.Mime, contentUrl = $"/api/public/library/{token}/content" });
        });
    }

    public sealed record ShareRequest(int ExpiresInDays = 7);
    private sealed record ShareRow(Guid ItemId, Guid BotId, string Name, string Kind, string Ext, string Mime, long Size, string Sha, string Dlp, Guid? Artifact, string? Key, DateTime CreatedAtRaw, string TokenHash)
    { public DateTimeOffset CreatedAt => new(DateTime.SpecifyKind(CreatedAtRaw, DateTimeKind.Utc)); }
    private static bool RateLimited(HttpContext ctx, Platform platform)
    {
        var ip = ClientAddress.From(ctx);
        if (platform.PublicShareLimits.IsBlocked(ip, DateTimeOffset.UtcNow)) return true;
        platform.PublicShareLimits.NoteAttempt(ip, DateTimeOffset.UtcNow);
        return false;
    }
    private static void SetPublicHeaders(HttpContext ctx)
    {
        ctx.Response.Headers["X-Robots-Tag"] = "noindex";
        ctx.Response.Headers["Cache-Control"] = "no-store";
        ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";
    }
    private static async Task<ShareRow?> PublicShare(Platform platform, string token, CancellationToken ct)
    {
        if (token.Length != 64 || !token.All(Uri.IsHexDigit)) return null;
        var hex = LibraryShareTokens.Hash(token.ToLowerInvariant());
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var row = await conn.QuerySingleOrDefaultAsync<ShareRow>("""
            SELECT li.id AS item_id,li.bot_id,li.name,li.kind,li.ext,li.mime,li.size_bytes AS size,li.sha256 AS sha,li.dlp_state AS dlp,li.artifact_id AS artifact,
                   a.object_key AS key,li.created_at AS created_at_raw,s.token_hash AS token_hash
            FROM library_shares s JOIN library_items li ON li.id=s.item_id AND li.bot_id=s.bot_id
            JOIN bots b ON b.id=s.bot_id LEFT JOIN artifacts a ON a.id=li.artifact_id
            WHERE s.token_hash=@hex AND s.revoked_at IS NULL AND s.expires_at>now() AND li.deleted_at IS NULL
              AND li.dlp_state<>'blocked' AND NOT (li.dlp_state='redacted' AND li.kind NOT IN ('text','markdown','code','sheet'))
            """, new { hex });
        if (row == null || LibraryKinds.IsDeniedName(row.Name)) return null;
        return LibraryShareTokens.Matches(token, row.TokenHash) ? row : null;
    }

    private static async Task<List<Row>> Fetch(System.Data.IDbConnection conn, Guid bot, int limit, string where, DateTimeOffset? from, DateTimeOffset? to, (DateTimeOffset At, Guid Id)? cursor, bool pinned, string visibility, string filters, string? direction)
    {
        var cursorSql = cursor == null ? "" : " AND (created_at,id) < (@cursorAt,@cursorId)";
        var order = pinned ? "pinned_at DESC,created_at DESC,id DESC" : "created_at DESC,id DESC";
        var sql = $"SELECT id,artifact_id,name,kind,ext,mime,size_bytes,source,direction,created_at AS created_at_raw,pinned_at AS pinned_at_raw,thumb_key,thumb_state,dlp_state,message_id,page_id FROM library_items WHERE bot_id=@bot AND deleted_at IS NULL AND {visibility} AND {where}{filters}{cursorSql} ORDER BY {order} LIMIT @limit";
        return (await conn.QueryAsync<Row>(sql, new { bot, from, to, cursorAt = cursor?.At, cursorId = cursor?.Id, limit, direction })).AsList();
    }

    private static object ToItem(Row row, Guid bot) => new { id = row.Id, name = row.Name, kind = row.Kind, ext = row.Ext, mime = row.Mime, sizeBytes = row.SizeBytes, source = row.Source, direction = row.Direction, createdAt = row.CreatedAt, messageId = row.MessageId, pageId = row.PageId, dlpState = row.DlpState, thumbState = row.ThumbState, thumbUrl = row.ThumbState == "ready" ? $"/api/bots/{bot}/library/{row.Id}/thumb" : null, pinned = row.PinnedAt != null };
    private static string EscapeLike(string value) => value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("%", "\\%", StringComparison.Ordinal).Replace("_", "\\_", StringComparison.Ordinal);

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
