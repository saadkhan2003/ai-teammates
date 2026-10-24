using System.Text.Json;
using Teammates.Api;

namespace Teammates.UnitTests;

public class CompactionTests
{
    [Fact]
    public void CompactedNoticeContainsOnlyCountsAndTaskReference()
    {
        var taskId = Guid.NewGuid();
        using var notice = JsonDocument.Parse(ResumeNotices.BuildCompactedNotice(taskId, 42, 20));
        Assert.Equal("resume", notice.RootElement.GetProperty("type").GetString());
        Assert.Equal("compacted", notice.RootElement.GetProperty("event").GetString());
        Assert.Equal(taskId, notice.RootElement.GetProperty("taskId").GetGuid());
        Assert.Equal(42, notice.RootElement.GetProperty("archived").GetInt32());
        Assert.Equal(20, notice.RootElement.GetProperty("keptSteps").GetInt32());
    }

    [Fact]
    public void ContextExhaustionIsAContinueOnlyResumeCardReason()
    {
        Assert.True(ResumeNotices.IsCardReason("context_exhausted"));
        var card = JsonDocument.Parse(ResumeNotices.BuildCard("context_exhausted", Guid.NewGuid(), 10, 200, 20, 3600, ""));
        Assert.Equal("context_exhausted", card.RootElement.GetProperty("reason").GetString());
        Assert.Equal("open", card.RootElement.GetProperty("state").GetString());
    }
}
