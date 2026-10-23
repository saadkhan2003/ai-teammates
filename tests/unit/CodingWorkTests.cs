using Teammates.Api;

namespace Teammates.UnitTests;

public class CodingWorkTests
{
    [Fact]
    public void ChildTaskPathsAreDeterministicAndLimited()
    {
        Assert.Equal("repo/.worktrees/12345678", ChildTaskPolicy.Worktree("repo", "1234567890abcdef"));
        Assert.Equal("task/12345678", ChildTaskPolicy.Branch("1234567890abcdef"));
        Assert.Equal(3, ChildTaskPolicy.MaxActiveChildren);
        Assert.Equal(1, ChildTaskPolicy.MaxDepth);
    }

    [Fact]
    public void DurationEstimateRequiresThreeSamples()
    {
        Assert.Null(DurationEstimate.Range([10, 20]));
        var range = DurationEstimate.Range([10, 20, 30, 40, 50]);
        Assert.NotNull(range);
        Assert.Equal(5, range!.Value.Count);
        Assert.True(range.Value.LowSeconds <= range.Value.HighSeconds);
    }
}
