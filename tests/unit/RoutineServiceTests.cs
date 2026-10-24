using Teammates.Api;
using Xunit;

namespace Teammates.UnitTests;

public class RoutineServiceTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 24, 9, 0, 0, TimeSpan.Zero);

    [Theory]
    [InlineData("0 8 * * *", null)]
    [InlineData("*/5 * * * *", null)]
    [InlineData("*/4 * * * *", "interval_too_short")]
    [InlineData("* * * * *", "interval_too_short")]
    [InlineData("nonsense", "invalid_cron")]
    [InlineData("", "schedule_required")]
    [InlineData(null, "schedule_required")]
    public void RecurringScheduleIsValidatedWithAFiveMinuteFloor(string? cron, string? expected)
    {
        Assert.Equal(expected, RoutineService.CheckSchedule(cron, null, Now, out var kind));
        Assert.Equal("recurring", kind);
    }

    [Fact]
    public void OneOffRunTimeMustBeInTheFutureAndWithinAYear()
    {
        Assert.Null(RoutineService.CheckSchedule(null, Now.AddMinutes(45), Now, out var kind));
        Assert.Equal("once", kind);
        Assert.Equal("run_at_in_past", RoutineService.CheckSchedule(null, Now.AddMinutes(-1), Now, out _));
        Assert.Equal("run_at_too_far", RoutineService.CheckSchedule(null, Now.AddYears(1).AddDays(1), Now, out _));
    }

    [Fact]
    public void EveryErrorCodeHasAnApprovedSentence()
    {
        foreach (var code in new[] { "invalid_cron", "interval_too_short", "run_at_in_past", "routine_limit", "get_routine_required", "unknown_timezone" })
            Assert.DoesNotContain("refused", RoutineService.Sentence(code));
        Assert.Contains("refused", RoutineService.Sentence("something_else"));
    }

    [Fact]
    public void SharedLimitsMatchTheBotTools()
    {
        Assert.Equal(5, PeerLimits.MinRoutineMinutes);
        Assert.Equal(10, PeerLimits.MaxRoutinesPerBot);
    }

    [Theory]
    [InlineData("0 * * * *", "Every hour")]
    [InlineData("47 7 * * *", "Every day at 7:47 AM")]
    [InlineData("30 9 * * 1-5", "Every weekday at 9:30 AM")]
    [InlineData("0 20 * * 0", "Every Sunday at 8:00 PM")]
    [InlineData("0 9 1 * *", "Monthly on the 1st at 9:00 AM")]
    [InlineData("*/15 * * * *", "Every 15 minutes")]
    [InlineData("0 9 1 6 *", "Custom schedule")]
    public void CronWordsMatchTheWebList(string cron, string words) => Assert.Equal(words, CronWords.Describe(cron));

    [Fact]
    public void RoutineWordsCarryTheZoneAndReadOneOffsAsADate()
    {
        Assert.Equal("Every day at 8:00 AM (Asia/Karachi)", CronWords.ForRoutine("recurring", "0 8 * * *", null, "Asia/Karachi"));
        var words = CronWords.ForRoutine("once", RoutineService.OnceCron, new DateTimeOffset(2026, 10, 24, 4, 0, 0, TimeSpan.Zero), "Asia/Karachi");
        Assert.Equal("Once on Sat 24 Oct at 9:00 AM (Asia/Karachi)", words);
    }
}

public class RoutineScheduleTests
{
    private static readonly Guid Id = Guid.Parse("7c1f0c52-3a53-4e0f-9f3b-0f5a1b8e2d11");

    [Fact]
    public void JitterIsStableAndCapped()
    {
        var first = RoutineSchedule.JitterSeconds(Id, "0 8 * * *");
        Assert.Equal(first, RoutineSchedule.JitterSeconds(Id, "0 8 * * *"));
        Assert.InRange(first, 0, 15 * 60);
        Assert.InRange(RoutineSchedule.JitterSeconds(Id, "0 * * * *"), 0, 15 * 60);
        Assert.InRange(RoutineSchedule.JitterSeconds(Id, "*/20 * * * *"), 0, 10 * 60);
    }

    [Fact]
    public void ShortGapsGetNoJitter()
    {
        Assert.Equal(0, RoutineSchedule.JitterSeconds(Id, "*/5 * * * *"));
        Assert.Equal(0, RoutineSchedule.JitterSeconds(Id, "garbage"));
    }

    [Fact]
    public void DifferentRoutinesSpreadAcrossTheWindow()
    {
        var seen = Enumerable.Range(0, 40).Select(_ => RoutineSchedule.JitterSeconds(Guid.NewGuid(), "0 8 * * *")).Distinct().Count();
        Assert.True(seen > 20);
    }

    [Theory]
    [InlineData("recurring", 5, false)]
    [InlineData("recurring", 7, true)]
    [InlineData("once", 7, false)]
    [InlineData("once", 25, true)]
    public void MissedRunWindowIsSixHoursForRecurringAndADayForOnce(string kind, int hoursLate, bool tooLate)
    {
        var now = new DateTimeOffset(2026, 10, 24, 12, 0, 0, TimeSpan.Zero);
        Assert.Equal(tooLate, RoutineSchedule.TooLate(kind, now.AddHours(-hoursLate), now));
    }

    [Theory]
    [InlineData("Only when changed", "NOTHING_NEW", true)]
    [InlineData("Only when changed", "  NOTHING_NEW.\n", true)]
    [InlineData("Only when changed", "`NOTHING_NEW`", true)]
    [InlineData("Only when changed", "NOTHING_NEW but I found two things", false)]
    [InlineData(null, "NOTHING_NEW", false)]
    [InlineData("Only when changed", "", false)]
    public void QuietSentinelOnlyCountsWhenARuleIsSetAndItIsTheWholeAnswer(string? rule, string text, bool quiet) =>
        Assert.Equal(quiet, RoutineSchedule.IsQuiet(rule, text));

    [Fact]
    public void FramingSaysItIsNotAUserMessageAndCarriesTheQuietRule()
    {
        var text = RoutineSchedule.Framing("Brief", "Summarise the news.", "No news, no message", "Sat 24 Oct 08:00 Asia/Karachi");
        Assert.StartsWith("This is a scheduled run, not a user message.", text);
        Assert.Contains("Quiet rule: No news, no message", text);
        Assert.Contains("reply with exactly NOTHING_NEW", text);
        Assert.EndsWith("Summarise the news.", text);
        Assert.Contains("Quiet rule: none", RoutineSchedule.Framing("Brief", "x", null, "now"));
    }

    [Fact]
    public void ExcerptCollapsesWhitespaceAndTruncates()
    {
        Assert.Equal("a b", RoutineSchedule.Excerpt("a\n  b"));
        Assert.EndsWith("...", RoutineSchedule.Excerpt(new string('x', 400)));
    }
}
