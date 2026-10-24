using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Teammates.Compute;
using Dapper;
using Npgsql;

namespace Teammates.Api;

public sealed record JobRow(Guid Id, Guid OwnerId, Guid BotId, Guid? TaskId, Guid? ConversationId, Guid ComputerId, string Name, string Kind,
    int? Pid, string Status, int? ExitCode, string? Reason, int MaxSeconds, string JobDir, string LogPath, string ResultPath, long LogBytes,
    DateTime StartedAt, DateTime? FinishedAt);

public sealed record JobProbe(int? Exit, bool Alive, long Log);

/// <summary>Pure rules for background jobs; unit tested without a computer.</summary>
public static class JobRules
{
    public static readonly string[] Tools = ["job_start", "job_status", "job_logs", "job_cancel"];
    public static readonly string[] Active = ["starting", "running"];
    public const int LogTailBytes = 16_384;
    public const int MaxCommandChars = 8_000;

    public static bool IsTool(string tool) => tool is "job_start" or "job_status" or "job_logs" or "job_cancel";
    public static bool IsActive(string status) => status is "starting" or "running";

    public static int MaxSeconds(BillingPlan plan, double? requestedMinutes)
    {
        var minutes = requestedMinutes is > 0 && double.IsFinite(requestedMinutes.Value) ? requestedMinutes.Value : plan.JobDefaultMinutes;
        minutes = Math.Clamp(minutes, 0.5, Math.Max(1, plan.JobMaxMinutes));
        return (int)Math.Round(minutes * 60);
    }

    /// <summary>Decide a running job's next status from a probe. Null keeps it running.</summary>
    public static (string Status, string? Reason)? Outcome(JobProbe probe, DateTimeOffset startedAt, int maxSeconds, DateTimeOffset now)
    {
        if (probe.Exit is { } code)
            return code switch
            {
                0 => ("done", null),
                124 or 137 when now - startedAt >= TimeSpan.FromSeconds(maxSeconds - 2) => ("timed_out", "max_run_time"),
                _ => ("failed", "exit_" + code)
            };
        if (!probe.Alive) return ("failed", "lost");
        if (now - startedAt > TimeSpan.FromSeconds(maxSeconds + 60)) return ("timed_out", "max_run_time");
        return null;
    }

    public static string Elapsed(TimeSpan span)
    {
        if (span < TimeSpan.Zero) span = TimeSpan.Zero;
        if (span.TotalHours >= 1) return $"{(int)span.TotalHours}h {span.Minutes}m";
        if (span.TotalMinutes >= 1) return $"{(int)span.TotalMinutes}m {span.Seconds}s";
        return $"{span.Seconds}s";
    }

    /// <summary>The chat notice when a job ends. Plain words, no internal names.</summary>
    public static string Notice(string name, string status, TimeSpan took, string resultPath) => status switch
    {
        "done" => $"Background job “{name}” finished in {Elapsed(took)}. Results are in {resultPath}.",
        "timed_out" => $"Background job “{name}” hit its time limit after {Elapsed(took)} and was stopped. Partial results are in {resultPath}.",
        "cancelled" => $"Background job “{name}” was stopped after {Elapsed(took)}.",
        _ => $"Background job “{name}” failed after {Elapsed(took)}. The log has the details."
    };

    public static string CleanName(string? name, string command)
    {
        var text = string.IsNullOrWhiteSpace(name) ? command : name;
        text = new string(text.Where(ch => !char.IsControl(ch)).ToArray()).Trim();
        return text.Length > 80 ? text[..80] : text.Length == 0 ? "Background job" : text;
    }

