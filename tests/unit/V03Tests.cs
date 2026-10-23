using System.Text.Json;

namespace Teammates.UnitTests;

public class V03Tests
{
    [Fact]
    public void BotWorkspacesDoNotOverlap()
    {
        var left = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
        var right = Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
        Assert.NotEqual(Teammates.Api.BotFs.Root(left), Teammates.Api.BotFs.Root(right));
        var rewritten = Teammates.Api.BotFs.RewriteCommand(left, "cat /workspace/notes/private.txt");
        Assert.Contains(Teammates.Api.BotFs.Root(left) + "/notes/private.txt", rewritten);
        Assert.DoesNotContain(Teammates.Api.BotFs.Root(right), rewritten);
        Assert.Equal("ask_user options needs at least 1 item", Teammates.Api.ToolSchema.Validate("ask_user", JsonDocument.Parse("{\"prompt\":\"Pick\",\"options\":[]}").RootElement));
        Assert.Null(Teammates.Api.ToolSchema.Validate("react_to_message", JsonDocument.Parse("{\"message_id\":\"m\",\"emoji\":\"👍🏽\"}").RootElement));
        var ask = Teammates.Api.ToolSchema.ForModel().Cast<Dictionary<string, object>>().Single(tool => ((Dictionary<string, object>)tool["function"])["name"] as string == "ask_user");
        var parameters = (Dictionary<string, object>)((Dictionary<string, object>)ask["function"])["parameters"];
        var required = (List<string>)parameters["required"];
        Assert.Contains("prompt", required);
        Assert.Contains("options", required);
        var properties = (Dictionary<string, object>)parameters["properties"];
        var options = (Dictionary<string, object>)properties["options"];
        Assert.Equal(1, options["minItems"]);
        Assert.Equal("string", ((Dictionary<string, object>)options["items"])["type"]);
        var styles = (Dictionary<string, object>)properties["styles"];
        Assert.Contains("danger", (string[])((Dictionary<string, object>)styles["items"])["enum"]);
        Assert.False(((Dictionary<string, object>)ask["function"]).ContainsKey("x-fields"));
    }

    [Fact]
    public void YamlOpenApiBecomesTools()
    {
        var yaml = """
            openapi: 3.0.3
            info:
              title: Pets
              version: "1"
            servers:
              - url: https://pets.example.com
            paths:
              /pets:
                get:
                  operationId: list_pets
                  summary: List pets
            """;
        var generated = Teammates.Api.OpenApiSpec.Generate(yaml, "https://pets.example.com/openapi.yaml");
        Assert.True(generated.Ok, generated.Error);
        Assert.Contains(generated.Manifest!.Tools, tool => tool.Name == "list_pets" && tool.RiskLabel == "read");
        Assert.Equal("spec_not_json", Teammates.Api.OpenApiSpec.Generate("\tbroken: [", "").Error);
    }

    [Fact]
    public void CompactIndexStaysSmallWhenTheCatalogIsWide()
    {
        var tools = Enumerable.Range(0, 200)
            .Select(i => new Teammates.Api.ToolLine($"plugin_tool_{i}", new string('x', 400), "read"))
            .ToArray();
        var compact = Teammates.Api.ToolIndex.Compact(tools, 16_000);
        var full = string.Join("\n", tools.Select(tool => Teammates.Api.ToolIndex.Schema(tool.Name, tool.Description, "GET", "/x").ToString()));
        Assert.True(compact.Length <= Teammates.Api.ToolIndex.IndexBudget + 80);
        Assert.True(full.Length > compact.Length * 5);
        var hits = Teammates.Api.ToolIndex.Search(tools, "tool_12", 8);
        Assert.Contains(hits, hit => hit.Name == "plugin_tool_12");
        Assert.True(hits.Count <= 8);
        var schema = Teammates.Api.ToolIndex.Schema("plugin_tool_1", "Read", "GET", "/pets/{id}");
        var json = JsonSerializer.Serialize(schema);
        Assert.Contains("\"id\"", json);
        Assert.DoesNotContain("parameters", compact);
    }

