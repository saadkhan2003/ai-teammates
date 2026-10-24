using System.Text.Json;
using Teammates.Api;

namespace Teammates.UnitTests;

public sealed class SkillLibraryTests
{
    [Fact]
    public void DuplicateNamesMapToTheStableConflictResponseForCreatesAndRenames()
    {
        Assert.True(SkillLibraryRoutes.IsSkillNameConflict("23505", "skill_library_scope_name"));
        Assert.False(SkillLibraryRoutes.IsSkillNameConflict("23505", "other_unique_key"));
        Assert.False(SkillLibraryRoutes.IsSkillNameConflict("23503", "skill_library_scope_name"));
        Assert.Equal("skill_name_taken", SkillLibraryRoutes.SkillNameTaken);
    }

    [Fact]
    public void BotVisibilityRequiresMatchingOwnerAndOptionalBotScope()
    {
        var owner = Guid.NewGuid(); var otherOwner = Guid.NewGuid(); var bot = Guid.NewGuid(); var otherBot = Guid.NewGuid();
        Assert.True(SkillLibraryRoutes.VisibleToBot(owner, owner, null, bot));
        Assert.True(SkillLibraryRoutes.VisibleToBot(owner, owner, bot, bot));
        Assert.True(SkillLibraryRoutes.VisibleToBot(owner, owner, otherBot, bot));
        Assert.False(SkillLibraryRoutes.VisibleToBot(owner, otherOwner, null, bot));
    }

    [Fact]
    public void BuiltinsAreReadOnlyAndBotsCanOnlyEditBotAuthoredSkills()
    {
        Assert.False(SkillLibraryRoutes.CanOwnerMutate("builtin"));
        Assert.False(SkillLibraryRoutes.CanDelete("builtin"));
        Assert.True(SkillLibraryRoutes.CanDelete("bot"));
        Assert.True(SkillLibraryRoutes.CanOwnerMutate("user"));
        Assert.True(SkillLibraryRoutes.CanOwnerMutate("bot"));
        Assert.False(SkillLibraryRoutes.CanBotEdit("builtin"));
        Assert.False(SkillLibraryRoutes.CanBotEdit("builtin", ownerAllows: true));
        Assert.False(SkillLibraryRoutes.CanBotEdit("user"));
        Assert.True(SkillLibraryRoutes.CanBotEdit("user", ownerAllows: true));
        Assert.True(SkillLibraryRoutes.CanBotEdit("bot"));
        Assert.Equal(ActionClasses.Write, ActionClassifier.Classify("write_skill", JsonDocument.Parse("{}").RootElement));
        Assert.Equal(ActionClasses.Read, ActionClassifier.Classify("load_skill", JsonDocument.Parse("{}").RootElement));
        Assert.True(ActionClassifier.IsBuiltIn("write_skill"));
        Assert.Equal(PolicyEngine.Allow, PolicyGate.Evaluate("write_skill", JsonDocument.Parse("{}").RootElement, new HashSet<string>(), UserPolicy.Default, [], null, false).Decision);
    }

    [Fact]
    public void CatalogHasStableOrderingAndBothCaps()
    {
        var lines = SkillLibraryRoutes.FormatCatalog(new[]
        {
            ("z-user", "user hint", "user"), ("b-builtin", "builtin hint", "builtin"), ("a-bot", "bot hint", "bot"), ("a-user", "user hint", "user")
        });
        Assert.Equal(new[] { "b-builtin: builtin hint", "a-user: user hint", "z-user: user hint", "a-bot: bot hint" }, lines);
        Assert.Equal(60, SkillLibraryRoutes.FormatCatalog(Enumerable.Range(0, 100).Select(i => ($"skill-{i:000}", "use", "user"))).Count);
        var longLines = SkillLibraryRoutes.FormatCatalog(Enumerable.Range(0, 80).Select(i => ($"skill-{i:000}", new string('x', 200), "user")));
        Assert.True(longLines.Count <= 60);
        Assert.True(string.Join("\n", longLines).Length <= SkillLibraryRoutes.MaxCatalogCharacters);
        var clipped = SkillLibraryRoutes.FormatCatalog(new[] { ("skill", new string('x', 5000), "user") });
        Assert.EndsWith("…", clipped[0]);
    }

    [Fact]
    public void HelperFilesAreTextOnlySizeCappedAndCannotEscapeSkillDirectory()
    {
        Assert.True(SkillLibraryRoutes.ValidFiles(JsonSerializer.SerializeToElement(new Dictionary<string, string> { ["examples/sample.txt"] = "plain text" })));
        Assert.False(SkillLibraryRoutes.ValidFiles(JsonSerializer.SerializeToElement(new Dictionary<string, string> { ["../secret.txt"] = "no" })));
        Assert.False(SkillLibraryRoutes.ValidFiles(JsonSerializer.SerializeToElement(new Dictionary<string, string> { ["large.txt"] = new string('x', SkillLibraryRoutes.MaxFilesBytes + 1) })));
        Assert.False(SkillLibraryRoutes.ValidFiles(JsonSerializer.SerializeToElement(new Dictionary<string, string> { ["private.txt"] = "token=sk-or-v1-12345678901234567890" })));
    }