    public static string Hash(string command) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(command)))[..16].ToLowerInvariant();

    public const string LaunchScript = """
import json, os, subprocess, sys
root = os.environ['BOT_ROOT']
jid, cmd, secs = sys.argv[1], sys.argv[2], int(sys.argv[3])
d = os.path.join(root, 'jobs', jid)
os.makedirs(os.path.join(d, 'result'), exist_ok=True)
with open(os.path.join(d, 'cmd.sh'), 'w') as f:
    f.write(cmd + '\n')
log = open(os.path.join(d, 'log.txt'), 'ab', buffering=0)
wrap = 'timeout -s TERM -k 10 %d bash "$JOB_DIR/cmd.sh"; code=$?; echo $code > "$JOB_DIR/exit.tmp" && mv "$JOB_DIR/exit.tmp" "$JOB_DIR/exit_code"' % secs
env = dict(os.environ, JOB_DIR=d, JOB_RESULT_DIR=os.path.join(d, 'result'), JOB_ID=jid)
p = subprocess.Popen(['bash', '-c', wrap], cwd=root, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                     env=env, start_new_session=True, close_fds=True)
with open(os.path.join(d, 'pid'), 'w') as f:
    f.write(str(p.pid))
print(json.dumps({'pid': p.pid}))
""";

    public const string ProbeScript = """
import json, os, sys
root = os.environ['BOT_ROOT']
out = {}
for jid in sys.argv[1:]:
    d = os.path.join(root, 'jobs', jid)
    r = {'exit': None, 'alive': False, 'log': 0}
    try:
        r['exit'] = int(open(os.path.join(d, 'exit_code')).read().strip())
    except Exception:
        pass
    try:
        os.kill(int(open(os.path.join(d, 'pid')).read().strip()), 0)
        r['alive'] = True
    except Exception:
        pass
    try:
        r['log'] = os.path.getsize(os.path.join(d, 'log.txt'))
    except Exception:
        pass
    out[jid] = r
print(json.dumps(out))
""";

    public const string TailScript = """
import os, sys
root = os.environ['BOT_ROOT']
path = os.path.join(root, 'jobs', sys.argv[1], 'log.txt')
limit = int(sys.argv[2])
try:
    with open(path, 'rb') as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - limit))
        sys.stdout.write(f.read().decode('utf-8', 'replace'))
except FileNotFoundError:
    pass
""";

    public const string KillScript = """
import os, signal, sys, time
root = os.environ['BOT_ROOT']
try:
    pid = int(open(os.path.join(root, 'jobs', sys.argv[1], 'pid')).read().strip())
except Exception:
    sys.exit(0)
for sig in (signal.SIGTERM, signal.SIGKILL):
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        break
    except PermissionError:
        sys.exit(3)
    time.sleep(3)
""";
}

/// <summary>Starts, reads, stops and watches background jobs. Jobs run as the bot's confined user inside its computer,
/// so the computer's RAM/CPU limits, network rules and file confinement all still apply.</summary>
public sealed class ComputerJobs(Platform platform, UsageMeter meter)
{
    private const string Columns = "id AS Id, owner_id AS OwnerId, bot_id AS BotId, task_id AS TaskId, conversation_id AS ConversationId, computer_id AS ComputerId, name AS Name, kind AS Kind, pid AS Pid, status AS Status, exit_code AS ExitCode, reason AS Reason, max_seconds AS MaxSeconds, job_dir AS JobDir, log_path AS LogPath, result_path AS ResultPath, log_bytes AS LogBytes, started_at AS StartedAt, finished_at AS FinishedAt";

    private async Task<(int Code, string Stdout, string Stderr)> Exec(ComputerId computer, Guid botId, IReadOnlyList<string> argv, CancellationToken ct, int seconds = 20)
    {
        var spec = await BotFs.ConfinedAsync(platform.Compute, computer, botId, argv, null, null, TimeSpan.FromSeconds(seconds), 200_000, ct);
        return await BotFs.Capture(platform.Compute, spec, ct);
    }

    public static object View(JobRow job, DateTimeOffset now)
    {
        var started = new DateTimeOffset(DateTime.SpecifyKind(job.StartedAt, DateTimeKind.Utc));
        var end = job.FinishedAt is { } finished ? new DateTimeOffset(DateTime.SpecifyKind(finished, DateTimeKind.Utc)) : now;
        return new
        {
            id = job.Id, botId = job.BotId, name = job.Name, status = job.Status, exitCode = job.ExitCode, reason = job.Reason,
            startedAt = started, finishedAt = job.FinishedAt is null ? (DateTimeOffset?)null : end,
            elapsedSeconds = (int)Math.Max(0, (end - started).TotalSeconds), maxSeconds = job.MaxSeconds,
            logPath = job.LogPath, resultPath = job.ResultPath, logBytes = job.LogBytes
        };
    }

