using System.Net.Http.Headers;
using Amazon.S3.Model;
using Dapper;
using Teammates.Compute;

namespace Teammates.Api;

public sealed class LibraryThumbnailWorker(Platform platform, ILogger<LibraryThumbnailWorker> logger) : BackgroundService
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(22) };
    private readonly Dictionary<Guid, DateTimeOffset> _lastBotWork = [];

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await ProcessOne(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex) { logger.LogWarning("Library thumbnail pass failed: {Message}", ex.Message); }
            await Task.Delay(TimeSpan.FromSeconds(3), stoppingToken);
        }
    }

    private async Task ProcessOne(CancellationToken ct)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        var row = await conn.QuerySingleOrDefaultAsync<Job>(new CommandDefinition("""
            SELECT li.id,li.bot_id,li.kind,a.object_key,li.thumb_attempts
            FROM library_items li JOIN artifacts a ON a.id=li.artifact_id
            WHERE li.thumb_state='pending' AND li.deleted_at IS NULL AND li.thumb_retry_at<=now()
              AND li.kind IN ('image','screenshots','video','pdf')
            ORDER BY li.thumb_retry_at,li.created_at LIMIT 1 FOR UPDATE OF li SKIP LOCKED
            """, transaction: tx, cancellationToken: ct));
        if (row == null) return;
        var now = DateTimeOffset.UtcNow;
        if (_lastBotWork.TryGetValue(row.BotId, out var last) && now - last < TimeSpan.FromSeconds(15))
        {
            await conn.ExecuteAsync(new CommandDefinition("UPDATE library_items SET thumb_retry_at=@retry WHERE id=@id AND thumb_state='pending'", new { id = row.Id, retry = last.AddSeconds(15) }, tx, cancellationToken: ct));
            await tx.CommitAsync(ct);
            return;
        }
        _lastBotWork[row.BotId] = now;
        try
        {
            var placement = await platform.PlacementForBot(row.BotId, ct);
            var session = await platform.Compute.GetDesktopSessionAsync(placement.Computer, new DesktopAccess(DesktopMode.View, 0, TimeSpan.FromSeconds(2), false), ct);
            using var obj = await platform.S3.GetObjectAsync(platform.Bucket, row.ObjectKey, ct);
            using var memory = new MemoryStream();
            await obj.ResponseStream.CopyToAsync(memory, ct);
            var thumbnailUri = new UriBuilder("http", session.Host, 7700) { Path = "/library/thumbnail", Query = "kind=" + Uri.EscapeDataString(row.Kind == "screenshots" ? "image" : row.Kind) }.Uri;
            using var request = new HttpRequestMessage(HttpMethod.Post, thumbnailUri);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", platform.ComputerToken);
            request.Content = new ByteArrayContent(memory.ToArray());
            request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
            using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            if (response.StatusCode == System.Net.HttpStatusCode.UnprocessableEntity)
            {
                await conn.ExecuteAsync(new CommandDefinition("UPDATE library_items SET thumb_state='failed' WHERE id=@id AND thumb_state='pending'", new { id = row.Id }, tx, cancellationToken: ct));
                await tx.CommitAsync(ct);
                return;
            }
            response.EnsureSuccessStatusCode();
            var key = $"thumbs/{row.BotId}/{row.Id}.webp";
            var webpBytes = await response.Content.ReadAsByteArrayAsync(ct);
            await using var webp = new MemoryStream(webpBytes, writable: false);
            await platform.S3.PutObjectAsync(new PutObjectRequest { BucketName = platform.Bucket, Key = key, InputStream = webp, ContentType = "image/webp", UseChunkEncoding = false }, ct);
            await conn.ExecuteAsync(new CommandDefinition("UPDATE library_items SET thumb_key=@key,thumb_state='ready' WHERE id=@id AND thumb_state='pending'", new { key, id = row.Id }, tx, cancellationToken: ct));
            await tx.CommitAsync(ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            var attempts = Math.Min(row.Attempts + 1, 8);
            var delay = Math.Min(300, 5 * (1 << Math.Min(attempts, 6)));
            await conn.ExecuteAsync(new CommandDefinition("UPDATE library_items SET thumb_attempts=@attempts,thumb_retry_at=now()+(@seconds * interval '1 second') WHERE id=@id AND thumb_state='pending'", new { id = row.Id, attempts, seconds = delay }, tx, cancellationToken: ct));
            await tx.CommitAsync(ct);
            logger.LogDebug("Library thumbnail will retry: {Message}", ex.Message);
        }
    }

    private sealed record Job(Guid Id, Guid BotId, string Kind, string ObjectKey, int Attempts);
}
