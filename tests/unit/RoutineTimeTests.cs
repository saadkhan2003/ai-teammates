using Teammates.Api;

namespace Teammates.UnitTests;

public class RoutineTimeTests
{
    [Fact]
    public void EightAmInKarachiIsThreeAmUtc()
    {
        var after = new DateTimeOffset(2026, 10, 23, 0, 0, 0, TimeSpan.Zero);
        var next = RoutineTime.Next("0 8 * * *", after, "Asia/Karachi");
        Assert.Equal(new DateTimeOffset(2026, 10, 23, 3, 0, 0, TimeSpan.Zero), next.ToUniversalTime());
        Assert.Equal(TimeSpan.FromHours(5), next.Offset);
    }

    [Fact]
    public void SameCronInUtcIsDifferent()
    {
        var after = new DateTimeOffset(2026, 10, 23, 0, 0, 0, TimeSpan.Zero);
        Assert.Equal(new DateTimeOffset(2026, 10, 23, 8, 0, 0, TimeSpan.Zero), RoutineTime.Next("0 8 * * *", after, "UTC").ToUniversalTime());
    }

    [Fact]
    public void AfterTodaysLocalRunTheNextIsTomorrow()
    {
        var after = new DateTimeOffset(2026, 10, 23, 3, 0, 0, TimeSpan.Zero); // exactly 08:00 in Karachi
        var next = RoutineTime.Next("0 8 * * *", after, "Asia/Karachi");
        Assert.Equal(new DateTimeOffset(2026, 10, 24, 3, 0, 0, TimeSpan.Zero), next.ToUniversalTime());
    }

    [Fact]
    public void UnknownZoneFallsBackToTheUserDefault()
    {
        var after = new DateTimeOffset(2026, 10, 23, 0, 0, 0, TimeSpan.Zero);
        Assert.Equal(RoutineTime.Next("0 8 * * *", after, "Asia/Karachi"), RoutineTime.Next("0 8 * * *", after, "Mars/Olympus"));
        Assert.False(RoutineTime.TryZone("Mars/Olympus", out _));
        Assert.False(RoutineTime.TryZone("", out _));
        Assert.True(RoutineTime.TryZone("America/New_York", out _));
    }

    [Fact]
    public void SpringForwardGapStillFiresOnce()
    {
        // 2026-03-08 02:30 does not exist in New York. The run must still land that day, exactly once.
        var after = new DateTimeOffset(2026, 3, 8, 6, 0, 0, TimeSpan.Zero); // 01:00 EST
        var first = RoutineTime.Next("30 2 * * *", after, "America/New_York");
        Assert.Equal(new DateTime(2026, 3, 8), TimeZoneInfo.ConvertTime(first, RoutineTime.Zone("America/New_York")).Date);
        var second = RoutineTime.Next("30 2 * * *", first, "America/New_York");
        Assert.True(second > first.AddHours(20));
    }

    [Fact]
    public void FallBackHourDoesNotFireTwice()
    {
        // 2026-11-01 01:30 happens twice in New York. After the first one, the next run is the next day.
        var firstInstant = new DateTimeOffset(2026, 11, 1, 5, 30, 0, TimeSpan.Zero); // 01:30 EDT
        var next = RoutineTime.Next("30 1 * * *", firstInstant, "America/New_York");
        Assert.True(next - firstInstant >= TimeSpan.FromHours(23));
    }

    [Fact]
    public void ToggleUsesTheRoutineZone()
    {
        var now = new DateTimeOffset(2026, 10, 23, 0, 0, 0, TimeSpan.Zero);
        Assert.Equal(new DateTimeOffset(2026, 10, 23, 3, 0, 0, TimeSpan.Zero), RoutineToggle.NextAfterEnable("0 8 * * *", now, "Asia/Karachi")?.ToUniversalTime());
    }
}
