using Teammates.Api;

namespace Teammates.UnitTests;

public class RoutineToggleTests
{
    [Fact]
    public void EnablingRecomputesNextRunFromNow()
    {
        var now = new DateTimeOffset(2026, 10, 23, 10, 30, 0, TimeSpan.Zero);
        var next = RoutineToggle.NextAfterEnable("0 12 * * *", now, "UTC");
        Assert.Equal(new DateTimeOffset(2026, 10, 23, 12, 0, 0, TimeSpan.Zero), next);
    }

    [Fact]
    public void InvalidCronYieldsNoSchedule()
    {
        Assert.Null(RoutineToggle.NextAfterEnable("nonsense", DateTimeOffset.UtcNow, "UTC"));
    }
}
