using System.Text.Json;
using Dapper;
using Npgsql;

namespace Teammates.Api;

/// <summary>One schedule request, as it comes from the HTTP route or a bot tool. Null fields on an update mean "leave as is".</summary>
public sealed record RoutineSpec(
    string? Name = null, string? Instruction = null, string? Cron = null, DateTimeOffset? RunAt = null, string? Timezone = null,
    DateTimeOffset? ExpiresAt = null, string? QuietRule = null, bool Exact = false, string? WatchKind = null, string? WatchRef = null);

public sealed record RoutineOutcome(bool Ok, string? Error = null, Guid? Id = null, object? Data = null)
{
    public static RoutineOutcome Fail(string code) => new(false, code);
}

/// <summary>The one place that validates, schedules and changes routines. The panel's HTTP routes, the bot tools and the scheduler all go through it.</summary>
public static class RoutineService
{
    public const int MinMinutes = 5;
    public const int MaxPerBot = 10;
    public const int MaxNameChars = 80;
    public const int MaxInstructionChars = 8000;
    public const string OnceCron = "@once";
    public const string QuietSentinel = "NOTHING_NEW";
    public const int HistoryKept = 20;
    public const int FailuresBeforePause = 3;

    public static readonly IReadOnlyDictionary<string, string> ErrorSentences = new Dictionary<string, string>
    {
        ["invalid_name"] = "The routine needs a name of up to 80 characters.",
        ["invalid_instruction"] = "The routine needs an instruction of up to 8000 characters.",
        ["invalid_cron"] = "That schedule is not a valid 5-field cron expression.",
        ["interval_too_short"] = "Routines must be at least 5 minutes apart.",
        ["schedule_required"] = "Give either a cron schedule or a one-off run time.",
        ["run_at_in_past"] = "The run time is in the past.",
        ["run_at_too_far"] = "A one-off reminder can be at most one year ahead.",
        ["unknown_timezone"] = "That timezone is not a known IANA zone.",
        ["dlp_blocked"] = "The routine text looks like it contains a secret.",
        ["routine_limit"] = "This teammate already has the maximum of 10 routines.",
        ["routine_not_found"] = "No such routine.",
        ["get_routine_required"] = "Call get_routine for this routine first, then edit the saved text.",
        ["nothing_to_update"] = "Nothing to change.",
        ["expired"] = "That routine has already finished."
    };

    public static string Sentence(string code) => ErrorSentences.TryGetValue(code, out var text) ? text : "The request was refused.";

    /// <summary>Checks the schedule part of a spec. Returns an error code, or null and the normalised kind.</summary>
    public static string? CheckSchedule(string? cron, DateTimeOffset? runAt, DateTimeOffset now, out string kind)
    {
        kind = runAt != null ? "once" : "recurring";
        if (runAt != null)
        {
            if (runAt <= now) return "run_at_in_past";
            if (runAt > now.AddYears(1)) return "run_at_too_far";
            return null;
        }
        if (string.IsNullOrWhiteSpace(cron)) return "schedule_required";
        var gap = PeerLimits.CronGapMinutes(cron.Trim());
        if (gap == null) return "invalid_cron";
        if (gap < MinMinutes) return "interval_too_short";
        return null;
    }

    private static string? CheckText(string? name, string? instruction, bool required)
    {
        if (name != null && (name.Trim().Length is < 1 or > MaxNameChars)) return "invalid_name";
        if (instruction != null && (instruction.Trim().Length == 0 || instruction.Length > MaxInstructionChars)) return "invalid_instruction";
        if (required && (name == null || instruction == null)) return name == null ? "invalid_name" : "invalid_instruction";
        if (Dlp.HasStrict((name ?? "") + " " + (instruction ?? ""))) return "dlp_blocked";
        return null;
    }

