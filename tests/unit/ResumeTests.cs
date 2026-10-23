using System.Text.Json;
using Teammates.Api;

namespace Teammates.UnitTests;

public class ResumeTests
{
    [Fact]
    public void ResumeBriefMarksPlanAndLimitsInstructionWithoutExposingSecrets()
    {
        var instruction = new string('a', 1100) + " 4111 1111 1111 1111";
        var brief = ResumeBrief.Build(3, "lease_expired", 12, 200, instruction,
            [(1, "Finished", "done"), (2, "Continue safely", "in_progress"), (3, "Later", "pending")], "abc123");

        Assert.Contains("[x] 1 Finished", brief);
        Assert.Contains("[ ] 2 Continue safely ← current", brief);
        Assert.Contains("[ ] 3 Later", brief);
        Assert.Contains("attempt 3", brief);
        Assert.DoesNotContain("4111 1111 1111 1111", brief);
        Assert.DoesNotContain(new string('a', 1001), brief);
    }

    [Fact]
    public void ResumeNoticeCollapseIncrementsOnlyWithinFifteenMinutes()
    {
        var now = DateTimeOffset.UtcNow;
        var content = ResumeNotices.BuildNotice(2, 2, "lease_expired", 8, "Build tests", now.AddMinutes(-10), now.AddMinutes(-4));
        var collapsed = ResumeNotices.Collapse(content, 3, "network_interrupted", 10, "Build tests", now);
        Assert.True(collapsed.Collapse);
        using var result = JsonDocument.Parse(collapsed.Content!);
        Assert.Equal(3, result.RootElement.GetProperty("count").GetInt32());
        Assert.Equal(3, result.RootElement.GetProperty("attempt").GetInt32());
        Assert.Equal(10, result.RootElement.GetProperty("stepsUsed").GetInt32());
        Assert.Equal(now.ToString("O"), result.RootElement.GetProperty("lastAt").GetString());

        var outside = ResumeNotices.Collapse(content, 3, "lease_expired", 10, "Build tests", now.AddMinutes(12));
        Assert.False(outside.Collapse);
        Assert.Null(outside.Content);
    }

    [Fact]
    public void ResumeCardBuilderDedupesByOpenStateAndSupportsStateChanges()
    {
        var id = Guid.NewGuid();
        var card = ResumeNotices.BuildCard("budget_reached", id, 200, 200, 3600, 3600, "Write tests");
        Assert.False(ResumeNotices.ShouldInsertCard(true));
        Assert.True(ResumeNotices.ShouldInsertCard(false));
        using var changed = JsonDocument.Parse(ResumeNotices.ChangeCardState(card, "continued"));
        Assert.Equal("continued", changed.RootElement.GetProperty("state").GetString());
        Assert.Equal("budget_reached", changed.RootElement.GetProperty("reason").GetString());
    }

    [Fact]
    public void AttemptSummaryReportsMedianMaximumAndHourlyCuts()
    {
        var summary = AttemptLog.Summarize([new AttemptLogRow(100), new AttemptLogRow(3600), new AttemptLogRow(3800), new AttemptLogRow(5000)]);
        Assert.Equal(4, summary.Count);
        Assert.Equal(3700, summary.MedianWallSeconds);
        Assert.Equal(5000, summary.MaxWallSeconds);
        Assert.Equal(2, summary.HourlyCutCount);
        Assert.Equal(new AttemptSummary(0, 0, 0, 0), AttemptLog.Summarize(Array.Empty<int>()));
    }

    [Theory]
    [InlineData(false, 0, 0, "queued", true)]
    [InlineData(true, 9, 9, "running", true)]
    [InlineData(true, 8, 9, "running", false)]
    [InlineData(true, 9, 9, "queued", false)]
    public void EpochFenceRejectsStaleOrInactiveLeases(bool hasEpoch, int supplied, int current, string status, bool expected) =>
        Assert.Equal(expected, EpochFence.Accepts(hasEpoch, supplied, current, status));
}
