using Dapper;
using Npgsql;

namespace Teammates.Api;

/// <summary>Run lifecycle for routines: the scheduler tick that starts runs, and the hooks that close them when the task ends.</summary>
public static class RoutineRuns
{
    public delegate Task<string?> Watcher(string kind, string reference, Guid botId, CancellationToken ct);

    private sealed record Claimed(Guid Id, Guid BotId, string Instruction, string Name, string Kind, string Cron, string Timezone, string? QuietRule,
        DateTime? Nominal, DateTime? RunAt, int Jitter, DateTime? ExpiresAt, string WatchKind, string WatchRef, string WatchFingerprint);

    /// <summary>Start every routine that is due. Rows are claimed with FOR UPDATE SKIP LOCKED, so two API instances never start the same run.</summary>
    public static async Task Tick(Platform platform, NpgsqlConnection conn, DateTimeOffset now, Watcher watch, CancellationToken ct)
    {
        await conn.ExecuteAsync("UPDATE routine_runs rr SET status='running' FROM tasks t WHERE rr.task_id=t.id AND rr.status='queued' AND t.status IN ('running','planning')");
        var unscheduled = await conn.QueryAsync<(Guid Id, string Cron, string Timezone)>(
            "SELECT id, cron, timezone FROM routines WHERE enabled AND next_run_at IS NULL AND kind='recurring' AND (last_run_at IS NULL OR last_run_at < now() - interval '2 minutes')");
        foreach (var item in unscheduled)
        {
            var fresh = RoutineTime.NextOrNull(item.Cron, now, item.Timezone);
            if (fresh != null) await conn.ExecuteAsync("UPDATE routines SET next_run_at=@fresh, nominal_next_at=@fresh WHERE id=@id AND next_run_at IS NULL", new { id = item.Id, fresh });
        }
        var claimed = (await conn.QueryAsync<Claimed>(
            @"UPDATE routines r SET last_run_at=now(), next_run_at=NULL
              WHERE r.id IN (SELECT id FROM routines WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= now() ORDER BY next_run_at LIMIT 50 FOR UPDATE SKIP LOCKED)
              RETURNING r.id AS Id, r.bot_id AS BotId, r.instruction AS Instruction, r.name AS Name, r.kind AS Kind, r.cron AS Cron, r.timezone AS Timezone, r.quiet_rule AS QuietRule,
                        r.nominal_next_at AS Nominal, r.run_at AS RunAt, r.jitter_seconds AS Jitter, r.expires_at AS ExpiresAt,
                        coalesce(r.watch_kind,'') AS WatchKind, coalesce(r.watch_ref,'') AS WatchRef, coalesce(r.watch_fingerprint,'') AS WatchFingerprint")).ToList();
        foreach (var routine in claimed)
        {
            try { await StartOne(platform, conn, routine, now, watch, ct); }
            catch (Exception)
            {
                // Never leave a claimed routine without a next run.
                await conn.ExecuteAsync("UPDATE routines SET next_run_at=now() + interval '1 minute' WHERE id=@id AND enabled AND next_run_at IS NULL", new { id = routine.Id });
                throw;
            }
        }
    }

    private static async Task Skip(NpgsqlConnection conn, Guid routine, DateTimeOffset? scheduledFor, string reason) =>
        await conn.ExecuteAsync("INSERT INTO routine_runs (routine_id, status, scheduled_for, skip_reason, finished_at) VALUES (@routine, 'skipped', @scheduledFor, @reason, now())", new { routine, scheduledFor, reason });

    private static async Task StartOne(Platform platform, NpgsqlConnection conn, Claimed r, DateTimeOffset now, Watcher watch, CancellationToken ct)
    {
        DateTimeOffset? scheduledFor = r.Nominal == null ? null : new DateTimeOffset(DateTime.SpecifyKind(r.Nominal.Value, DateTimeKind.Utc));
        var due = scheduledFor ?? now;
        var expired = r.ExpiresAt != null && new DateTimeOffset(DateTime.SpecifyKind(r.ExpiresAt.Value, DateTimeKind.Utc)) <= now;
        if (expired)
        {
            await conn.ExecuteAsync("UPDATE routines SET enabled=false, next_run_at=NULL, paused_reason='expired' WHERE id=@id", new { id = r.Id });
            return;
        }
        var run = true;
        string? skipReason = null;
        if (RoutineSchedule.TooLate(r.Kind, due, now)) { run = false; skipReason = "missed_window"; }
        if (run && r.WatchKind is "http" or "memory")
        {
            var material = await watch(r.WatchKind, r.WatchRef, r.BotId, ct);
            if (material == null || !RoutineWatch.Changed(r.WatchFingerprint, RoutineWatch.Fingerprint(material))) { run = false; skipReason = "nothing_changed"; }
            else await conn.ExecuteAsync("UPDATE routines SET watch_fingerprint=@fp WHERE id=@id", new { id = r.Id, fp = RoutineWatch.Fingerprint(material) });
        }
        if (run && await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM tasks WHERE routine_id=@id AND status IN ('queued','running','planning','waiting_approval','waiting_human')", new { id = r.Id }) > 0)
        { run = false; skipReason = "previous_run_active"; }
        if (!run) await Skip(conn, r.Id, due, skipReason!);
        else
        {
            var conversation = await conn.ExecuteScalarAsync<Guid>("SELECT id FROM conversations WHERE bot_id=@id ORDER BY created_at LIMIT 1", new { id = r.BotId });
            var local = TimeZoneInfo.ConvertTime(due, RoutineTime.Zone(r.Timezone)).ToString("ddd d MMM HH:mm") + " " + r.Timezone;
            var instruction = RoutineSchedule.Framing(r.Name, r.Instruction, r.QuietRule, local);
            var task = await conn.ExecuteScalarAsync<Guid>(
                "INSERT INTO tasks (bot_id, conversation_id, title, instruction, kind, routine_id, status, origin_depth) VALUES (@bot, @conversation, @title, @instruction, 'work', @routine, 'queued', COALESCE((SELECT origin_depth FROM routines WHERE id=@routine),0)) RETURNING id",
                new { bot = r.BotId, conversation, title = r.Name, instruction, routine = r.Id });
            await conn.ExecuteAsync("INSERT INTO routine_runs (routine_id, task_id, status, scheduled_for) VALUES (@routine, @task, 'queued', @due)", new { routine = r.Id, task, due });
            platform.Tasks.Pulse();
        }
        await Prune(conn, r.Id);
        if (r.Kind == "once")
        {
            await conn.ExecuteAsync("UPDATE routines SET enabled=false, next_run_at=NULL, paused_reason=@reason WHERE id=@id", new { id = r.Id, reason = run ? "ran" : "missed" });
            return;
        }
        var nominal = RoutineTime.NextOrNull(r.Cron, now, r.Timezone) ?? now.AddHours(1);
        await conn.ExecuteAsync("UPDATE routines SET nominal_next_at=@nominal, next_run_at=@next WHERE id=@id", new { id = r.Id, nominal, next = nominal.AddSeconds(r.Jitter) });
    }

    public static async Task Prune(NpgsqlConnection conn, Guid routineId) =>
        await conn.ExecuteAsync("DELETE FROM routine_runs WHERE routine_id=@routineId AND id NOT IN (SELECT id FROM routine_runs WHERE routine_id=@routineId ORDER BY triggered_at DESC LIMIT @keep)", new { routineId, keep = RoutineService.HistoryKept });

    /// <summary>True when this task is a routine run whose answer is only the quiet sentinel: nothing to show or notify.</summary>
    public static async Task<bool> IsQuiet(NpgsqlConnection conn, Guid taskId, string? text)
    {
        var rule = await conn.ExecuteScalarAsync<string?>("SELECT r.quiet_rule FROM tasks t JOIN routines r ON r.id=t.routine_id WHERE t.id=@taskId", new { taskId });
        return RoutineSchedule.IsQuiet(rule, text);
    }

    /// <summary>Close the run row for a finished task. Three failures in a row pause the routine and tell the user in chat.</summary>
    public static async Task Finish(Platform platform, NpgsqlConnection conn, Guid taskId, bool ok, string? text, string? error, bool quiet)
    {
        var run = await conn.QuerySingleOrDefaultAsync<(Guid Id, Guid RoutineId)?>(
            @"UPDATE routine_runs SET status=@status, finished_at=now(), error=@error, summary=@summary, notified=@notified
              WHERE task_id=@taskId AND status IN ('queued','running') RETURNING id, routine_id",
            new { taskId, status = ok ? "completed" : "failed", error = error == null ? null : RoutineSchedule.Excerpt(error), summary = ok ? RoutineSchedule.Excerpt(quiet ? null : text) : null, notified = !quiet });
        if (run == null) return;
        var routineId = run.Value.RoutineId;
        if (ok)
        {
            await conn.ExecuteAsync("UPDATE routines SET failure_streak=0 WHERE id=@routineId", new { routineId });
            return;
        }
        var row = await conn.QuerySingleOrDefaultAsync<(string Name, int Streak, Guid BotId)>(
            "UPDATE routines SET failure_streak=failure_streak+1 WHERE id=@routineId RETURNING name, failure_streak, bot_id", new { routineId });
        if (row.Name == null || row.Streak < RoutineService.FailuresBeforePause) return;
        var paused = await conn.ExecuteAsync("UPDATE routines SET enabled=false, next_run_at=NULL, paused_reason='failed_repeatedly' WHERE id=@routineId AND enabled", new { routineId });
        if (paused == 0) return;
        var conversation = await conn.ExecuteScalarAsync<Guid?>("SELECT id FROM conversations WHERE bot_id=@bot ORDER BY created_at LIMIT 1", new { bot = row.BotId });
        var notice = $"I paused the routine \"{row.Name}\" after {RoutineService.FailuresBeforePause} failed runs in a row. Resume it from the Routines tab once it is fixed.";
        if (conversation != null)
            await conn.ExecuteAsync("INSERT INTO messages (conversation_id, role, content) VALUES (@conversation, 'assistant', @notice)", new { conversation, notice });
        var owner = await conn.ExecuteScalarAsync<Guid?>("SELECT owner_id FROM bots WHERE id=@bot", new { bot = row.BotId });
        if (owner != null) await platform.Notify(owner.Value, "routine.paused", "Routine paused", notice);
        await platform.Audit("system", "routine.auto_pause", row.BotId, taskId, new { routineId, streak = row.Streak });
    }
}