    public static object Shape(dynamic r, IEnumerable<object>? runs = null)
    {
        string kind = r.kind; string cron = r.cron; string zone = r.timezone;
        DateTimeOffset? runAt = r.run_at == null ? null : new DateTimeOffset((DateTime)r.run_at);
        return new
        {
            id = (Guid)r.id, botId = (Guid)r.bot_id, name = (string)r.name, instruction = (string)r.instruction, cron, timezone = zone, kind,
            runAt, nextRunAt = r.next_run_at == null ? (DateTimeOffset?)null : new DateTimeOffset((DateTime)r.next_run_at),
            enabled = (bool)r.enabled, expiresAt = r.expires_at == null ? (DateTimeOffset?)null : new DateTimeOffset((DateTime)r.expires_at),
            jitterSeconds = (int)r.jitter_seconds, failureStreak = (int)r.failure_streak, pausedReason = (string?)r.paused_reason, quietRule = (string?)r.quiet_rule,
            watchKind = (string)r.watch_kind, watchRef = (string)r.watch_ref,
            human = CronWords.ForRoutine(kind, cron, runAt, zone), runs
        };
    }

    private const string Columns = "r.id, r.bot_id, r.name, r.instruction, r.cron, r.timezone, r.kind, r.run_at, r.next_run_at, r.enabled, r.expires_at, r.jitter_seconds, r.failure_streak, r.paused_reason, r.quiet_rule, r.watch_kind, r.watch_ref, r.created_at";

    public static async Task<object?> Load(NpgsqlConnection conn, Guid id, Guid owner) =>
        (object?)await conn.QuerySingleOrDefaultAsync($"SELECT {Columns} FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=@id AND b.owner_id=@owner", new { id, owner });

    public static async Task<IEnumerable<object>> RecentRuns(NpgsqlConnection conn, Guid routineId, int take = HistoryKept)
    {
        var rows = await conn.QueryAsync("SELECT id, task_id, status, triggered_at, finished_at, scheduled_for, error, skip_reason, summary, notified FROM routine_runs WHERE routine_id=@routineId ORDER BY triggered_at DESC LIMIT @take", new { routineId, take });
        return rows.Select(x => (object)new
        {
            id = (Guid)x.id, taskId = (Guid?)x.task_id, status = (string)x.status, triggeredAt = new DateTimeOffset((DateTime)x.triggered_at),
            finishedAt = x.finished_at == null ? (DateTimeOffset?)null : new DateTimeOffset((DateTime)x.finished_at),
            scheduledFor = x.scheduled_for == null ? (DateTimeOffset?)null : new DateTimeOffset((DateTime)x.scheduled_for),
            error = (string?)x.error, skipReason = (string?)x.skip_reason, summary = (string?)x.summary, notified = (bool)x.notified
        }).ToList();
    }

    public static async Task<RoutineOutcome> Get(NpgsqlConnection conn, Guid id, Guid owner)
    {
        dynamic? row = await Load(conn, id, owner);
        if (row == null) return RoutineOutcome.Fail("routine_not_found");
        return new RoutineOutcome(true, null, id, Shape((object)row, await RecentRuns(conn, id)));
    }

    public static async Task<IReadOnlyList<object>> List(NpgsqlConnection conn, Guid botId)
    {
        var rows = await conn.QueryAsync($"SELECT {Columns} FROM routines r WHERE r.bot_id=@botId ORDER BY r.created_at", new { botId });
        return rows.Select(r => Shape((object)r)).ToList();
    }

