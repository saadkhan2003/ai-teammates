using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Dapper;
using Teammates.Compute;

namespace Teammates.Api;

public static class LibraryIngest
{
    private static readonly Regex Attachment = new(@"\[attached:\s*(/workspace/uploads/[^\]\r\n]+)\]", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    public static async Task IndexArtifact(Platform platform, Guid botId, Guid artifactId, string source = "artifact", string direction = "out", Guid? messageId = null, CancellationToken ct = default)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var row = await conn.QuerySingleOrDefaultAsync<(Guid BotId, Guid? TaskId, string Name, string Mime, long Size, string Sha, DateTime Created)>(
            "SELECT bot_id,task_id,name,mime,size_bytes,sha256,created_at FROM artifacts WHERE id=@artifact AND bot_id=@bot", new { artifact = artifactId, bot = botId });
        if (row.BotId == Guid.Empty || LibraryKinds.IsDeniedName(row.Name)) return;
        await Upsert(conn, botId, source, direction, row.Name, row.Mime, row.Size, row.Sha, artifactId, messageId, row.TaskId, row.Created);
    }

    public static async Task IndexMessageAttachments(Platform platform, Runtime runtime, Guid botId, Guid messageId, string content, CancellationToken ct)
    {
        foreach (Match match in Attachment.Matches(content))
        {
            var path = match.Groups[1].Value.Trim();
            var name = LibraryKinds.SanitizeName(Path.GetFileName(path));
            if (!path.StartsWith("/workspace/uploads/", StringComparison.Ordinal) || LibraryKinds.IsDeniedName(path) || LibraryKinds.IsDeniedName(name)) continue;
            try
            {
                var placement = await platform.PlacementForBot(botId, ct);
                var (code, output, _) = await runtime.Run(placement.Computer, botId, ["python3", "-c", BotFs.Script("read_b64(sys.argv[1])"), path], null, ct);
                if (code != 0 || string.IsNullOrWhiteSpace(output)) continue;
                var bytes = Convert.FromBase64String(output.Trim());
                if (bytes.Length > 250_000_000) continue;
                var sha = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
                var mime = LibraryKinds.SniffMime(bytes, name);
                var key = $"artifacts/{botId}/{Guid.NewGuid():n}/{name}";
                await using var stream = new MemoryStream(bytes, writable: false);
                await platform.S3.PutObjectAsync(new Amazon.S3.Model.PutObjectRequest { BucketName = platform.Bucket, Key = key, InputStream = stream, ContentType = mime }, ct);
                Guid artifactId;
                await using (var conn = await platform.Data.OpenConnectionAsync(ct))
                {
                    artifactId = await conn.ExecuteScalarAsync<Guid>("INSERT INTO artifacts(bot_id,name,mime,size_bytes,sha256,object_key) VALUES(@bot,@name,@mime,@size,@sha,@key) RETURNING id", new { bot = botId, name, mime, size = bytes.LongLength, sha, key });
                    await Upsert(conn, botId, "upload", "in", name, mime, bytes.LongLength, sha, artifactId, messageId, null, DateTime.UtcNow);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // A message remains usable when an attached workspace file has been removed or is unreadable.
            }
        }
    }

    private static Task<int> Upsert(System.Data.IDbConnection conn, Guid botId, string source, string direction, string rawName, string mime, long size, string sha, Guid artifactId, Guid? messageId, Guid? taskId, DateTime created) => conn.ExecuteAsync(
        """
        INSERT INTO library_items(bot_id,source,direction,name,ext,mime,kind,size_bytes,sha256,artifact_id,message_id,task_id,created_at)
        VALUES(@bot,@source,@direction,@name,@ext,@mime,@kind,@size,@sha,@artifact,@message,@task,@created)
        ON CONFLICT (bot_id,sha256,name) WHERE deleted_at IS NULL DO UPDATE SET
          source=EXCLUDED.source,direction=EXCLUDED.direction,mime=EXCLUDED.mime,kind=EXCLUDED.kind,size_bytes=EXCLUDED.size_bytes,
          artifact_id=EXCLUDED.artifact_id,message_id=EXCLUDED.message_id,task_id=EXCLUDED.task_id,created_at=EXCLUDED.created_at
        WHERE EXCLUDED.created_at >= library_items.created_at
        """,
        new { bot = botId, source, direction, name = LibraryKinds.SanitizeName(rawName), ext = Path.GetExtension(LibraryKinds.SanitizeName(rawName)).TrimStart('.').ToLowerInvariant(), mime, kind = source == "screenshot" ? "screenshots" : LibraryKinds.Detect(rawName, mime), size, sha, artifact = artifactId, message = messageId, task = taskId, created });
}
