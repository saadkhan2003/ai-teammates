using System.Text.Json;
using System.Text.RegularExpressions;
using Teammates.Api;

namespace Teammates.UnitTests;

public class AppAwarenessTests
{
    [Fact]
    public void MapOnlyNamesPagesAndSettingsThatExist()
    {
        var root = RepoRoot();
        var webGuide = File.ReadAllText(Path.Combine(root, "apps/web/lib/app-guide.json"));
        var apiGuide = File.ReadAllText(Path.Combine(root, "apps/api/app-guide.json"));
        Assert.Equal(webGuide, apiGuide);

        var nav = File.ReadAllText(Path.Combine(root, "apps/web/components/settings-nav.tsx"));
        var hrefs = Regex.Matches(nav, "href: \"(?<href>[^\"]+)\"")
            .Select(match => match.Groups["href"].Value)
            .ToHashSet(StringComparer.Ordinal);
        Assert.NotEmpty(hrefs);
        var settingHrefs = AppGuide.Settings.Select(setting => setting.Href).ToHashSet(StringComparer.Ordinal);
        Assert.Equal(hrefs.OrderBy(item => item), settingHrefs.OrderBy(item => item));
        foreach (var setting in AppGuide.Settings)
        {
            var page = Path.Combine(root, "apps/web/app", setting.Href.Trim('/'), "page.tsx");
            Assert.True(File.Exists(page), setting.Href);
            var source = File.ReadAllText(page);
            Assert.Contains($"id=\"{setting.Id}\"", source);
        }

        var workspace = File.ReadAllText(Path.Combine(root, "apps/web/components/workspace.tsx"));
        var block = Regex.Match(workspace, @"const INFO_TABS = \[(?<body>.*?)\] as const;", RegexOptions.Singleline);
        Assert.True(block.Success);
        var tabs = Regex.Matches(block.Groups["body"].Value, "\\[\"(?<id>[^\"]+)\"")
            .Select(match => match.Groups["id"].Value)
            .ToHashSet(StringComparer.Ordinal);
        var panelTabs = AppGuide.Panels.Select(panel => panel.Tab).ToHashSet(StringComparer.Ordinal);
        Assert.Equal(tabs.OrderBy(item => item), panelTabs.OrderBy(item => item));
        var libraryBlock = Regex.Match(workspace, @"const LIBRARY_TABS = \[(?<body>.*?)\] as const;", RegexOptions.Singleline);
        Assert.True(libraryBlock.Success);
        var sections = Regex.Matches(libraryBlock.Groups["body"].Value, "\\[\"(?<id>[^\"]+)\"")
            .Select(match => match.Groups["id"].Value).ToHashSet(StringComparer.Ordinal);
        Assert.Equal(sections.OrderBy(item => item), AppGuide.Panels.Where(panel => panel.Section != null)
            .Select(panel => panel.Section!).Distinct().OrderBy(item => item));
        Assert.Contains(AppGuide.Panels, panel => panel.Id == "details" && panel.Tab == "details");
        Assert.Contains(AppGuide.Panels, panel => panel.Id == "library" && panel.Tab == "library" && panel.Section == "files");
        Assert.Contains(AppGuide.Panels, panel => panel.Id == "computer" && panel.Tab == "computer");
        Assert.Contains(AppGuide.Panels, panel => panel.Id == "routines" && panel.Tab == "library" && panel.Section == "routines");
        Assert.Contains(AppGuide.Panels, panel => panel.Id == "coding-jobs" && panel.Tab == "details");
    }

