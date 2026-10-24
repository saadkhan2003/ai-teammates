using System.Text.Json;
using System.Text.RegularExpressions;
using Dapper;
using Teammates.Compute;

namespace Teammates.Api;

/// <summary>The right-panel "Coding" list: one row per coding task or pull request, derived from the git/PR/CI/test tools.</summary>
public static class CodingStatus
{
    private static readonly string[] Active = ["queued", "planning", "running", "waiting_resource", "waiting_approval", "waiting_human", "paused", "recovering"];

    public static string From(string taskStatus, int? prNumber, string prState)
    {
        if (prState == "merged") return "merged";
        if (taskStatus is "failed" or "cancelled") return "failed";
        if (Active.Contains(taskStatus)) return "running";
        if (prNumber != null && prState is "" or "open") return "ready_for_review";
        return "finished";
    }

    public static readonly Regex PullUrl = new(@"https?://[^\s/]+/(?<repo>[^\s]+?)/pull/(?<n>\d+)", RegexOptions.Compiled);

    /// <summary>Parses the PR URL printed by `gh pr create`. Returns the number, URL and the clone URL of the repository.</summary>
    public static (int Number, string Url, string RepoUrl)? ParsePullUrl(string text)
    {
        var m = PullUrl.Match(text ?? "");
        if (!m.Success) return null;
        var url = m.Value;
        var host = new Uri(url).GetLeftPart(UriPartial.Authority);
        return (int.Parse(m.Groups["n"].Value), url, $"{host}/{m.Groups["repo"].Value}.git");
    }

    /// <summary>Counts files in `git diff --name-only` output.</summary>
    public static string[] Files(string nameOnly) => (nameOnly ?? "").Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Distinct().Take(500).ToArray();
}

public static class CodingItems
{
    private const int MaxDiff = 120_000;
    private static string Str(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) ? v.ToString() : "";
    private static int Code(JsonElement e) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty("exitCode", out var v) && v.TryGetInt32(out var n) ? n : 0;

    /// <summary>Best effort: a failure here must never fail the coding tool itself.</summary>
    public static async Task Record(Platform platform, Guid botId, Guid taskId, string tool, object result, string root,
        Func<IReadOnlyList<string>, Task<(int Code, string Stdout, string Stderr)>> run, CancellationToken ct)
    {
        if (tool is not ("git_commit" or "git_diff" or "run_tests" or "create_pr" or "watch_ci")) return;
        try
        {
            var json = JsonSerializer.SerializeToElement(result);
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var branch = (await run(["git", "-C", root, "rev-parse", "--abbrev-ref", "HEAD"])).Stdout.Trim();
            await conn.ExecuteAsync(
                "INSERT INTO coding_items (bot_id, task_id, title, branch) SELECT t.bot_id, t.id, t.title, @branch FROM tasks t WHERE t.id=@task AND t.bot_id=@bot ON CONFLICT (task_id) DO NOTHING",
                new { bot = botId, task = taskId, branch = branch.Length > 200 ? "" : branch });
            switch (tool)
            {
                case "git_diff":
                {
                    var names = await run(["git", "-C", root, "diff", "--name-only"]);
                    var files = CodingStatus.Files(names.Stdout);
                    var diff = Redact(Str(json, "diff"));
                    await Save(conn, taskId, files, diff);
                    await LibraryIngest.IndexTextExport(platform, botId, taskId, $"diff-{taskId:N}.diff", diff, ct);
                    break;
                }
                case "git_commit":
                {
                    if (Code(json) != 0) break;
                    var names = await run(["git", "-C", root, "diff", "--name-only", "HEAD~1", "HEAD"]);
                    var diff = await run(["git", "-C", root, "diff", "HEAD~1", "HEAD"]);
                    var redactedDiff = Redact(diff.Stdout);
                    await Save(conn, taskId, CodingStatus.Files(names.Stdout), redactedDiff);
                    await LibraryIngest.IndexTextExport(platform, botId, taskId, $"diff-{taskId:N}.diff", redactedDiff, ct);
                    await conn.ExecuteAsync("UPDATE coding_items SET branch=@branch WHERE task_id=@task AND @branch<>''", new { task = taskId, branch });
                    break;
                }
                case "run_tests":
                {
                    var output = Str(json, "output");
                    var ok = Code(json) == 0;
                    await conn.ExecuteAsync("UPDATE coding_items SET tests_ok=@ok, tests_summary=@summary, updated_at=now() WHERE task_id=@task",
                        new { task = taskId, ok, summary = output.Length > 8000 ? output[^8000..] : output });
                    break;
                }
                case "create_pr":
                {
                    var parsed = CodingStatus.ParsePullUrl(Str(json, "stdout") + "\n" + Str(json, "stderr"));
                    if (parsed is { } pr)
                        await conn.ExecuteAsync("UPDATE coding_items SET pr_number=@n, pr_url=@url, repo_url=@repo, pr_state='open', updated_at=now() WHERE task_id=@task",
                            new { task = taskId, n = pr.Number, url = pr.Url, repo = pr.RepoUrl });
                    break;
                }
                case "watch_ci":
                {
                    var summary = json.ValueKind == JsonValueKind.Object && json.TryGetProperty("summary", out var s) ? s : default;
                    var state = Str(summary, "State");
                    if (state.Length == 0) state = Str(summary, "state");
                    if (state is "passing" or "failing" or "pending")
                        await conn.ExecuteAsync("UPDATE coding_items SET ci_state=@state, updated_at=now() WHERE task_id=@task", new { task = taskId, state });
                    break;
                }
            }
        }
        catch { /* never block the tool */ }
    }

