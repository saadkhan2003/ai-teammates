using System.Text.Json;
using Teammates.Api;

namespace Teammates.UnitTests;

public sealed class ApprovalSignalsTests
{
    [Theory]
    [InlineData("👍", "positive")][InlineData("❤️", "positive")][InlineData("🎉", "positive")][InlineData("🔥", "positive")]
    [InlineData("👏", "positive")][InlineData("✅", "positive")][InlineData("💯", "positive")][InlineData("😍", "positive")]
    [InlineData("👎", "negative")][InlineData("😕", "negative")][InlineData("😡", "negative")][InlineData("🤔", null)]
    public void ReactionClassification(string emoji,string? expected) => Assert.Equal(expected,ApprovalSignals.ReactionKind(emoji));
    [Theory]
    [InlineData("yes", "positive", "reply")][InlineData("perfect!", "positive", "reply")]
    [InlineData("looks amazing", "positive", "reply")][InlineData("love it", "positive", "reply")][InlineData("exactly", "positive", "reply")]
    [InlineData("no, shorter please", "correction", "reply")][InlineData("that's wrong", "correction", "reply")]
    [InlineData("not like that", "correction", "reply")][InlineData("instead use a table", "correction", "reply")]
    [InlineData("regenerate", "correction", "redo")][InlineData("redo that", "correction", "redo")]
    public void PhrasesClassify(string text,string kind,string signal) => Assert.Equal((kind,signal),ApprovalSignals.Classify(text)!.Value);
    [Theory]
    [InlineData("yesterday")][InlineData("The page says perfect")][InlineData("<tool>yes</tool>")][InlineData("Read the email")]
    public void UnrelatedTextIsNotFeedback(string text) => Assert.Null(ApprovalSignals.Classify(text));
    [Theory]
    [InlineData("bot")][InlineData("tool")][InlineData("web")][InlineData("email")][InlineData("file")][InlineData("peer")]
    public void UntrustedSourcesCannotAuthorizeCapture(string origin)
    {
        var owner=Guid.NewGuid();Assert.False(ApprovalSignals.Trusted(owner,owner,origin));
        Assert.False(ApprovalSignals.Trusted(Guid.NewGuid(),owner,"owner"));Assert.True(ApprovalSignals.Trusted(owner,owner,"owner"));
    }
    [Fact]
    public void HeuristicsAreBoundedAndCorrectionsHaveStableTopics()
    {
        var signal=new ApprovalSignal { Kind="correction",Signal="reply",Detail=JsonSerializer.Serialize(new { text="no, shorter please",excerpt=new string('x',400) }) };
        var note=ApprovalSignals.Heuristic(signal);Assert.Equal("avoid",note.Kind);Assert.Equal("response_length",note.Topic);Assert.Contains("shorter",note.Text);
        signal.Kind="positive";signal.Signal="reaction";var positive=ApprovalSignals.Heuristic(signal);Assert.Equal("quality_bar",positive.Kind);Assert.True(positive.Text.Length<=400);
    }
    [Fact]
    public void ExcerptsRedactSecretsAndStripInjectionBeforeTruncation()
    {
        var token="sk-or-"+new string('x',30);var text=ApprovalSignals.Clip("Result "+token+" "+new string('a',200));
        Assert.DoesNotContain(token,text);Assert.Contains("[REDACTED]",text);Assert.True(text.Length<=160);
    }
}
