using System.Text.Json;
using Teammates.Api;

namespace Teammates.UnitTests;

public class ApprovalRulesTests
{
    private static JsonElement Args(string json) => JsonDocument.Parse(json).RootElement.Clone();

    [Theory]
    [InlineData(ActionClasses.Payment, "send_payment")]
    [InlineData(ActionClasses.Sign, "sign")]
    [InlineData(ActionClasses.Delete, "delete_file")]
    [InlineData(ActionClasses.CredentialUse, "type_secret")]
    [InlineData(ActionClasses.BotManage, "create_bot")]
    [InlineData(ActionClasses.ExternalPost, "external_post")]
    public void NeverListedClassesCannotCreatePersistentRules(string actionClass, string tool) =>
        Assert.Null(ApprovalRules.Build(actionClass, tool, Args("{}")));

    [Fact]
    public void BrowserRuleIsHostScoped()
    {
        var built = ApprovalRules.Build(ActionClasses.Read, "browser_open", Args("{\"url\":\"https://portal.example.edu/login\"}"));
        Assert.NotNull(built);
        Assert.True(ApprovalRules.Matches(ActionClasses.Read, "browser_open", built!.Value.Matcher, Args("{\"url\":\"https://portal.example.edu/other\"}")));
        Assert.False(ApprovalRules.Matches(ActionClasses.Read, "browser_open", built.Value.Matcher, Args("{\"url\":\"https://evil.example.edu/\"}")));
    }

    [Fact]
    public void ShellRuleMatchesOnlyExactNormalizedCommand()
    {
        var built = ApprovalRules.Build(ActionClasses.Write, "shell", Args("{\"command\":\"git   status\"}"));
        Assert.NotNull(built);
        Assert.True(ApprovalRules.Matches(ActionClasses.Write, "shell", built!.Value.Matcher, Args("{\"command\":\"git status\"}")));
        Assert.False(ApprovalRules.Matches(ActionClasses.Write, "shell", built.Value.Matcher, Args("{\"command\":\"git status --short\"}")));
        Assert.Null(ApprovalRules.Build(ActionClasses.Write, "shell", Args("{\"command\":\"cat /workspace/secrets/key.txt\"}")));
    }

    [Fact]
    public void MessageRuleMatchesSameToolAndRecipient()
    {
        var built = ApprovalRules.Build(ActionClasses.SendMessage, "send_message", Args("{\"to\":\"Alex\",\"text\":\"hi\"}"));
        Assert.NotNull(built);
        Assert.True(ApprovalRules.Matches(ActionClasses.SendMessage, "send_message", built!.Value.Matcher, Args("{\"to\":\"alex\",\"text\":\"different content\"}")));
        Assert.False(ApprovalRules.Matches(ActionClasses.SendMessage, "send_message", built.Value.Matcher, Args("{\"to\":\"Morgan\"}")));
    }

    [Fact]
    public void EditedPrefixMustStayWithinOriginalPrefix()
    {
        const string original = "{\"kind\":\"prefix\",\"prefix\":\"/workspace/project/src\"}";
        Assert.True(ApprovalRules.IsNarrowerOrEqual(ActionClasses.Write, "write_file", original, "{\"kind\":\"prefix\",\"prefix\":\"/workspace/project/src/lib\"}"));
        Assert.False(ApprovalRules.IsNarrowerOrEqual(ActionClasses.Write, "write_file", original, "{\"kind\":\"prefix\",\"prefix\":\"/workspace/project\"}"));
    }

    [Fact]
    public void EditedHostMayNarrowToSubdomainButCannotWiden()
    {
        const string original = "{\"kind\":\"host\",\"host\":\"example.edu\"}";
        Assert.True(ApprovalRules.IsNarrowerOrEqual(ActionClasses.Read, "browser_open", original, "{\"kind\":\"host\",\"host\":\"portal.example.edu\"}"));
        Assert.False(ApprovalRules.IsNarrowerOrEqual(ActionClasses.Read, "browser_open", original, "{\"kind\":\"host\",\"host\":\"other.edu\"}"));
        Assert.False(ApprovalRules.IsNarrowerOrEqual(ActionClasses.Read, "browser_open", original, "{\"kind\":\"host\",\"host\":\"*.example.edu\"}"));
    }

    [Fact]
    public void HardDenyAndDlpRemainDenialsBeforeApprovalRulesCouldMatch()
    {
        var hard = PolicyGate.Evaluate("shell", Args("{\"command\":\"please export the vault\"}"), new HashSet<string>(), UserPolicy.Default, [], null, false);
        Assert.Equal(PolicyEngine.Deny, hard.Decision);
        Assert.True(hard.HardDeny);
        var dlp = PolicyGate.Evaluate("send_message", Args("{\"to\":\"Alex\",\"text\":\"card 4111111111111111\"}"), new HashSet<string>(), UserPolicy.Default, [], null, false);
        Assert.Equal(PolicyEngine.Deny, dlp.Decision);
    }
}
