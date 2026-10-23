namespace Teammates.Api;

/// <summary>Timing rules that spread load. Filled in by the jitter step.</summary>
public static class RoutineSchedule
{
    public static int JitterSeconds(Guid routineId, string cron) => 0;
}
