using Teammates.Api;
using Xunit;

namespace Teammates.UnitTests;

public class CodingItemsTests
{
    [Theory]
    [InlineData("running", null, "", "running")]
    [InlineData("waiting_approval", 5, "open", "running")]
    [InlineData("completed", 5, "open", "ready_for_review")]
    [InlineData("completed", 5, "", "ready_for_review")]
    [InlineData("completed", null, "", "finished")]
    [InlineData("completed", 5, "closed", "finished")]
    [InlineData("completed", 5, "merged", "merged")]
    [InlineData("failed", 5, "open", "failed")]
    [InlineData("cancelled", null, "", "failed")]
    public void StatusIsDerivedFromTaskAndPr(string task, int? pr, string prState, string expected) =>
        Assert.Equal(expected, CodingStatus.From(task, pr, prState));

    [Fact]
    public void ParsesPullRequestUrlFromGhOutput()
    {
        var p = CodingStatus.ParsePullUrl("Creating pull request...\nhttps://github.com/acme/widgets/pull/5\n");
        Assert.Equal(5, p!.Value.Number);
        Assert.Equal("https://github.com/acme/widgets/pull/5", p.Value.Url);
        Assert.Equal("https://github.com/acme/widgets.git", p.Value.RepoUrl);
        Assert.Null(CodingStatus.ParsePullUrl("no pr here"));
    }

    [Fact]
    public void CountsDistinctChangedFiles() =>
        Assert.Equal(["a.cs", "b/c.ts"], CodingStatus.Files("a.cs\n\nb/c.ts\na.cs\n"));

    [Fact]
    public void CheckoutCommandRejectsUnsafeBranches()
    {
        Assert.Equal("git clone -b task/ab12 https://x/y.git", CodingItems.CheckoutCommand("https://x/y.git", "task/ab12"));
        Assert.Equal("git fetch origin feat && git checkout feat", CodingItems.CheckoutCommand("", "feat"));
        Assert.Equal("", CodingItems.CheckoutCommand("https://x/y.git", "a; rm -rf /"));
    }
}
