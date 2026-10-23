namespace Teammates.Compute;

public enum IdlePowerMode
{
    Pause,
    Reclaim,
    Hibernate
}

public static class ComputerPower
{
    public static IdlePowerMode ParseMode(string? raw)
    {
        return raw?.Trim().ToLowerInvariant() switch
        {
            "pause" => IdlePowerMode.Pause,
            "reclaim" => IdlePowerMode.Reclaim,
            _ => IdlePowerMode.Hibernate
        };
    }

    public static bool ShouldSuspend(DateTimeOffset now, DateTimeOffset lastActivity, DateTimeOffset viewerUntil, bool busy, TimeSpan idle)
    {
        if (idle <= TimeSpan.Zero || busy) return false;
        if (viewerUntil > now) return false;
        return now - lastActivity >= idle;
    }

    /// <summary>
    /// Hibernate (stop the container) is the step that returns anonymous RAM.
    /// Reclaim mode pauses first, then hibernates only after the longer window.
    /// </summary>
    public static bool ShouldHibernate(IdlePowerMode mode, DateTimeOffset now, DateTimeOffset lastActivity, DateTimeOffset viewerUntil, bool busy, TimeSpan suspendAfter, TimeSpan hibernateAfter)
    {
        if (mode == IdlePowerMode.Pause) return false;
        var window = mode == IdlePowerMode.Hibernate ? suspendAfter : hibernateAfter;
        return ShouldSuspend(now, lastActivity, viewerUntil, busy, window);
    }
}
