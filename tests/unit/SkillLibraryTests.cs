using System.Text.Json;
using Teammates.Api;

namespace Teammates.UnitTests;

public sealed class SkillLibraryTests
{
    [Fact]
    public void BotVisibilityRequiresMatchingOwnerAndOptionalBotScope()
    {
        var owner = Guid.NewGuid(); var otherOwner = Guid.NewGuid(); var bot = Guid.NewGuid(); var otherBot = Guid.NewGuid();
        Assert.True(SkillLibraryRoutes.VisibleToBot(owner, owner, null, bot));
        Assert.True(SkillLibraryRoutes.VisibleToBot(owner, owner, bot, bot));
        Assert.False(SkillLibraryRoutes.VisibleToBot(owner, owner, otherBot, bot));
        Assert.False(SkillLibraryRoutes.VisibleToBot(owner, otherOwner, null, bot));
    }

    [Fact]
    public void BuiltinsAreReadOnlyAndBotsCanOnlyEditBotAuthoredSkills()
    {
        Assert.False(SkillLibraryRoutes.CanOwnerMutate("builtin"));
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
    }

    [Fact]
    public void SkillValidationRejectsCredentialShapedBodiesAndEnforcesUtf8Cap()
    {
        Assert.True(SkillLibraryRoutes.Valid("safe-guide", "Safe guide", "When needed", "# Safe\nDocument the steps."));
        Assert.False(SkillLibraryRoutes.Valid("safe-guide", "Safe guide", "When needed", "api_key=sk-or-v1-12345678901234567890"));
        Assert.False(SkillLibraryRoutes.Valid("safe-guide", "Safe guide", "When needed", "api_key=sk_live_12345678901234567890"));
        Assert.False(SkillLibraryRoutes.Valid("safe-guide", "Safe guide", "When needed", new string('x', SkillLibraryRoutes.MaxBodyLength - 3) + "💡"));
    }
}
