using System.Text.Json;
using Teammates.Api;

namespace Teammates.UnitTests;

public class TemplatesTests
{
    [Fact]
    public void TemplateExportShapeContainsOnlyAllowlistedFields()
    {
        var (clean, error) = Templates.Clean(new BotTemplate(1, "Atlas", "Assistant", "Keep things tidy", "blob3", "#ff3045", [new("0 8 * * *", "Briefing", "Summarize updates")], ["calendar"]));
        Assert.Null(error);
        var json = JsonSerializer.Serialize(clean);
        Assert.DoesNotContain("owner", json);
        Assert.DoesNotContain("memory", json);
        Assert.DoesNotContain("secret", json);
        Assert.DoesNotContain("conversation", json);
        Assert.DoesNotContain("token", json);
    }

    [Theory]
    [InlineData("sk-12345678901234567890")]
    [InlineData("secret://vault/password")]
    public void InstructionsWithSecretsAreRejected(string value)
    {
        var result = Templates.Clean(new BotTemplate(1, "A", "", value, "", "", [], []));
        Assert.Null(result.Template);
        Assert.NotNull(result.Error);
    }

    [Fact]
    public void ImportRejectsUnknownFieldsBadCronAndLargeInput()
    {
        Assert.NotNull(Templates.Parse(JsonDocument.Parse("""{"schemaVersion":1,"name":"A","role":"","instructions":"","avatarShape":"","avatarColor":"","routines":[],"pluginIds":[],"ownerId":"x"}""").RootElement).Error);
        Assert.NotNull(Templates.Clean(new BotTemplate(1, "A", "", "", "", "", [new("not cron", "x", "y")], [])).Error);
        Assert.Equal(8192, Templates.MaxJsonBytes);
    }
}
