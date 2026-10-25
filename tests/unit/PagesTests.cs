using Teammates.Api;

namespace Teammates.UnitTests;

public class PagesTests
{
    [Fact]
    public void SourceCapUsesUtf8AndMetadataIsBounded()
    {
        Assert.True(PagesStore.Valid("Report", "report", new string('x', PagesStore.MaxSourceBytes)));
        Assert.False(PagesStore.Valid("Report", "report", new string('x', PagesStore.MaxSourceBytes - 1) + "💡"));
        Assert.False(PagesStore.Valid("", "report", "body"));
        Assert.False(PagesStore.Valid(new string('x', 161), "report", "body"));
        Assert.False(PagesStore.Valid("Report", "script", "body"));
        Assert.False(PagesStore.Valid("Report", "report", "body", new string('x', 501)));
        Assert.False(PagesStore.Valid("Report", "report", "api_key=sk_live_12345678901234567890"));
    }
    [Fact]
    public void ShareTokensAreUnpredictableAndOnlyHashIsStored()
    {
        var first = PagesStore.NewToken(); var second = PagesStore.NewToken();
        Assert.Equal(64, first.Length); Assert.NotEqual(first, second);
        Assert.Equal(64, PagesStore.HashToken(first).Length);
        Assert.NotEqual(first, PagesStore.HashToken(first));
        Assert.Equal(PagesStore.HashToken(first), PagesStore.HashToken(first));
    }
    [Fact]
    public void DiffCountsAddedRemovedAndDuplicateLines()
    {
        Assert.Equal((1, 1), PagesStore.Diff("A\nB", "A\nC"));
        Assert.Equal((0, 1), PagesStore.Diff("A\nA", "A"));
        Assert.Equal((2, 0), PagesStore.Diff("", "A\nB"));
        Assert.Equal((0, 0), PagesStore.Diff("A\r\nB", "A\nB"));
    }
    [Fact]
    public void MigrationIsRegistered() => Assert.Contains("053_pages.sql", Teammates.Api.Platform.MigrationFiles);
}

public class PagesToolPolicyTests
{
    [Theory]
    [InlineData("write_page")]
    [InlineData("edit_page")]
    public void PageToolsHonorApprovalPolicyAndDeduplicate(string tool)
    {
        var args = System.Text.Json.JsonSerializer.SerializeToElement(new { title = "Page", kind = "report", source = "# Safe", summary = "Updated" });
        Assert.True(ActionClassifier.IsBuiltIn(tool));
        Assert.Equal(ActionClasses.Write, ActionClassifier.Classify(tool, args));
        Assert.True(ToolDedupe.Applies(tool, "page-call"));
        Assert.False(ComputerNeed.Needs(tool));
        foreach (var mode in new[] { PolicyEngine.Allow, PolicyEngine.Ask, PolicyEngine.Deny })
        {
            var policy = new UserPolicy(); policy.Classes[ActionClasses.Write] = mode;
            Assert.Equal(mode, PolicyGate.Evaluate(tool, args, new HashSet<string>(), policy, [], null, false).Decision);
        }
        Assert.Null(ToolSchema.Validate(tool, args));
    }
    [Fact]
    public void PageRateLimitsArePerKeyAndFailAtTheLimit()
    {
        var key = Guid.NewGuid();
        Assert.True(PagesRateLimit.Allow(key, 2)); Assert.True(PagesRateLimit.Allow(key, 2)); Assert.False(PagesRateLimit.Allow(key, 2));
        Assert.True(PagesRateLimit.Allow(Guid.NewGuid(), 2));
    }

    [Fact]
    public void TeammatePageToolsDoNotShareTheOwnersReadBucket()
    {
        var owner = Guid.NewGuid();
        Assert.NotEqual(owner, PagesRateLimit.ToolKey(owner));
        Assert.Equal(PagesRateLimit.ToolKey(owner), PagesRateLimit.ToolKey(owner));
        for (var i = 0; i < 3; i++) PagesRateLimit.Allow(owner, 3);
        Assert.False(PagesRateLimit.Allow(owner, 3));
        Assert.True(PagesRateLimit.Allow(PagesRateLimit.ToolKey(owner), 3));
    }
}
