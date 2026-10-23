using System.Text.Json;
using Dapper;
using Teammates.Compute;

namespace Teammates.Api;

public static class CodingTools
{
    public static async Task<object> Run(Platform platform, Guid botId, Guid taskId, string tool, JsonElement args,
        Func<IReadOnlyList<string>, Task<(int Code, string Stdout, string Stderr)>> run, CancellationToken ct)
    {
        var result = await RunCore(platform, botId, taskId, tool, args, run, ct);
        var repoArg = Repo(Arg(args, "repo")) ?? ".";
        await CodingItems.Record(platform, botId, taskId, tool, result, repoArg == "." ? "/workspace" : "/workspace/" + repoArg, run, ct);
        return result;
    }

    private static async Task<object> RunCore(Platform platform, Guid botId, Guid taskId, string tool, JsonElement args,
        Func<IReadOnlyList<string>, Task<(int Code, string Stdout, string Stderr)>> run, CancellationToken ct)
    {
        var repo = Repo(Arg(args, "repo"));
        if (repo == null) throw new ToolHalt("invalid", "repo must be a relative workspace path without '..'");
        var root = repo == "." ? "/workspace" : "/workspace/" + repo;
        switch (tool)
        {
            case "plan_set":
            {
                var items = args.GetProperty("items").EnumerateArray().Select(x => x.GetString()!.Trim()).ToArray();
                await using var conn = await platform.Data.OpenConnectionAsync(ct);
                await using var tx = await conn.BeginTransactionAsync(ct);
                await conn.ExecuteAsync("DELETE FROM task_plan_items WHERE task_id=@task", new { task = taskId }, tx);
                for (var i = 0; i < items.Length; i++) await conn.ExecuteAsync("INSERT INTO task_plan_items(task_id,position,title) VALUES(@task,@position,@title)", new { task = taskId, position = i + 1, title = items[i] }, tx);
                await conn.ExecuteAsync("UPDATE tasks SET last_progress_at=now(),blocked_reason=NULL WHERE id=@task", new { task = taskId }, tx);
                await tx.CommitAsync(ct);
                await WritePlan(platform, taskId, run, ct);
                await platform.Publish(new { type = "plan", taskId });
                return new { count = items.Length };
            }
            case "plan_update":
            {
                if (!int.TryParse(Arg(args, "index"), out var index) || index < 1) throw new ToolHalt("invalid", "index must be a positive one-based number");
                await using var conn = await platform.Data.OpenConnectionAsync(ct);
                var changed = await conn.ExecuteAsync("UPDATE task_plan_items SET status=@status,updated_at=now() WHERE task_id=@task AND position=@index", new { task = taskId, index, status = Arg(args, "status") });
                if (changed == 0) throw new ToolHalt("invalid", "plan item not found");
                await conn.ExecuteAsync("UPDATE tasks SET last_progress_at=now(),blocked_reason=NULL WHERE id=@task", new { task = taskId });
                await WritePlan(platform, taskId, run, ct);
                await platform.Publish(new { type = "plan", taskId });
                return new { updated = true };
            }
            case "git_status": return await Execute(run, ["git", "-C", root, "status", "--short"]);
            case "git_diff":
            {
                var stat = await Execute(run, ["git", "-C", root, "diff", "--stat"]);
                var diff = await Execute(run, ["git", "-C", root, "diff", "--"]);
                var lines = ((string)diff.GetType().GetProperty("stdout")!.GetValue(diff)!).Split('\n').Take(400);
                return new { stat, diff = OutputRedactor.Redact(string.Join('\n', lines)) };
            }
            case "git_commit": return await Execute(run, ["git", "-C", root, "-c", "user.name=AI Teammate", "-c", "user.email=teammate@localhost", "add", "-A"])
                is var added && (int)added.GetType().GetProperty("exitCode")!.GetValue(added)! == 0
                    ? await Execute(run, ["git", "-C", root, "-c", "user.name=AI Teammate", "-c", "user.email=teammate@localhost", "commit", "-m", Arg(args, "message")]) : new { ok = false };
            case "run_tests": return await RunTests(run, root, Arg(args, "runner"), Arg(args, "args"), platform, taskId);
            case "watch_ci":
            {
                var pr = Arg(args, "pr");
                var result = string.IsNullOrEmpty(pr) ? await run(["gh", "run", "list", "--limit", "5", "--json", "name,status,conclusion,url"]) : await run(["gh", "pr", "checks", pr, "--json", "name,state,link"]);
                if (result.Code != 0) return new { ok = false, error = "gh_not_available", message = "GitHub CLI is unavailable or unauthenticated." };
                var ci = CiSummary.From(result.Stdout);
                return new { ok = true, summary = new { state = ci.State, checks = ci.Checks } };
            }
            case "create_pr":
            {
                var argv = new List<string> { "gh", "pr", "create", "--title", Arg(args, "title"), "--body", Arg(args, "body") };
                if (Arg(args, "base") is { Length: > 0 } b) { argv.Add("--base"); argv.Add(b); }
                return await Execute(run, argv);
            }
            case "spawn_child_task":
            {
                var title = Arg(args, "title").Trim();
                var instruction = Arg(args, "instruction").Trim();
                var branch = Arg(args, "branch");
                if (string.IsNullOrWhiteSpace(title) || string.IsNullOrWhiteSpace(instruction)) throw new ToolHalt("invalid", "title and instruction are required");
                if (branch.Length > 0 && (!System.Text.RegularExpressions.Regex.IsMatch(branch, @"^[A-Za-z0-9_./-]+$") || branch.Split('/').Contains(".."))) throw new ToolHalt("invalid", "branch is invalid");
                await using var conn = await platform.Data.OpenConnectionAsync(ct);
                var parent = await conn.QuerySingleAsync<(int Depth, Guid Bot, Guid? Parent)>("SELECT coalesce((SELECT 1 FROM tasks p WHERE p.id=t.parent_task_id),0)::int,b.id,t.parent_task_id FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE t.id=@task", new { task = taskId });
                if (parent.Parent != null || parent.Depth >= ChildTaskPolicy.MaxDepth) throw new ToolHalt("denied", "child tasks cannot spawn children");
                if (await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM tasks WHERE parent_task_id=@task AND status IN ('queued','running','waiting_human','waiting_approval','waiting_resource')", new { task = taskId }) >= ChildTaskPolicy.MaxActiveChildren)
                    throw new ToolHalt("denied", "a parent may have at most three active child tasks");
                var childId = Guid.NewGuid();
                var worktree = ChildTaskPolicy.Worktree(repo, childId.ToString("N"));
                var worktreePath = worktree.StartsWith("./", StringComparison.Ordinal) ? worktree[2..] : worktree;
                branch = branch.Length == 0 ? ChildTaskPolicy.Branch(childId.ToString("N")) : branch;
                var worktreeResult = await run(["git", "-C", root, "worktree", "add", worktreePath, "-b", branch]);
                if (worktreeResult.Code != 0) return new { ok = false, error = OutputRedactor.Redact(worktreeResult.Stderr) };
                var childInstruction = $"Work only inside /workspace/{worktreePath}. Commit there. Do not touch other directories.\n\n{instruction}";
                await conn.ExecuteAsync("INSERT INTO tasks(id,bot_id,title,instruction,kind,status,parent_task_id,worktree_path,conversation_id) SELECT @id,bot_id,@title,@instruction,kind,'queued',@parent,@worktree,conversation_id FROM tasks WHERE id=@parent", new { id = childId, parent = taskId, title, instruction = childInstruction, worktree = worktreePath });
                platform.Tasks.Pulse();
                return new { taskId = childId, worktree = worktreePath, branch };
            }
            case "child_status":
            {
                if (!Guid.TryParse(Arg(args, "task_id"), out var child)) throw new ToolHalt("invalid", "task_id must be a task id");
                await using var conn = await platform.Data.OpenConnectionAsync(ct);
                return await conn.QuerySingleOrDefaultAsync("SELECT id,status,result FROM tasks WHERE id=@child AND parent_task_id=@parent", new { child, parent = taskId }) ?? (object)new { status = "not_found" };
            }
            default: throw new ToolHalt("denied", "unknown coding tool");
        }
    }

    private static async Task<object> RunTests(Func<IReadOnlyList<string>, Task<(int Code, string Stdout, string Stderr)>> run, string root, string runner, string extra, Platform platform, Guid taskId)
    {
        if (extra.Any(c => ";&|`$<>\n\r".Contains(c))) throw new ToolHalt("invalid", "args contains unsupported shell characters");
        if (runner == "auto") runner = "pytest";
        IReadOnlyList<string> argv = runner switch
        {
            "npm" => ["npm", "test", "--", .. (extra.Length == 0 ? [] : extra.Split(' ', StringSplitOptions.RemoveEmptyEntries))],
            "pytest" => ["pytest", "-q", .. (extra.Length == 0 ? [] : extra.Split(' ', StringSplitOptions.RemoveEmptyEntries))],
            "dotnet" => ["dotnet", "test", .. (extra.Length == 0 ? [] : extra.Split(' ', StringSplitOptions.RemoveEmptyEntries))],
            "make" => ["make", "test", .. (extra.Length == 0 ? [] : extra.Split(' ', StringSplitOptions.RemoveEmptyEntries))],
            _ => throw new ToolHalt("invalid", "unsupported test runner")
        };
        var result = await run([.. argv.Take(1), "-C", root, .. argv.Skip(1)]);
        await using var conn = await platform.Data.OpenConnectionAsync();
        await conn.ExecuteAsync("UPDATE tasks SET tests_passed_at=CASE WHEN @ok THEN now() ELSE NULL END WHERE id=@task", new { task = taskId, ok = result.Code == 0 });
        return new { exitCode = result.Code, output = OutputRedactor.Redact(string.Join('\n', (result.Stdout + "\n" + result.Stderr).Split('\n').TakeLast(60))) };
    }

    private static async Task<object> Execute(Func<IReadOnlyList<string>, Task<(int Code, string Stdout, string Stderr)>> run, IReadOnlyList<string> argv)
    {
        var result = await run(argv);
        return new { exitCode = result.Code, stdout = OutputRedactor.Redact(result.Stdout), stderr = OutputRedactor.Redact(result.Stderr) };
    }
    public static string? Repo(string repo) => string.IsNullOrWhiteSpace(repo) ? "." : repo.StartsWith('/') || repo.Split('/').Contains("..") || !System.Text.RegularExpressions.Regex.IsMatch(repo, @"^[A-Za-z0-9_./-]+$") ? null : repo;
    private static string Arg(JsonElement args, string name) => args.TryGetProperty(name, out var value) ? value.GetString() ?? "" : "";
    private static async Task WritePlan(Platform platform, Guid task, Func<IReadOnlyList<string>, Task<(int Code, string Stdout, string Stderr)>> run, CancellationToken ct)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var rows = await conn.QueryAsync<(string Title, string Status)>("SELECT title,status FROM task_plan_items WHERE task_id=@task ORDER BY position", new { task });
        var markdown = string.Join("\n", rows.Select(x => $"- [{(x.Status == "done" ? "x" : " ")}] {x.Title}"));
        await run(["python3", "-c", "from workspace import write_file; import sys; write_file(sys.argv[1], sys.argv[2])", "/workspace/.progress/task-" + task.ToString("N")[..8] + ".md", markdown]);
    }
}
