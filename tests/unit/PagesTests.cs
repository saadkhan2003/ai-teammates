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
    public void MigrationIsRegistered() => Assert.Contains("053_pages.sql", Teammates.Api.Platform.MigrationFiles);
}
