using System.Text.Json;
using Teammates.Api;

namespace Teammates.UnitTests;

public sealed class VideoToolsTests
{
    [Theory]
    [InlineData("watch_video")]
    [InlineData("ask_video")]
    public void VideoToolsHonorReadPolicyIncludingHardDenials(string tool)
    {
        var args = JsonSerializer.SerializeToElement(new { source = "/workspace/demo.mp4", question = "What happens?" });
        Assert.True(ActionClassifier.IsBuiltIn(tool));
        Assert.Equal(ActionClasses.Read, ActionClassifier.Classify(tool, args));
        foreach (var mode in new[] { PolicyEngine.Allow, PolicyEngine.Ask, PolicyEngine.Deny })
        {
            var policy = new UserPolicy();
            policy.Classes[ActionClasses.Read] = mode;
            Assert.Equal(mode, PolicyGate.Evaluate(tool, args, new HashSet<string>(), policy, [], null, false).Decision);
        }
        var denied = PolicyGate.Evaluate(tool, args, new HashSet<string>(), UserPolicy.Default,
            [new DenyRule("blocked_video", "demo.mp4", false)], null, true);
        Assert.Equal(PolicyEngine.Deny, denied.Decision);
        Assert.True(denied.HardDeny);
    }

    [Theory]
    [InlineData("/workspace/demo.mp4", true)]
    [InlineData("uploads/demo.mp4", true)]
    [InlineData("https://example.com/demo.mp4", false)]
    [InlineData("../other/demo.mp4", false)]
    [InlineData("/workspace/../other/demo.mp4", false)]
    [InlineData("/workspace/.env", false)]
    [InlineData("/workspace/secrets/demo.mp4", false)]
    [InlineData("/workspace/.git/demo.mp4", false)]
    [InlineData("", false)]
    public void VideoSchemaRejectsUnsafeSources(string source, bool allowed)
    {
        Assert.Equal(allowed, VideoTools.SafeSource(source));
        var args = JsonSerializer.SerializeToElement(new { source });
        Assert.Equal(allowed, ToolSchema.Validate("watch_video", args) == null);
    }

    [Theory]
    [InlineData("attachment_id", "00000000-0000-0000-0000-000000000001")]
    [InlineData("path", "/workspace/demo.mp4")]
    public void WatchVideoAcceptsAttachmentOrWorkspacePath(string field, string value)
    {
        using var args = JsonDocument.Parse(JsonSerializer.Serialize(new Dictionary<string, object> { [field] = value }));
        Assert.Null(ToolSchema.Validate("watch_video", args.RootElement));
    }

    [Fact]
    public void VideoAndSkillToolsCoexistAndCardOmitsRawMedia()
    {
        var names = ToolSchema.Builtins().Select(tool => JsonSerializer.SerializeToElement(tool).GetProperty("function").GetProperty("name").GetString()).ToArray();
        Assert.Equal(names.Length, names.Distinct().Count());
        foreach (var tool in new[] { "watch_video", "ask_video", "load_skill", "write_skill", "save_memory", "update_memory" }) Assert.Contains(tool, names);
        var card = VideoTools.Card(JsonSerializer.SerializeToElement(new { summary = "Safe", timeline = new object[0], frames = new[] { "raw image" }, transcript = "raw audio" }));
        Assert.Equal(new[] { "summary", "timeline" }, card.Keys);
    }

    [Fact]
    public void VideoAnalysisRedactionPreservesValidJsonAndEscapedText()
    {
        using var analysis = JsonDocument.Parse("""
            {"summary":"contains sk-or-v1-CanarySecret123456 and \"quoted\" text \\\\ path","timeline":[{"text":"safe \"quoted\" value"}],"duration":12.5}
            """);

        var redacted = VideoTools.RedactJsonStrings(analysis.RootElement);
        using var roundTrip = JsonDocument.Parse(redacted);

        Assert.Equal(12.5, roundTrip.RootElement.GetProperty("duration").GetDouble());
        var summary = roundTrip.RootElement.GetProperty("summary").GetString()!;
        Assert.DoesNotContain("CanarySecret123456", summary);
        Assert.Contains("[REDACTED]", summary);
        Assert.Contains("\"quoted\" text \\\\ path", summary);
        Assert.Equal("safe \"quoted\" value", roundTrip.RootElement.GetProperty("timeline")[0].GetProperty("text").GetString());
    }

    [Fact]
    public void VideoCacheIdentityChangesWithEffectiveModelsAndSettings()
    {
        var original = VideoTools.SettingsVersion(Teammates.Api.Platform.DefaultRealModel, "whisper", "provider-a", "chunk=300");
        Assert.Equal(original, VideoTools.SettingsVersion(Teammates.Api.Platform.DefaultRealModel, "whisper", "provider-a", "chunk=300"));
        Assert.NotEqual(original, VideoTools.SettingsVersion("mock/planner", "whisper", "provider-a", "chunk=300"));
        Assert.NotEqual(original, VideoTools.SettingsVersion(Teammates.Api.Platform.DefaultRealModel, "whisper-v2", "provider-a", "chunk=300"));
        Assert.NotEqual(original, VideoTools.SettingsVersion(Teammates.Api.Platform.DefaultRealModel, "whisper", "provider-b", "chunk=300"));
        Assert.NotEqual(original, VideoTools.SettingsVersion(Teammates.Api.Platform.DefaultRealModel, "whisper", "provider-a", "chunk=600"));
    }

    [Fact]
    public void VideoCreditEntriesUseTheUserFacingLabelWithoutProviderDetails()
    {
        Assert.Equal("video", VideoTools.UsageRole);
        Assert.Equal("video", VideoTools.UsageProvider);
        Assert.Equal("Video watching", VideoTools.UsageLabel);
    }

    [Theory]
    [InlineData(null, null, "mock/planner")]
    [InlineData("mock", null, "mock/planner")]
    [InlineData("MOCK", "", "mock/planner")]
    [InlineData("openrouter", null, "anthropic/claude-haiku-5.5")]
    [InlineData("openrouter", "", "anthropic/claude-haiku-5.5")]
    [InlineData("openrouter", "custom/model", "custom/model")]
    [InlineData("openrouter", "mock/planner", "mock/planner")]
    public void RealDefaultIsHaikuWhileMockAndExplicitOverridesStayIntact(string? provider, string? configured, string expected) =>
        Assert.Equal(expected, Teammates.Api.Platform.PlannerModel(provider, configured));
}