    [Fact]
    public void MapTextUsesOnlyRealAnchorsAndLinkPillsDropUnknownOnes()
    {
        var map = AppGuide.MapText();
        Assert.Contains("app://panel?tab=details", map);
        Assert.Contains("app://panel?tab=library", map);
        Assert.Contains("app://panel?tab=coding-jobs", map);
        Assert.Contains("app://settings?id=vault", map);
        Assert.Contains("Lead with the answer", AppGuide.StyleText);
        Assert.Contains("reply_to_message", AppGuide.StyleText);
        Assert.Contains("any single emoji", AppGuide.StyleText);

        foreach (Match match in Regex.Matches(map, @"app://(settings\?id=[a-z0-9-]+|panel\?tab=[a-z0-9-]+)"))
            Assert.True(AppLinks.IsAllowed(match.Value), match.Value);
        Assert.False(AppLinks.IsAllowed("app://settings?id=not-a-real-setting"));
        Assert.False(AppLinks.IsAllowed("app://panel?tab=missing"));

        var clean = AppLinks.Sanitize("See [Flux](app://settings?id=not-a-real-setting) and [Vault](app://settings?id=vault).\n```\n[Flux](app://settings?id=not-a-real-setting)\n```");
        Assert.Contains("See Flux and [Vault](app://settings?id=vault).", clean);
        Assert.Contains("```\n[Flux](app://settings?id=not-a-real-setting)\n```", clean);
    }

    [Fact]
    public void EachTurnReplacesLiveStateInTheSystemContext()
    {
        var messages = JsonDocument.Parse("[{\"role\":\"system\",\"content\":\"You are a teammate.\"},{\"role\":\"user\",\"content\":\"Hi\"}]").RootElement;
        var first = AppGuide.Inject(messages, BotAwareness.StateText(new BotAwareness.Snapshot("Where do I connect OpenRouter?", "awake", ["OpenRouter"], ["Guide digest (0 9 * * *, on)"])));
        var again = AppGuide.Inject(first, BotAwareness.StateText(new BotAwareness.Snapshot("nothing else", "asleep", [], [])));
        var text = again[0].GetProperty("content").GetString() ?? "";
        Assert.Contains("You are a teammate.", text);
        Assert.Contains("Computer: asleep", text);
        Assert.Contains("Working on: nothing else", text);
        Assert.Contains("Connected: none", text);
        Assert.Contains("Routines: none", text);
        Assert.DoesNotContain("Computer: awake", text);
        Assert.DoesNotContain("Guide digest", text);
        Assert.Single(Regex.Matches(text, Regex.Escape("[app-context]")).Cast<Match>());
        Assert.Equal("Hi", again[1].GetProperty("content").GetString());
    }

    [Fact]
    public void MergedToolsKeepCodingJobsRepliesAndAnySingleEmoji()
    {
        using var schema = JsonDocument.Parse(JsonSerializer.Serialize(ToolSchema.ForModel()));
        var names = schema.RootElement.EnumerateArray()
            .Select(tool => tool.GetProperty("function").GetProperty("name").GetString()).ToArray();
        Assert.Contains("report_coding_job", names);
        Assert.Contains("reply_to_message", names);
        Assert.Contains("react_to_message", names);
        Assert.Equal(names.Length, names.Distinct().Count());
        using var job = JsonDocument.Parse("""{"title":"Merge UI","status":"tests","branch":"ui-integrate","files_changed":"15"}""");
        using var reply = JsonDocument.Parse("""{"message_id":"11111111-1111-4111-8111-111111111111"}""");
        using var reaction = JsonDocument.Parse("""{"message_id":"11111111-1111-4111-8111-111111111111","emoji":"🌟"}""");
        using var missing = JsonDocument.Parse("{}");
        Assert.Null(ToolSchema.Validate("report_coding_job", job.RootElement));
        Assert.Null(ToolSchema.Validate("reply_to_message", reply.RootElement));
        Assert.Null(ToolSchema.Validate("react_to_message", reaction.RootElement));
        Assert.Equal("reply_to_message requires message_id", ToolSchema.Validate("reply_to_message", missing.RootElement));
        Assert.True(ActionClassifier.IsBuiltIn("reply_to_message"));
        Assert.Equal(ActionClasses.Write, ActionClassifier.Classify("reply_to_message", reply.RootElement));
    }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "apps/web/components/settings-nav.tsx")))
                return dir.FullName;
            dir = dir.Parent;
        }
        throw new InvalidOperationException("repo root not found");
    }
}
