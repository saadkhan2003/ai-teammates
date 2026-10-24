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

    [Theory]
    [InlineData("echo hi; id")]
    [InlineData("echo $(id)")]
    [InlineData("echo hi | cat")]
    [InlineData("echo hi\\nwhoami")]
    public void EditableShellMatchersKeepC4SyntaxRestrictions(string command)
    {
        var args = JsonSerializer.SerializeToElement(new { command = command.Replace("\\n", "\n") });
        Assert.Null(ApprovalRules.Build(ActionClasses.Write, "shell", args));
        var unsafeMatcher = JsonSerializer.Serialize(new { kind = "command", sha256 = new string('0', 64) });
        Assert.False(ApprovalRules.Matches(ActionClasses.Write, "shell", unsafeMatcher, args));
    }

    [Fact]
    public void EditableShellMatchersSupportArgvAndRejectVaultOrDlp()
    {
        var args = Args("""{"argv":["git","status"]}""");
        var rule = ApprovalRules.Build(ActionClasses.Write, "shell", args);
        Assert.NotNull(rule);
        Assert.True(ApprovalRules.Matches(ActionClasses.Write, "shell", rule!.Value.Matcher, args));
        Assert.False(ApprovalRules.Matches(ActionClasses.Write, "shell", rule.Value.Matcher, Args("""{"argv":["git","diff"]}""")));
        Assert.Null(ApprovalRules.Build(ActionClasses.Write, "shell", Args("""{"argv":["cat","/workspace/vault/key"]}""")));
        Assert.Null(ApprovalRules.Build(ActionClasses.SendMessage, "send_message", Args("""{"to":"Alex","text":"4111111111111111"}""")));
    }

    [Fact]
    public void PersistentRulesCannotOverrideDenialsPersonalAskOrPeerProvenance()
    {
        var policy = new UserPolicy();
        policy.Classes[ActionClasses.Write] = PolicyEngine.Allow;
        var ask = new PolicyDecision(PolicyEngine.Ask, ActionClasses.Write, "write", "review_required", false);
        Assert.True(ApprovalRules.CanApply(ask, "shell", policy, false));
        Assert.False(ApprovalRules.CanApply(ask, "shell", policy, true));
        var personalAsk = new UserPolicy();
        personalAsk.Classes[ActionClasses.Write] = PolicyEngine.Ask;
        Assert.False(ApprovalRules.CanApply(ask, "shell", personalAsk, false));
        Assert.False(ApprovalRules.CanApply(ask with { HardDeny = true }, "shell", policy, false));
        Assert.False(ApprovalRules.CanApply(ask with { Decision = PolicyEngine.Deny }, "shell", policy, false));
        foreach (var risk in ActionClasses.PeerForcedAsk)
            Assert.False(ApprovalRules.CanApply(ask with { RiskClass = risk }, "shell", policy, true));
        Assert.False(ApprovalRules.CanApply(ask, "setup_env", policy, false));
    }

    [Theory]
    [InlineData("git status", true)]
    [InlineData("git status; id", false)]
    [InlineData("cat /workspace/secrets/key", false)]
    public void LegacyEditableCommandHashesRemainUsableOnlyForInertCalls(string command, bool expected)
    {
        var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(ApprovalRules.NormalizeCommand(command)))).ToLowerInvariant();
        var matcher = JsonSerializer.Serialize(new { kind = "command", sha256 = hash });
        Assert.Equal(expected, ApprovalRules.Matches(ActionClasses.Write, "shell", matcher, JsonSerializer.SerializeToElement(new { command })));
    }

    [Theory]
    [InlineData("write_secret")]
    [InlineData("plugin_vault_write")]
    [InlineData("credential_export")]
    public void SecretAndVaultToolsNeverAcquireRules(string tool)
    {
        Assert.False(ApprovalRules.AllowedClass(ActionClasses.Write, tool));
        Assert.Null(ApprovalRules.Build(ActionClasses.Write, tool, Args("""{"path":"/workspace/demo"}""")));
    }

    [Fact]
    public void ConflictingShellExecutionFormsCannotReuseAnArgvGrant()
    {
        var original = Args("""{"argv":["git","status"]}""");
        var matcher = ApprovalRules.Build(ActionClasses.Write, "shell", original)!.Value.Matcher;
        var conflicting = Args("""{"argv":["git","status"],"command":"curl https://example.org"}""");
        Assert.Null(ApprovalRules.CommandShapeHash("shell", conflicting));
        Assert.Null(ApprovalRules.Build(ActionClasses.Write, "shell", conflicting));
        Assert.False(ApprovalRules.Matches(ActionClasses.Write, "shell", matcher, conflicting));
    }
}
