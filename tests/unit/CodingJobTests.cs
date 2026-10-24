using System.Text.Json;

namespace Teammates.UnitTests;

public sealed class CodingJobTests
{
    [Theory]
    [InlineData("queued", "queued")]
    [InlineData("TESTS", "tests")]
    [InlineData("merged", "merged")]
    [InlineData("nope", "running")]
    [InlineData("", "running")]
    public void StatusIsOneOfTheLiveSet(string input, string expected) =>
        Assert.Equal(expected, Teammates.Api.CodingJobs.Normalize(input));

    [Fact]
    public void ReplyToAcceptsCamelOrSnakeAndRejectsJunk()
    {
        using var camel = JsonDocument.Parse("{\"replyTo\":\"11111111-1111-4111-8111-111111111111\"}");
        Assert.True(Teammates.Api.ChatReply.TryRead(camel.RootElement, out var id, out var invalid));
        Assert.Equal(Guid.Parse("11111111-1111-4111-8111-111111111111"), id);
        Assert.False(invalid);

        using var missing = JsonDocument.Parse("{}");
        Assert.False(Teammates.Api.ChatReply.TryRead(missing.RootElement, out _, out var missingInvalid));
        Assert.False(missingInvalid);

        using var bad = JsonDocument.Parse("{\"reply_to\":\"not-a-guid\"}");
        Assert.False(Teammates.Api.ChatReply.TryRead(bad.RootElement, out _, out var badInvalid));
        Assert.True(badInvalid);
    }
}
