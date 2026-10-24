using Teammates.Api;

namespace Teammates.UnitTests;

public sealed class JobLogBufferTests
{
    [Fact]
    public void Splits_lines_and_holds_a_partial_line_until_its_newline()
    {
        var buffer = new JobLogBuffer();
        Assert.Equal(["one", "two"], buffer.Append("one\ntwo\nthr"));
        Assert.Equal(["three"], buffer.Append("ee\n"));
        Assert.Equal(3, buffer.Total);
    }

    [Fact]
    public void Keeps_only_the_newest_two_thousand_lines()
    {
        var buffer = new JobLogBuffer();
        buffer.Append(string.Join("\n", Enumerable.Range(1, 2500)) + "\n");
        var lines = buffer.Snapshot();
        Assert.Equal(JobLogBuffer.MaxLines, lines.Count);
        Assert.Equal("501", lines[0]);
        Assert.Equal("2500", lines[^1]);
        Assert.Equal(2500, buffer.Total);
    }

    [Fact]
    public void Redacts_secrets_and_whole_private_key_blocks()
    {
        var buffer = new JobLogBuffer();
        var lines = buffer.Append("token sk-or-abcdefghijklmnop1234\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAAAA\n-----END RSA PRIVATE KEY-----\nafter\n");
        Assert.DoesNotContain(lines, line => line.Contains("sk-or-abcdefghijklmnop1234") || line.Contains("MIIEow"));
        Assert.Equal("[redacted private key]", lines[1]);
        Assert.Equal("after", lines[^1]);
    }

    [Fact]
    public void Flush_emits_the_last_line_without_a_newline()
    {
        var buffer = new JobLogBuffer();
        Assert.Empty(buffer.Append("done"));
        Assert.Equal(["done"], buffer.Append("", flush: true));
    }
}
