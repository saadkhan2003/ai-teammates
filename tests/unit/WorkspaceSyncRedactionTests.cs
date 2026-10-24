using Teammates.Compute;

namespace Teammates.UnitTests;

public class WorkspaceSyncRedactionTests
{
    // A Luhn-valid 19-digit mtime_ns: the old manifest form was rewritten by the card redactor.
    private const long Mtime = 1761330000123456789;

    [Fact]
    public void SplitMtimeSurvivesTheExecOutputRedactor()
    {
        var old = $"{{\"token\":\"\",\"files\":[[\"a.md\",1,{Mtime}]],\"truncated\":false}}";
        Assert.Contains("[REDACTED]", OutputRedactor.Redact(old));
        var split = $"{{\"token\":\"\",\"files\":[[\"a.md\",1,{Mtime / 1_000_000_000},{Mtime % 1_000_000_000}]],\"truncated\":false}}";
        Assert.Equal(split, OutputRedactor.Redact(split));
        using var doc = System.Text.Json.JsonDocument.Parse(OutputRedactor.Redact(split));
        var row = doc.RootElement.GetProperty("files")[0];
        Assert.Equal(Mtime, row[2].GetInt64() * 1_000_000_000L + row[3].GetInt64());
    }
}
