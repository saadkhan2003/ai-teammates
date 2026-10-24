using Dapper;
using System.Data.Common;
using System.Diagnostics;

namespace Teammates.Api;

public sealed record AttemptSummary(int Count, double MedianWallSeconds, int MaxWallSeconds, int HourlyCutCount);
public sealed record AttemptLogRow(int WallSeconds);

public static class AttemptLog
{
    private static readonly DateTimeOffset StartedAt = Process.GetCurrentProcess().StartTime;

    public static Task Record(DbConnection conn, DbTransaction? tx, Guid taskId, int attempt,
        DateTimeOffset startedAt, DateTimeOffset endedAt, int toolCalls, string endReason,
        bool progress, string? worker)
    {
        var wallSeconds = Math.Max(0, (int)(endedAt - startedAt).TotalSeconds);
        var uptimeSeconds = Math.Max(0, (int)(endedAt - StartedAt).TotalSeconds);
        return conn.ExecuteAsync("""
            INSERT INTO task_attempt_log(task_id,attempt,started_at,ended_at,wall_seconds,tool_calls,end_reason,progress,worker,api_uptime_seconds)
            VALUES(@taskId,@attempt,@startedAt,@endedAt,@wallSeconds,@toolCalls,@endReason,@progress,@worker,@uptimeSeconds)
            """, new { taskId, attempt, startedAt, endedAt, wallSeconds, toolCalls = Math.Max(0, toolCalls), endReason, progress, worker, uptimeSeconds }, tx);
    }

    public static AttemptSummary Summarize(IEnumerable<int> wallSeconds)
    {
        var rows = wallSeconds.ToArray();
        if (rows.Length == 0) return new(0, 0, 0, 0);
        var sorted = rows.Order().ToArray();
        var mid = sorted.Length / 2;
        var median = sorted.Length % 2 == 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2d;
        return new(rows.Length, median, sorted[^1], rows.Count(x => x is >= 3300 and <= 3900));
    }

    public static AttemptSummary Summarize(IEnumerable<AttemptLogRow> rows) => Summarize(rows.Select(row => row.WallSeconds));
}