    public static async Task<RoutineOutcome> Create(NpgsqlConnection conn, Guid botId, Guid owner, RoutineSpec spec, Guid? creatorBot = null, int originDepth = 0, DateTimeOffset? now = null)
    {
        var clock = now ?? DateTimeOffset.UtcNow;
        if (CheckText(spec.Name, spec.Instruction, true) is { } textError) return RoutineOutcome.Fail(textError);
        if (CheckSchedule(spec.Cron, spec.RunAt, clock, out var kind) is { } scheduleError) return RoutineOutcome.Fail(scheduleError);
        var zoneId = spec.Timezone != null
            ? (RoutineTime.TryZone(spec.Timezone, out _) ? spec.Timezone.Trim() : null)
            : await RoutineTime.BotOwnerZoneId(conn, botId);
        if (zoneId == null) return RoutineOutcome.Fail("unknown_timezone");
        if (await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM routines WHERE bot_id=@botId", new { botId }) >= MaxPerBot) return RoutineOutcome.Fail("routine_limit");
        var id = Guid.NewGuid();
        var cron = kind == "once" ? OnceCron : spec.Cron!.Trim();
        var nominal = kind == "once" ? spec.RunAt!.Value : RoutineTime.Next(cron, clock, zoneId);
        var jitter = kind == "once" || spec.Exact ? 0 : RoutineSchedule.JitterSeconds(id, cron);
        var next = nominal.AddSeconds(jitter);
        await conn.ExecuteAsync(
            @"INSERT INTO routines (id, bot_id, name, cron, timezone, instruction, next_run_at, nominal_next_at, kind, run_at, jitter_seconds, expires_at, quiet_rule, watch_kind, watch_ref, created_by_bot_id, origin_depth)
              VALUES (@id, @botId, @name, @cron, @zoneId, @instruction, @next, @nominal, @kind, @runAt, @jitter, @expiresAt, @quiet, @watchKind, @watchRef, @creator, @depth)",
            new
            {
                id, botId, name = spec.Name!.Trim(), cron, zoneId, instruction = spec.Instruction, next = next.ToUniversalTime(), nominal = nominal.ToUniversalTime(), kind, runAt = spec.RunAt?.ToUniversalTime(), jitter, expiresAt = spec.ExpiresAt?.ToUniversalTime(),
                quiet = string.IsNullOrWhiteSpace(spec.QuietRule) ? null : spec.QuietRule.Trim(),
                watchKind = spec.WatchKind is "http" or "memory" ? spec.WatchKind : "", watchRef = (spec.WatchRef ?? "")[..Math.Min((spec.WatchRef ?? "").Length, 500)],
                creator = creatorBot, depth = originDepth
            });
        dynamic row = (await Load(conn, id, owner))!;
        return new RoutineOutcome(true, null, id, Shape((object)row));
    }

    public static async Task<RoutineOutcome> Update(NpgsqlConnection conn, Guid id, Guid owner, RoutineSpec spec, DateTimeOffset? now = null)
    {
        var clock = now ?? DateTimeOffset.UtcNow;
        dynamic? before = await Load(conn, id, owner);
        if (before == null) return RoutineOutcome.Fail("routine_not_found");
        if (CheckText(spec.Name, spec.Instruction, false) is { } textError) return RoutineOutcome.Fail(textError);
        string kind = before.kind, cron = before.cron, zoneId = before.timezone;
        DateTimeOffset? runAt = before.run_at == null ? null : new DateTimeOffset((DateTime)before.run_at);
        var scheduleChanged = false;
        if (spec.Timezone != null)
        {
            if (!RoutineTime.TryZone(spec.Timezone, out _)) return RoutineOutcome.Fail("unknown_timezone");
            zoneId = spec.Timezone.Trim(); scheduleChanged = true;
        }
        if (spec.RunAt != null)
        {
            if (CheckSchedule(null, spec.RunAt, clock, out _) is { } e) return RoutineOutcome.Fail(e);
            kind = "once"; runAt = spec.RunAt; cron = OnceCron; scheduleChanged = true;
        }
        else if (spec.Cron != null)
        {
            if (CheckSchedule(spec.Cron, null, clock, out _) is { } e) return RoutineOutcome.Fail(e);
            kind = "recurring"; runAt = null; cron = spec.Cron.Trim(); scheduleChanged = true;
        }
        var name = spec.Name?.Trim() ?? (string)before.name;
        var instruction = spec.Instruction ?? (string)before.instruction;
        var quiet = spec.QuietRule != null ? (spec.QuietRule.Trim().Length == 0 ? null : spec.QuietRule.Trim()) : (string?)before.quiet_rule;
        DateTimeOffset? expires = spec.ExpiresAt ?? (before.expires_at == null ? null : new DateTimeOffset((DateTime)before.expires_at));
        if (spec.Name == null && spec.Instruction == null && spec.QuietRule == null && spec.ExpiresAt == null && !scheduleChanged) return RoutineOutcome.Fail("nothing_to_update");
        var enabled = (bool)before.enabled;
        var jitter = (int)before.jitter_seconds;
        DateTimeOffset? next = before.next_run_at == null ? null : new DateTimeOffset((DateTime)before.next_run_at);
        DateTimeOffset? nominal = null;
        if (scheduleChanged)
        {
            nominal = kind == "once" ? runAt : RoutineTime.Next(cron, clock, zoneId);
            jitter = kind == "once" || spec.Exact ? 0 : RoutineSchedule.JitterSeconds(id, cron);
            next = enabled ? nominal?.AddSeconds(jitter) : null;
        }
        await conn.ExecuteAsync(
            @"UPDATE routines SET name=@name, instruction=@instruction, cron=@cron, timezone=@zoneId, kind=@kind, run_at=@runAt, quiet_rule=@quiet, expires_at=@expires,
                  jitter_seconds=@jitter, next_run_at=@next, nominal_next_at=CASE WHEN @scheduleChanged THEN @nominal ELSE nominal_next_at END WHERE id=@id",
            new { id, name, instruction, cron, zoneId, kind, runAt = runAt?.ToUniversalTime(), quiet, expires = expires?.ToUniversalTime(), jitter, next = next?.ToUniversalTime(), nominal = nominal?.ToUniversalTime(), scheduleChanged });
        dynamic after = (await Load(conn, id, owner))!;
        return new RoutineOutcome(true, null, id, new { before = Shape((object)before), after = Shape((object)after) });
    }

    /// <summary>Pause or resume. A pause by the user clears the paused reason; the scheduler passes its own reason when it pauses a failing routine.</summary>
    public static async Task<RoutineOutcome> SetEnabled(NpgsqlConnection conn, Guid id, Guid owner, bool enabled, string? reason = null, DateTimeOffset? now = null)
    {
        dynamic? row = await Load(conn, id, owner);
        if (row == null) return RoutineOutcome.Fail("routine_not_found");
        var clock = now ?? DateTimeOffset.UtcNow;
        DateTimeOffset? next = null;
        if (enabled)
        {
            string kind = row.kind;
            if (kind == "once")
            {
                var runAt = row.run_at == null ? (DateTimeOffset?)null : new DateTimeOffset((DateTime)row.run_at);
                if (runAt == null || runAt <= clock) return RoutineOutcome.Fail("expired");
                next = runAt;
            }
            else next = RoutineToggle.NextAfterEnable((string)row.cron, clock, (string)row.timezone);
            if (next != null && row.jitter_seconds is int j && j > 0) next = next.Value.AddSeconds(j);
        }
        await conn.ExecuteAsync("UPDATE routines SET enabled=@enabled, next_run_at=@next, nominal_next_at=@next, paused_reason=@reason, failure_streak=CASE WHEN @enabled THEN 0 ELSE failure_streak END WHERE id=@id",
            new { id, enabled, next, reason = enabled ? null : reason });
        dynamic after = (await Load(conn, id, owner))!;
        return new RoutineOutcome(true, null, id, Shape((object)after));
    }

    public static async Task<RoutineOutcome> Delete(NpgsqlConnection conn, Guid id, Guid owner)
    {
        dynamic? row = await Load(conn, id, owner);
        if (row == null) return RoutineOutcome.Fail("routine_not_found");
        await conn.ExecuteAsync("DELETE FROM routines WHERE id=@id", new { id });
        return new RoutineOutcome(true, null, id, new { id, name = (string)row.name });
    }
}
