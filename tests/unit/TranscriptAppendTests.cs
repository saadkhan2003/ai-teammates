using Teammates.Api;

namespace Teammates.UnitTests;

public class TranscriptAppendTests
{
    [Fact]
    public void MatchingPrefixAppendsFromStoredCount() =>
        Assert.Equal(TranscriptWriteDecision.Append(2), TranscriptAppend.Decide(["a", "b"], ["a", "b", "c"]));

    [Fact]
    public void IdenticalTranscriptIsNoOp() =>
        Assert.Equal(TranscriptWriteDecision.Append(2), TranscriptAppend.Decide(["a", "b"], ["a", "b"]));

    [Fact]
    public void ShorterTranscriptRequiresRewrite() =>
        Assert.Equal(TranscriptWriteDecision.Rewrite, TranscriptAppend.Decide(["a", "b"], ["a"]));

    [Fact]
    public void ChangedPrefixRequiresRewrite() =>
        Assert.Equal(TranscriptWriteDecision.Rewrite, TranscriptAppend.Decide(["a", "b"], ["a", "changed", "c"]));
}
