using System.Text.Json;
using Dapper;

namespace Teammates.Api;

public static class ChatReply
{
    public static bool TryRead(JsonElement body, out Guid id, out bool invalid)
    {
        invalid = false;
        id = Guid.Empty;
        if (body.ValueKind != JsonValueKind.Object) return false;
        var present = body.TryGetProperty("replyTo", out var el) || body.TryGetProperty("reply_to", out el);
        if (!present || el.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return false;
        if (el.ValueKind != JsonValueKind.String || !Guid.TryParse(el.GetString(), out id) || id == Guid.Empty)
        {
            invalid = true;
            return false;
        }
        return true;
    }
}

public static class CodingJobs
{
    public static readonly string[] Statuses = ["queued", "running", "tests", "finished", "merged", "failed"];

    public static string Normalize(string? status)
    {
        var value = (status ?? "").Trim().ToLowerInvariant();
        return Statuses.Contains(value) ? value : "running";
    }

    public static async Task<Dictionary<string, object?>> Upsert(Platform platform, Guid botId, Guid? taskId, JsonElement body, CancellationToken ct = default)
    {
        var title = ReadString(body, "title", "title");
        if (title.Length == 0) title = "Coding job";
        if (title.Length > 200) title = title[..200];
        var status = Normalize(ReadString(body, "status", "status"));
        var step = ReadString(body, "step", "step");
        if (step.Length > 160) step = step[..160];
        var prUrl = ReadString(body, "prUrl", "pr_url");
        if (prUrl.Length > 500) prUrl = prUrl[..500];
        int? pr = ReadInt(body, "prNumber", "pr_number");
        var branch = ReadString(body, "branch", "branch");
        if (branch.Length > 200) branch = branch[..200];
        int? filesChanged = ReadInt(body, "filesChanged", "files_changed");
        int? additions = ReadInt(body, "additions", "additions");
        int? deletions = ReadInt(body, "deletions", "deletions");
        Guid? jobId = ReadGuid(body, "id", "jobId", "job_id");

        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        Guid? existing = null;
        if (jobId != null)
            existing = await conn.ExecuteScalarAsync<Guid?>("SELECT id FROM coding_jobs WHERE id=@id AND bot_id=@bot", new { id = jobId, bot = botId }, tx);
        if (existing == null)
            existing = await conn.ExecuteScalarAsync<Guid?>("SELECT id FROM coding_jobs WHERE bot_id=@bot AND title=@title ORDER BY updated_at DESC LIMIT 1", new { bot = botId, title }, tx);

        Guid id;
        if (existing == null)
        {
            id = await conn.ExecuteScalarAsync<Guid>(
                """
                INSERT INTO coding_jobs (bot_id, task_id, title, status, step, pr_number, pr_url, branch, files_changed, additions, deletions)
                VALUES (@bot, @task, @title, @status, @step, @pr, @prUrl, @branch, COALESCE(@files, 0), COALESCE(@additions, 0), COALESCE(@deletions, 0))
                RETURNING id
                """,
                new { bot = botId, task = taskId, title, status, step, pr, prUrl, branch, files = filesChanged, additions, deletions }, tx);
        }
        else
        {
            id = existing.Value;
            await conn.ExecuteAsync(
                """
                UPDATE coding_jobs
                SET status=@status,
                    step=@step,
                    pr_number=COALESCE(@pr, pr_number),
                    pr_url=CASE WHEN @prUrl = '' THEN pr_url ELSE @prUrl END,
                    branch=CASE WHEN @branch = '' THEN branch ELSE @branch END,
                    files_changed=COALESCE(@files, files_changed),
                    additions=COALESCE(@additions, additions),
                    deletions=COALESCE(@deletions, deletions),
                    task_id=COALESCE(@task, task_id),
                    updated_at=now()
                WHERE id=@id
                """,
                new { id, status, step, pr, prUrl, branch, files = filesChanged, additions, deletions, task = taskId }, tx);
        }

        await conn.ExecuteAsync(
            """
            INSERT INTO messages (conversation_id, role, kind, content)
            SELECT c.id, 'assistant', 'coding-jobs', '{"type":"coding-jobs"}'
            FROM conversations c
            WHERE c.bot_id=@bot
              AND NOT EXISTS (
                SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.kind = 'coding-jobs'
              )
            ORDER BY c.created_at
            LIMIT 1
            """,
            new { bot = botId }, tx);
        var stored = Platform.ToDict(await conn.QuerySingleAsync("SELECT id, bot_id, task_id, title, status, step, pr_number, pr_url, branch, files_changed, additions, deletions, updated_at FROM coding_jobs WHERE id=@id", new { id }, tx));
        await tx.CommitAsync(ct);
        var job = stored;
        await platform.Publish(new { type = "coding.job", botId, job });
        return job;
    }

    private static string ReadString(JsonElement body, params string[] names)
    {
        foreach (var name in names)
        {
            if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String)
                return (value.GetString() ?? "").Trim();
        }
        return "";
    }

    private static int? ReadInt(JsonElement body, params string[] names)
    {
        foreach (var name in names)
        {
            if (body.ValueKind != JsonValueKind.Object || !body.TryGetProperty(name, out var value)) continue;
            if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number)) return number;
            if (value.ValueKind == JsonValueKind.String && int.TryParse(value.GetString(), out var parsed)) return parsed;
        }
        return null;
    }

    private static Guid? ReadGuid(JsonElement body, params string[] names)
    {
        foreach (var name in names)
        {
            if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String && Guid.TryParse(value.GetString(), out var id) && id != Guid.Empty)
                return id;
        }
        return null;
    }
}
