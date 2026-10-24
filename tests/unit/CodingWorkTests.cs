using Teammates.Api;

namespace Teammates.UnitTests;

public class CodingWorkTests
{
    [Theory]
    [InlineData("work", 200, 201, 201)]
    [InlineData("work", 6, 7, 7)]
    [InlineData("work", 1000, 400, 1001)]
    [InlineData("chat", 200, 12, 12)]
    [InlineData("coding", 200, 12, 60)]
    public void ModelRoundsRespectWorkBudgetAndKeepChatAndCodingLimits(string kind, int steps, int perAttempt, int cumulative)
    {
        var budget = RunBudget.Resolve(steps, null, null, null);
        var rounds = RunBudget.ResolveModelRounds(kind, budget, 12, 12, 60);
        Assert.Equal(perAttempt, rounds.PerAttempt);
        Assert.Equal(cumulative, rounds.Cumulative);
    }

    [Fact]
    public void ContinuingWorkAlsoRaisesItsCumulativeModelBudget()
    {
        var before = RunBudget.ResolveModelRounds("work", RunBudget.Resolve(6, null, null, null), 12, 12, 60);
        var after = RunBudget.ResolveModelRounds("work", RunBudget.Resolve(206, null, null, null), 12, 12, 60);
        Assert.Equal(before.Cumulative + 200, after.Cumulative);
    }

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