    [Fact]
    public void RiskLabelsTightenTheGate()
    {
        Assert.Equal("money", Teammates.Api.PluginRiskLabels.FromAction(Teammates.Api.ActionClasses.Payment));
        Assert.Equal("destructive", Teammates.Api.PluginRiskLabels.FromAction(Teammates.Api.ActionClasses.Delete));
        Assert.Equal("send", Teammates.Api.PluginRiskLabels.FromAction(Teammates.Api.ActionClasses.SendMessage));
        Assert.Equal(Teammates.Api.ActionClasses.Payment, Teammates.Api.PluginRisk.Derive("buy_license", "Buy a seat", "POST"));
        Assert.Equal(Teammates.Api.ActionClasses.Delete, Teammates.Api.PluginRisk.Derive("wipe_disk", "Destroy the volume", "POST"));
        var decision = Teammates.Api.PolicyGate.Evaluate(
            "plugin_abcd1234_note",
            JsonDocument.Parse("{}").RootElement,
            new HashSet<string>(),
            Teammates.Api.UserPolicy.Default,
            [],
            null,
            false,
            null,
            new Teammates.Api.PluginCallHint(Teammates.Api.ActionClasses.Read, "note", "GET", "money"));
        Assert.Equal(Teammates.Api.PolicyEngine.Ask, decision.Decision);
        Assert.Equal(Teammates.Api.ActionClasses.Payment, decision.RiskClass);
        var unchanged = Teammates.Api.PluginRiskLabels.Apply(Teammates.Api.ActionClasses.Payment, "read");
        Assert.Equal(Teammates.Api.ActionClasses.Payment, unchanged);
    }