    [Fact]
    public void DeleteSkillIsAnApprovalGatedDeleteAction()
    {
        Assert.Equal(ActionClasses.Delete, ActionClassifier.Classify("delete_skill", JsonDocument.Parse("{\"name\":\"review\"}").RootElement));
        Assert.True(ActionClassifier.IsBuiltIn("delete_skill"));
        Assert.Equal(PolicyEngine.Ask, PolicyGate.Evaluate("delete_skill", JsonDocument.Parse("{\"name\":\"review\"}").RootElement, new HashSet<string>(), UserPolicy.Default, [], null, false).Decision);
        Assert.Equal(ActionClasses.Read, ActionClassifier.Classify("read_skill_file", JsonDocument.Parse("{\"name\":\"review\",\"path\":\"steps.txt\"}").RootElement));
    }

    [Fact]
    public void SkillValidationRejectsCredentialShapedBodiesAndEnforcesUtf8Cap()
    {
        Assert.True(SkillLibraryRoutes.Valid("safe-guide", "Safe guide", "When needed", "# Safe\nDocument the steps."));
        Assert.False(SkillLibraryRoutes.Valid("safe-guide", "Safe guide", "When needed", "api_key=sk-or-v1-12345678901234567890"));
        Assert.False(SkillLibraryRoutes.Valid("safe-guide", "Safe guide", "When needed", "api_key=sk_live_12345678901234567890"));
        Assert.False(SkillLibraryRoutes.Valid("safe-guide", "Safe guide", "When needed", new string('x', SkillLibraryRoutes.MaxBodyLength - 3) + "💡"));
        Assert.False(SkillLibraryRoutes.Valid("Not Valid", "Safe guide", "When needed", "safe"));
        Assert.False(SkillLibraryRoutes.Valid("safe-guide", "Safe guide", "token=sk-or-v1-12345678901234567890", "safe"));
    }
    [Theory]
    [InlineData("load_skill", ActionClasses.Read)]
    [InlineData("write_skill", ActionClasses.Write)]
    public void SkillToolsHonorExplicitAskAndDeny(string tool, string actionClass)
    {
        var args = JsonSerializer.SerializeToElement(new { name = "review", title = "Review", when_to_use = "When reviewing", body = "Safe steps" });
        foreach (var mode in new[] { PolicyEngine.Ask, PolicyEngine.Deny })
        {
            var policy = new UserPolicy();
            policy.Classes[actionClass] = mode;
            var decision = PolicyGate.Evaluate(tool, args, new HashSet<string>(), policy, [], null, false);
            Assert.Equal(mode, decision.Decision);
        }
    }

    [Fact]
    public void WriteCompatibilityRouteRequiresMatchingBotAndFencedTaskEnvelope()
    {
        var bot = Guid.NewGuid();
        var task = Guid.NewGuid();
        var valid = JsonSerializer.SerializeToElement(new { botId = bot, taskId = task, epoch = 1, tool = "write_skill", args = new { name = "review" } });
        Assert.True(SkillLibraryRoutes.ValidWriteRequest(bot, valid));
        Assert.False(SkillLibraryRoutes.ValidWriteRequest(Guid.NewGuid(), valid));
        foreach (var invalid in new[] { "{}", "null", "[]", "{\"botId\":123}",
            $"{{\"botId\":\"{bot}\",\"taskId\":true}}",
            $"{{\"botId\":\"{bot}\",\"taskId\":\"{task}\",\"epoch\":\"1\"}}" })
            Assert.False(SkillLibraryRoutes.ValidWriteRequest(bot, JsonDocument.Parse(invalid).RootElement));
    }

    [Fact]
    public void SkillWritesDeduplicateRetriesWithoutDeduplicatingLoads()
    {
        Assert.True(ToolDedupe.Applies("write_skill", "stable-key"));
        Assert.False(ToolDedupe.Applies("write_skill", null));
        Assert.False(ToolDedupe.Applies("load_skill", "stable-key"));
    }

    [Fact]
    public void SkillSchemasAndMemoryExtensionsCoexistWithoutDuplicateNames()
    {
        var tools = ToolSchema.Builtins().Select(tool => JsonSerializer.SerializeToElement(tool).GetProperty("function")).ToArray();
        var names = tools.Select(tool => tool.GetProperty("name").GetString()).ToArray();
        Assert.Equal(names.Length, names.Distinct().Count());
        Assert.Contains("load_skill", names);
        Assert.Contains("read_skill_file", names);
        Assert.Contains("save_skill", names);
        Assert.Contains("delete_skill", names);
        Assert.Contains("write_skill", names);
        Assert.Contains("update_memory", names);
        Assert.Null(ToolSchema.Validate("write_skill", JsonSerializer.SerializeToElement(new { name = "review", title = "Review", when_to_use = "When reviewing", body = "Safe" })));
        var fields = tools.Single(tool => tool.GetProperty("name").GetString() == "save_memory").GetProperty("parameters").GetProperty("properties");
        Assert.True(fields.TryGetProperty("scope", out _));
        Assert.True(fields.TryGetProperty("visibility", out _));
    }
}
