using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Amazon.S3.Model;
using Dapper;
using Teammates.Compute;

namespace Teammates.Api;

/// <summary>Authenticated API workflow for private fork-window Teach recordings.</summary>
public static class TeachRoutes
{
    public const string Prompt = "The recording is finished. Learn the task from it.";
    private const int MaxRecordingBytes = 45 * 1024 * 1024;
    private static readonly ConcurrentDictionary<Guid, string> Active = new();

    public static void Map(WebApplication app, Platform platform)
    {
        app.MapPost("/api/teach/start", async (HttpContext ctx, JsonElement body, CancellationToken ct) =>
        {
            var user = await Routes.RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!body.TryGetProperty("botId", out var botNode) || !botNode.TryGetGuid(out var botId)
                || !body.TryGetProperty("conversationId", out var conversationNode) || !conversationNode.TryGetGuid(out var conversationId))
                return Results.BadRequest(new { error = "bot_and_conversation_required" });
            await using (var conn = await platform.Data.OpenConnectionAsync(ct))
            {
                var owns = await conn.ExecuteScalarAsync<int>(
                    "SELECT count(*) FROM bots b JOIN conversations c ON c.bot_id=b.id WHERE b.id=@bot AND b.owner_id=@user AND c.id=@conversation",
                    new { bot = botId, user, conversation = conversationId });
                if (owns == 0) return Results.NotFound();
            }
            var session = Guid.NewGuid().ToString("N");
            if (!Active.TryAdd(botId, session)) return Results.Json(new { error = "teach_already_active" }, statusCode: 409);
            try
            {
                var placement = await platform.PlacementForBot(botId, ct);
                var json = await platform.Compute.ControlAsync(placement.Computer, $"/desktops/{placement.Desktop}/teach/start",
                    JsonSerializer.Serialize(new { display = 2, workspaceBotId = botId }), ct);
                using var bodyDoc = JsonDocument.Parse(json);
                var serviceSession = bodyDoc.RootElement.GetProperty("id").GetString();
                if (string.IsNullOrWhiteSpace(serviceSession) || serviceSession.Length > 96) throw new InvalidOperationException("invalid recorder session");
                Active[botId] = serviceSession;
                return Results.Json(new { status = "recording", sessionId = serviceSession });
            }
            catch (ComputeException ex) when (ex.Code == ComputeErrorCode.Conflict)
            {
                Active.TryRemove(botId, out _);
                return Results.Json(new { error = "teach_already_active" }, statusCode: 409);
            }
            catch
            {
                Active.TryRemove(botId, out _);
                throw;
            }
        });

        app.MapPost("/api/teach/stop", async (HttpContext ctx, JsonElement body, CancellationToken ct) =>
        {
            var user = await Routes.RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!body.TryGetProperty("botId", out var botNode) || !botNode.TryGetGuid(out var botId)
                || !body.TryGetProperty("conversationId", out var conversationNode) || !conversationNode.TryGetGuid(out var conversationId))
                return Results.BadRequest(new { error = "bot_and_conversation_required" });
            var sessionId = Active.TryGetValue(botId, out var active) ? active : null;
            if (sessionId == null) return Results.Json(new { error = "teach_not_active" }, statusCode: 409);
            await using (var conn = await platform.Data.OpenConnectionAsync(ct))
            {
                var owns = await conn.ExecuteScalarAsync<int>(
                    "SELECT count(*) FROM bots b JOIN conversations c ON c.bot_id=b.id WHERE b.id=@bot AND b.owner_id=@user AND c.id=@conversation",
                    new { bot = botId, user, conversation = conversationId });
                if (owns == 0) return Results.NotFound();
            }

            try
            {
                var placement = await platform.PlacementForBot(botId, ct);
                byte[] video;
                try
                {
                    video = await platform.Compute.ControlDownloadAsync(placement.Computer, $"/desktops/{placement.Desktop}/teach/stop",
                        JsonSerializer.Serialize(new { sessionId, workspaceBotId = botId }), MaxRecordingBytes, ct);
                }
                catch (ComputeException ex) when (ex.Code is ComputeErrorCode.Conflict or ComputeErrorCode.FailedPrecondition)
                {
                    return Results.Json(new { error = "recording_failed" }, statusCode: 409);
                }
                if (video.Length == 0) return Results.Json(new { error = "recording_empty" }, statusCode: 502);

                var fileName = sessionId + ".mp4";
                var workspacePath = "/workspace/teach-sessions/" + sessionId + ".mp4";
                var objectKey = $"recordings/{botId}/{fileName}";
                using (var objectStream = new MemoryStream(video))
                await platform.S3.PutObjectAsync(new PutObjectRequest
                {
                    BucketName = platform.Bucket, Key = objectKey, InputStream = objectStream,
                    ContentType = "video/mp4"
                }, ct);

                try
                {
                    var instruction = DemoSkill.Instruction(Prompt, workspacePath);
                    var metadata = DemoSkill.Metadata(workspacePath);
                    await using var conn = await platform.Data.OpenConnectionAsync(ct);
                    await using var tx = await conn.BeginTransactionAsync(ct);
                    var messageId = await conn.ExecuteScalarAsync<Guid>(
                        "INSERT INTO messages (conversation_id, role, content, metadata) VALUES (@conversation, 'user', @prompt, @metadata::jsonb) RETURNING id",
                        new { conversation = conversationId, prompt = Prompt, metadata }, tx);
                    var taskId = await conn.ExecuteScalarAsync<Guid>(
                        "INSERT INTO tasks (bot_id, conversation_id, title, instruction, kind, priority, status, source_message_id) VALUES (@bot, @conversation, @title, @instruction, 'work', 0, 'queued', @message) RETURNING id",
                        new { bot = botId, conversation = conversationId, title = Prompt, instruction, message = messageId }, tx);
                    var sha = Convert.ToHexString(SHA256.HashData(video)).ToLowerInvariant();
                    await conn.ExecuteAsync(
                        "INSERT INTO artifacts (bot_id, task_id, name, mime, size_bytes, sha256, object_key) VALUES (@bot, @task, @name, 'video/mp4', @size, @sha, @key)",
                        new { bot = botId, task = taskId, name = fileName, size = video.Length, sha, key = objectKey }, tx);
                    await tx.CommitAsync(ct);
                    await platform.Publish(new { type = "task", taskId });
                    platform.Tasks.Pulse();
                    return Results.Json(new { status = "queued", messageId, taskId, recording = workspacePath });
                }
                catch
                {
                    try { await platform.S3.DeleteObjectAsync(platform.Bucket, objectKey, ct); } catch { }
                    throw;
                }
                finally { CryptographicOperations.ZeroMemory(video); }
            }
            finally
            {
                if (Active.TryGetValue(botId, out var current) && current == sessionId) Active.TryRemove(botId, out _);
            }
        });
    }

}