    [Fact]
    public void OutboundKeysReplayAndDoNotExecuteTwice()
    {
        var key = Teammates.Api.OutboundLog.Key(Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), "send_message", "{\"to\":\"a\"}");
        Assert.Equal(key, Teammates.Api.OutboundLog.Key(Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), "send_message", "{\"to\":\"a\"}"));
        Assert.NotEqual(key, Teammates.Api.OutboundLog.Key(null, "send_message", "{\"to\":\"a\"}"));
        Assert.Equal("send", Teammates.Api.OutboundLog.Kind("send_message", Teammates.Api.ActionClasses.SendMessage));
        Assert.Equal("post", Teammates.Api.OutboundLog.Kind("external_post", Teammates.Api.ActionClasses.ExternalPost));
        Assert.Equal("purchase", Teammates.Api.OutboundLog.Kind("plugin_abcd_buy", Teammates.Api.ActionClasses.Payment));
        Assert.Equal("plugin_write", Teammates.Api.OutboundLog.Kind("plugin_abcd_create", Teammates.Api.ActionClasses.Write));
        Assert.Equal("execute", Teammates.Api.OutboundLog.Decide(null));
        Assert.Equal("replay", Teammates.Api.OutboundLog.Decide("completed"));
        Assert.Equal("skip", Teammates.Api.OutboundLog.Decide("pending"));
        Assert.Equal("skip", Teammates.Api.OutboundLog.Decide("failed"));
        Assert.False(Teammates.Api.OutboundLog.Tracks("read_file", Teammates.Api.ActionClasses.Read));
        Assert.Equal("complete", Teammates.Api.OutboundRecovery.Plan("absent", true));
        Assert.Equal("unlink", Teammates.Api.OutboundRecovery.Plan("present", true));
        Assert.Equal("leave", Teammates.Api.OutboundRecovery.Plan("present", false));
        Assert.Equal("mark", Teammates.Api.OutboundRecovery.Plan("directory", true));
        Assert.True(Teammates.Api.OutboundRecovery.ClaimStale(null, "boot", 100));
        Assert.True(Teammates.Api.OutboundRecovery.ClaimStale("other:90", "boot", 100));
        Assert.False(Teammates.Api.OutboundRecovery.ClaimStale("boot:90", "boot", 100));
        Assert.True(Teammates.Api.OutboundRecovery.ClaimStale("boot:70", "boot", 100));
        Assert.Equal("/workspace/notes/ping.txt", Teammates.Api.OutboundRecovery.PathOf("{\"path\":\"/workspace/notes/ping.txt\"}"));
        Assert.Equal("ping", Teammates.Api.OutboundRecovery.TextOf("{\"text\":\"ping\"}", "text"));
        Assert.Equal("retry", Teammates.Api.OutboundRecovery.PlanAction("send", "missing"));
        Assert.Equal("complete", Teammates.Api.OutboundRecovery.PlanAction("send", "happened"));
        Assert.Equal("mark", Teammates.Api.OutboundRecovery.PlanAction("send", "unknown"));
        Assert.Equal("retry", Teammates.Api.OutboundRecovery.PlanAction("post", "missing"));
        Assert.Equal("mark", Teammates.Api.OutboundRecovery.PlanAction("plugin_write", "missing"));
        Assert.Equal("mark", Teammates.Api.OutboundRecovery.PlanAction("purchase", "unknown"));
        Assert.Equal("unlink", Teammates.Api.OutboundRecovery.PlanAction("delete", "present"));
        Assert.Equal("complete", Teammates.Api.OutboundRecovery.PlanAction("delete", "absent"));
        Assert.Equal("mark", Teammates.Api.OutboundRecovery.PlanAction("delete", "directory"));
        Assert.True(Teammates.Api.OutboundLog.Tracks("delete_file", Teammates.Api.ActionClasses.Delete));
        Assert.Equal("delete", Teammates.Api.OutboundLog.Kind("delete_file", Teammates.Api.ActionClasses.Delete));
        Assert.Equal("plugin_write", Teammates.Api.OutboundLog.Kind("plugin_abcd_wipe", Teammates.Api.ActionClasses.Delete));
        Assert.True(Teammates.Api.OutboundLog.Tracks("plugin_abcd_create", Teammates.Api.ActionClasses.Write));
    }

    [Fact]
    public void RoutineWatchSkipsAnUnchangedSource()
    {
        var first = Teammates.Api.RoutineWatch.Fingerprint("status:ok");
        Assert.True(Teammates.Api.RoutineWatch.Changed("", first));
        Assert.False(Teammates.Api.RoutineWatch.Changed(first, first));
        Assert.True(Teammates.Api.RoutineWatch.Changed(first, Teammates.Api.RoutineWatch.Fingerprint("status:down")));
        Assert.False(Teammates.Api.RoutineWatch.Changed(first, ""));
    }

    [Fact]
    public void HealthHidesUnhealthyPluginsAndScheduleDefaultsToDaily()
    {
        Assert.True(Teammates.Api.PluginHealth.VisibleToBots("passed", "unknown", false));
        Assert.True(Teammates.Api.PluginHealth.VisibleToBots("passed", "healthy", false));
        Assert.False(Teammates.Api.PluginHealth.VisibleToBots("passed", "unhealthy", false));
        Assert.False(Teammates.Api.PluginHealth.VisibleToBots("failed", "healthy", false));
        Assert.False(Teammates.Api.PluginHealth.VisibleToBots("passed", "healthy", true));
        Assert.Equal(1440, Teammates.Api.CatalogSchedule.ImportIntervalMinutes(null));
        Assert.Equal(1440, Teammates.Api.CatalogSchedule.ImportIntervalMinutes(""));
        Assert.Equal(0, Teammates.Api.CatalogSchedule.ImportIntervalMinutes("0"));
        Assert.Equal(30, Teammates.Api.CatalogSchedule.ImportIntervalMinutes("30"));
        Assert.Equal(1, Teammates.Api.CatalogSchedule.ScheduledPages);
    }

    [Fact]
    public void StdioPlanStaysInsideTheComputerSandbox()
    {
        var plan = Teammates.Api.StdioMcp.Plan(["python3", "-c", "print(1)"], "{\"jsonrpc\":\"2.0\"}");
        Assert.True(plan.Ok, plan.Error);
        Assert.Equal("python3", plan.Argv[0]);
        Assert.Equal("-c", plan.Argv[1]);
        Assert.Contains("RLIMIT_AS", plan.Argv[2]);
        Assert.Contains("RLIMIT_CPU", plan.Argv[2]);
        Assert.DoesNotContain("docker.sock", plan.Argv[2]);
        Assert.Equal("stdio_command_rejected", Teammates.Api.StdioMcp.Plan(["bash", "-lc", "id"], "{}").Error);
        Assert.Equal("stdio_command_rejected", Teammates.Api.StdioMcp.Plan(["python3", "/var/run/docker.sock"], "{}").Error);
        Assert.Equal("stdio_command_rejected", Teammates.Api.StdioMcp.Plan(["npx", "http://10.1.2.3/pkg"], "{}").Error);
        Assert.Equal("stdio_command_rejected", Teammates.Api.StdioMcp.Plan(["python3", "../../host"], "{}").Error);
        Assert.Equal("stdio_command_missing", Teammates.Api.StdioMcp.Plan([], "{}").Error);
        Assert.True(Teammates.Api.StdioMcp.Plan(["npx", "-y", "mcp-echo"], "{}").Ok);
        Assert.True(Teammates.Api.StdioMcp.Plan(["uvx", "mcp-echo"], "{}").Ok);
        Assert.Contains("setrlimit", Teammates.Api.StdioMcp.Wrapper);
    }
}
