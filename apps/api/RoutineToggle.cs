namespace Teammates.Api;

/// <summary>Enabling a routine recomputes its next run from now so a long-disabled routine never fires a backlog.</summary>
public static class RoutineToggle
{
    public static DateTimeOffset? NextAfterEnable(string cron, DateTimeOffset now, string? zoneId = null)
    {
        try { return RoutineTime.Next(cron, now, zoneId); }
        catch { return null; }
    }
}