    private static string Redact(string text) => OutputRedactor.Redact(text.Length > MaxDiff ? text[..MaxDiff] : text);

    private static Task Save(System.Data.Common.DbConnection conn, Guid task, string[] files, string diff) =>
        conn.ExecuteAsync("UPDATE coding_items SET changed_files=@count, files=@files::jsonb, diff=@diff, updated_at=now() WHERE task_id=@task",
            new { task, count = files.Length, files = JsonSerializer.Serialize(files), diff = diff.Length > MaxDiff ? diff[..MaxDiff] : diff });

    public static void Map(WebApplication app, Platform platform)
    {
        app.MapGet("/api/bots/{id:guid}/coding", async (HttpContext ctx, Guid id) =>
        {
            var user = await Routes.RequireUser(ctx, platform);
            if (user == null || !await Routes.Owns(platform, user.Value, id)) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync<(Guid Id, Guid TaskId, string Title, string Branch, int? PrNumber, string PrUrl, string PrState, string CiState, int Changed, bool? TestsOk, string TaskStatus, DateTimeOffset Updated)>(
                "SELECT c.id, c.task_id, c.title, c.branch, c.pr_number, c.pr_url, c.pr_state, c.ci_state, c.changed_files, c.tests_ok, t.status, c.updated_at FROM coding_items c JOIN tasks t ON t.id=c.task_id WHERE c.bot_id=@id ORDER BY c.updated_at DESC LIMIT 50", new { id });
            return Results.Json(rows.Select(r => new
            {
                id = r.Id, taskId = r.TaskId, title = r.Title, branch = r.Branch, prNumber = r.PrNumber, prUrl = r.PrUrl,
                status = CodingStatus.From(r.TaskStatus, r.PrNumber, r.PrState), ci = r.CiState, changedFiles = r.Changed, testsOk = r.TestsOk, updatedAt = r.Updated
            }));
        });

        app.MapGet("/api/coding/{id:guid}", async (HttpContext ctx, Guid id) =>
        {
            var user = await Routes.RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var row = await conn.QuerySingleOrDefaultAsync(
                "SELECT c.id, c.title, c.branch, c.repo_url, c.pr_number, c.pr_url, c.pr_state, c.ci_state, c.changed_files, c.files::text AS files, c.diff, c.tests_ok, c.tests_summary, t.status AS task_status FROM coding_items c JOIN tasks t ON t.id=c.task_id JOIN bots b ON b.id=c.bot_id WHERE c.id=@id AND b.owner_id=@owner", new { id, owner = user });
            if (row == null) return Results.NotFound();
            var files = JsonSerializer.Deserialize<string[]>((string)row.files) ?? [];
            string status = CodingStatus.From((string)row.task_status, (int?)row.pr_number, (string)row.pr_state);
            return Results.Json(new
            {
                id = (Guid)row.id, title = (string)row.title, branch = (string)row.branch, repoUrl = (string)row.repo_url, prNumber = (int?)row.pr_number,
                prUrl = (string)row.pr_url, status, ci = (string)row.ci_state, changedFiles = (int)row.changed_files, files, diff = (string)row.diff,
                testsOk = (bool?)row.tests_ok, testsSummary = (string)row.tests_summary,
                checkout = CheckoutCommand((string)row.repo_url, (string)row.branch)
            });
        });
    }

    public static string CheckoutCommand(string repoUrl, string branch)
    {
        if (!Regex.IsMatch(branch ?? "", @"^[A-Za-z0-9_./-]+$")) return "";
        return string.IsNullOrEmpty(repoUrl) ? $"git fetch origin {branch} && git checkout {branch}" : $"git clone -b {branch} {repoUrl}";
    }
}