    public async Task<JobRow?> Get(NpgsqlConnection conn, Guid id) =>
        await conn.QuerySingleOrDefaultAsync<JobRow>("SELECT " + Columns + " FROM computer_jobs WHERE id=@id", new { id });

    public async Task<IReadOnlyList<JobRow>> ListForOwner(Guid owner, Guid? botId, int limit = 20)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        return (await conn.QueryAsync<JobRow>("SELECT " + Columns + " FROM computer_jobs WHERE owner_id=@owner AND (@bot::uuid IS NULL OR bot_id=@bot) ORDER BY (status IN ('starting','running')) DESC, started_at DESC LIMIT @limit",
            new { owner, bot = botId, limit })).ToList();
    }

    public async Task<object> StartAsync(Guid owner, Guid botId, Guid taskId, ComputerId computer, JsonElement args, CancellationToken ct)
    {
        var command = args.TryGetProperty("command", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString() ?? "" : "";
        if (string.IsNullOrWhiteSpace(command)) return new { ok = false, status = "invalid", reason = "job_start requires command" };
        if (command.Length > JobRules.MaxCommandChars) return new { ok = false, status = "invalid", reason = "command is too long" };
        if (await meter.BlockReasonAsync(owner, ct) is { } blocked)
            return new { ok = false, status = "blocked", code = Credits.LimitCode, reason = blocked };
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var plan = await meter.PlanOfAsync(conn, owner);
        var running = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM computer_jobs WHERE owner_id=@owner AND status IN ('starting','running')", new { owner });
        if (running >= plan.MaxRunningJobs)
            return new { ok = false, status = "blocked", code = "job_limit", reason = $"Your plan runs up to {plan.MaxRunningJobs} background jobs at once. Wait for one to finish or stop one first." };
        double? minutes = args.TryGetProperty("max_minutes", out var m) && m.ValueKind == JsonValueKind.Number ? m.GetDouble() : null;
        var maxSeconds = JobRules.MaxSeconds(plan, minutes);
        var name = JobRules.CleanName(args.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : null, command);
        var id = Guid.NewGuid();
        var jobDir = "jobs/" + id.ToString("n");
        var conversation = await conn.ExecuteScalarAsync<Guid?>("SELECT conversation_id FROM tasks WHERE id=@taskId", new { taskId });
        await conn.ExecuteAsync("""
            INSERT INTO computer_jobs (id, owner_id, bot_id, task_id, conversation_id, computer_id, name, command_hash, status, max_seconds, job_dir, log_path, result_path)
            VALUES (@id, @owner, @botId, @taskId, @conversation, @computer, @name, @hash, 'starting', @maxSeconds, @jobDir, @log, @result)
            """, new { id, owner, botId, taskId, conversation, computer = Guid.Parse(computer.Value), name, hash = JobRules.Hash(command), maxSeconds, jobDir, log = jobDir + "/log.txt", result = jobDir + "/result" });
        int? pid = null;
        try
        {
            var (code, stdout, stderr) = await Exec(computer, botId, ["python3", "-c", JobRules.LaunchScript, id.ToString("n"), command, maxSeconds.ToString()], ct);
            if (code == 0)
            {
                using var doc = JsonDocument.Parse(stdout.Trim().Split('\n').Last());
                pid = doc.RootElement.GetProperty("pid").GetInt32();
            }
            else throw new InvalidOperationException(stderr.Length > 200 ? stderr[..200] : stderr);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            await conn.ExecuteAsync("UPDATE computer_jobs SET status='failed', reason='launch_failed', finished_at=now(), updated_at=now() WHERE id=@id", new { id });
            await platform.Audit("agent", "job.failed", botId, taskId, new { job = id, reason = "launch_failed" });
            return new { ok = false, status = "failed", job_id = id, reason = "The job could not start: " + OutputRedactor.Redact(ex.Message) };
        }
        await conn.ExecuteAsync("UPDATE computer_jobs SET status='running', pid=@pid, updated_at=now() WHERE id=@id AND status='starting'", new { id, pid });
        await platform.Audit("agent", "job.started", botId, taskId, new { job = id, name, maxSeconds, commandHash = JobRules.Hash(command) });
        await Reliability.Event(platform, taskId, "job.started", new { jobId = id, name, maxSeconds });
        await platform.PublishTo(owner, new { type = "job", botId, jobId = id, status = "running" });
        return new
        {
            ok = true, status = "running", job_id = id, name, max_minutes = Math.Round(maxSeconds / 60.0, 1),
            log_path = jobDir + "/log.txt", result_dir = jobDir + "/result",
            note = "Runs in the background. Write outputs to $JOB_RESULT_DIR. You'll be told when it ends; use job_status or job_logs to check in."
        };
    }

    public async Task<object> StatusAsync(Guid owner, Guid botId, JsonElement args, CancellationToken ct)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        if (!TryJobId(args, out var id))
        {
            var rows = await conn.QueryAsync<JobRow>("SELECT " + Columns + " FROM computer_jobs WHERE bot_id=@botId ORDER BY started_at DESC LIMIT 10", new { botId });
            return new { jobs = rows.Select(row => View(row, DateTimeOffset.UtcNow)) };
        }
        var job = await Get(conn, id);
        if (job == null || job.OwnerId != owner || job.BotId != botId) return new { ok = false, reason = "job not found" };
        return View(job, DateTimeOffset.UtcNow);
    }

    public async Task<string?> TailAsync(JobRow job, int bytes, CancellationToken ct)
    {
        var (code, stdout, _) = await Exec(new ComputerId(job.ComputerId.ToString()), job.BotId,
            ["python3", "-c", JobRules.TailScript, job.Id.ToString("n"), Math.Clamp(bytes, 256, JobRules.LogTailBytes).ToString()], ct);
        return code == 0 ? Dlp.Redact(stdout) : null;
    }

    public async Task<object> LogsAsync(Guid owner, Guid botId, JsonElement args, CancellationToken ct)
    {
        if (!TryJobId(args, out var id)) return new { ok = false, reason = "job_logs requires job_id" };
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var job = await Get(conn, id);
        if (job == null || job.OwnerId != owner || job.BotId != botId) return new { ok = false, reason = "job not found" };
        if (await ComputerAsleep(job)) return new { job_id = id, status = job.Status, log = "", note = "The computer is asleep; the log is kept on disk at " + job.LogPath };
        return new { job_id = id, status = job.Status, log = await TailAsync(job, 8_000, ct) ?? "", log_path = job.LogPath };
    }

    public async Task<object> CancelAsync(Guid owner, Guid jobId, string actor, Guid? botScope, CancellationToken ct)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var job = await Get(conn, jobId);
        if (job == null || job.OwnerId != owner || (botScope is { } scoped && job.BotId != scoped)) return new { ok = false, reason = "job not found" };
        if (!JobRules.IsActive(job.Status)) return new { ok = true, status = job.Status };
        try { await Exec(new ComputerId(job.ComputerId.ToString()), job.BotId, ["python3", "-c", JobRules.KillScript, job.Id.ToString("n")], ct); }
        catch (Exception ex) when (ex is not OperationCanceledException) { /* a stopped computer already ended the process */ }
        await Finish(conn, job, "cancelled", "stopped_by_" + actor, null);
        return new { ok = true, status = "cancelled", job_id = jobId };
    }

    private static bool TryJobId(JsonElement args, out Guid id)
    {
        id = Guid.Empty;
        return args.ValueKind == JsonValueKind.Object && args.TryGetProperty("job_id", out var value) && value.ValueKind == JsonValueKind.String && Guid.TryParse(value.GetString(), out id);
    }

    private Task<bool> ComputerAsleep(JobRow job) =>
        Task.FromResult(platform.Compute.PowerSnapshot().FirstOrDefault(item => item.Id == job.ComputerId.ToString()).Power is not "awake");

    /// <summary>Close a job once: status, chat notice, event, audit, and restart the idle timer.</summary>
    public async Task Finish(NpgsqlConnection conn, JobRow job, string status, string? reason, int? exitCode)
    {
        var finished = await conn.ExecuteScalarAsync<DateTime?>("""
            UPDATE computer_jobs SET status=@status, reason=@reason, exit_code=@exitCode, finished_at=now(), updated_at=now()
            WHERE id=@id AND status IN ('starting','running') RETURNING finished_at
            """, new { id = job.Id, status, reason, exitCode });
        if (finished is null) return;
        var took = DateTime.SpecifyKind(finished.Value, DateTimeKind.Utc) - DateTime.SpecifyKind(job.StartedAt, DateTimeKind.Utc);
        platform.Compute.NoteActivity(new ComputerId(job.ComputerId.ToString()));
        await platform.Audit("agent", "job." + status, job.BotId, job.TaskId, new { job = job.Id, reason, exitCode, seconds = (int)took.TotalSeconds });
        if (job.TaskId is { } task)
        {
            try { await Reliability.Event(platform, task, "job." + (status == "done" ? "done" : "failed"), new { jobId = job.Id, name = job.Name, status, exitCode }); }
            catch { /* the task row may be gone */ }
        }
        if (job.ConversationId is { } conversation)
        {
            var content = JobRules.Notice(job.Name, status, took, job.ResultPath);
            await conn.ExecuteAsync("INSERT INTO messages(conversation_id,role,kind,content,task_id) VALUES(@conversation,'assistant','text',@content,@task)",
                new { conversation, content, task = job.TaskId });
            await conn.ExecuteAsync("UPDATE computer_jobs SET notified_at=now() WHERE id=@id", new { id = job.Id });
            await platform.Publish(new { type = "message", conversationId = conversation });
        }
        await platform.PublishTo(job.OwnerId, new { type = "job", botId = job.BotId, jobId = job.Id, status });
    }

    /// <summary>Maintenance: probe running jobs, close finished ones, enforce max run time, reconcile after restarts.</summary>
    public async Task WatchAsync(CancellationToken ct)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var active = (await conn.QueryAsync<JobRow>("SELECT " + Columns + " FROM computer_jobs WHERE status IN ('starting','running')")).ToList();
        if (active.Count == 0) return;
        var power = platform.Compute.PowerSnapshot().ToDictionary(item => item.Id, item => item.Power);
        var now = DateTimeOffset.UtcNow;
        foreach (var group in active.GroupBy(job => (job.ComputerId, job.BotId)))
        {
            var state = power.TryGetValue(group.Key.ComputerId.ToString(), out var p) ? p : "stopped";
            if (state == "paused") continue; // a paused container keeps its processes; probe after it wakes
            if (state == "stopped")
            {
                foreach (var job in group) await Finish(conn, job, "failed", "computer_stopped", null);
                continue;
            }
            Dictionary<string, JobProbe> probes;
            try
            {
                var (code, stdout, _) = await Exec(new ComputerId(group.Key.ComputerId.ToString()), group.Key.BotId,
                    ["python3", "-c", JobRules.ProbeScript, .. group.Select(job => job.Id.ToString("n"))], ct);
                if (code != 0) continue;
                probes = JsonSerializer.Deserialize<Dictionary<string, JobProbe>>(stdout, new JsonSerializerOptions(JsonSerializerDefaults.Web)) ?? [];
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { continue; }
            foreach (var job in group)
            {
                if (!probes.TryGetValue(job.Id.ToString("n"), out var probe)) continue;
                if (job.Status == "starting" && now - DateTime.SpecifyKind(job.StartedAt, DateTimeKind.Utc) < TimeSpan.FromSeconds(30)) continue;
                await conn.ExecuteAsync("UPDATE computer_jobs SET log_bytes=@log, updated_at=now() WHERE id=@id", new { id = job.Id, log = probe.Log });
                var started = new DateTimeOffset(DateTime.SpecifyKind(job.StartedAt, DateTimeKind.Utc));
                if (JobRules.Outcome(probe, started, job.MaxSeconds, now) is not { } outcome) continue;
                if (outcome.Status == "timed_out" && probe.Exit is null)
                {
                    try { await Exec(new ComputerId(job.ComputerId.ToString()), job.BotId, ["python3", "-c", JobRules.KillScript, job.Id.ToString("n")], ct); }
                    catch (Exception ex) when (ex is not OperationCanceledException) { }
                }
                await Finish(conn, job, outcome.Status, outcome.Reason, probe.Exit);
            }
        }
    }
}
