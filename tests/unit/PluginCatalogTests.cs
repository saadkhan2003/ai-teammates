using System.Text.Json;

namespace Teammates.UnitTests;

public class PluginCatalogTests
{
    private static string Fixture(params string[] parts)
    {
        var dir = AppContext.BaseDirectory;
        for (var i = 0; i < 8; i++)
        {
            var candidate = Path.Combine(dir, "tests", "fixtures", Path.Combine(parts));
            if (File.Exists(candidate)) return File.ReadAllText(candidate);
            var nested = Path.Combine(new[] { dir }.Concat(parts).ToArray());
            if (File.Exists(nested)) return File.ReadAllText(nested);
            dir = Path.GetDirectoryName(dir)!;
        }
        var workspace = Path.Combine("/workspace/tests/fixtures", Path.Combine(parts));
        return File.ReadAllText(workspace);
    }

    [Fact]
    public void ManifestRejectsABlankNameAndAcceptsARemoteMcpRow()
    {
        var bad = Sample() with { Name = "" };
        Assert.False(Teammates.Api.PluginManifestRules.Validate(bad).Ok);
        var good = Teammates.Api.PluginManifestRules.Validate(Sample());
        Assert.True(good.Ok);
    }

    [Fact]
    public void RegistryPagesDedupeAndStayIdempotent()
    {
        var first = Teammates.Api.McpRegistry.Parse(Fixture("registry", "page1.json"));
        var second = Teammates.Api.McpRegistry.Parse(Fixture("registry", "page2.json"));
        Assert.Equal("page-2", first.NextCursor);
        Assert.Equal("", second.NextCursor);
        var once = Teammates.Api.McpRegistry.Dedupe(first.Entries);
        var twice = Teammates.Api.McpRegistry.Dedupe(first.Entries.Concat(second.Entries).Concat(first.Entries));
        Assert.Equal(4, once.Count);
        Assert.DoesNotContain(once, item => item.Name == "Deleted");
        Assert.Equal(once.Count, Teammates.Api.McpRegistry.Dedupe(first.Entries.Concat(first.Entries)).Count);
        var remote = twice.Single(item => item.DedupeKey.Contains("mcp.example.com", StringComparison.Ordinal));
        Assert.Equal("2.0.0", remote.Version);
        Assert.Equal("pending", remote.CheckStatus);
        Assert.Equal("listed", remote.Label);
        var package = twice.Single(item => item.PackageRef.Contains("@example/tool", StringComparison.Ordinal));
        Assert.Equal("skipped", package.CheckStatus);
        Assert.Equal("listed", package.Label);
        var keyed = twice.Single(item => item.Name == "Keyed remote");
        Assert.Equal("needs-auth", keyed.Label);
        Assert.Equal("needs-auth", keyed.CheckStatus);
        var blocked = twice.Where(item => item.CheckStatus == "failed").ToArray();
        Assert.Equal(2, blocked.Length);
        Assert.All(blocked, item => Assert.Equal("", item.RemoteUrl));
        Assert.Equal(twice.Select(item => item.Id).Distinct().Count(), twice.Count);
    }

    [Fact]
    public void StatsDoNotCountSkippedOrPendingAsChecked()
    {
        var rows = new (string, string)[]
        {
            ("auto-checked", "passed"),
            ("tested", "passed"),
            ("needs-auth", "needs-auth"),
            ("failed", "failed"),
            ("listed", "skipped"),
            ("listed", "pending")
        };
        var stats = Teammates.Api.CatalogStats.Count(rows);
        Assert.Equal(6, stats["imported"]);
        Assert.Equal(1, stats["autoChecked"]);
        Assert.Equal(1, stats["tested"]);
        Assert.Equal(2, stats["countsTowardTarget"]);
        Assert.Equal(1, stats["needsAuth"]);
        Assert.Equal(1, stats["failed"]);
        Assert.Equal(1, stats["skipped"]);
        Assert.Equal(1, stats["pending"]);
    }

    [Fact]
    public void OpenApiSpecBecomesToolsAndAuth()
    {
        var pets = Teammates.Api.OpenApiSpec.Generate(Fixture("openapi", "petstore.json"), "https://pets.example.com/openapi.json");
        Assert.True(pets.Ok, pets.Error);
        Assert.Equal("openapi", pets.Manifest!.Kind);
        Assert.Equal("none", pets.Manifest.AuthType);
        Assert.Equal("auto-checked", pets.Manifest.Label);
        Assert.Equal(3, pets.Manifest.Tools.Count);
        Assert.Contains(pets.Manifest.Tools, tool => tool.Name == "list_pets" && tool.ActionClass == Teammates.Api.ActionClasses.Read);
        Assert.Contains(pets.Manifest.Tools, tool => tool.Name == "delete_pet" && tool.ActionClass == Teammates.Api.ActionClasses.Delete);
        var notes = Teammates.Api.OpenApiSpec.Generate(Fixture("openapi", "swagger2.json"), "https://notes.example.com/swagger.json");
        Assert.True(notes.Ok, notes.Error);
        Assert.Equal("api_key", notes.Manifest!.AuthType);
        Assert.Equal("needs-auth", notes.Manifest.Label);
        Assert.Equal("https://notes.example.com/api", notes.Manifest.RemoteUrl);
    }

    [Theory]
    [InlineData("file:///etc/passwd")]
    [InlineData("http://127.0.0.1/spec.json")]
    [InlineData("http://10.1.2.3/spec.json")]
    [InlineData("http://192.168.1.9/spec.json")]
    [InlineData("http://172.16.0.4/spec.json")]
    [InlineData("http://169.254.169.254/latest/meta-data")]
    [InlineData("http://[::1]/spec.json")]
    [InlineData("http://localhost/spec.json")]
    [InlineData("http://user:pass@pets.example.com/spec.json")]
    public void MaliciousSpecUrlsAreBlocked(string url)
    {
        Assert.True(Teammates.Api.SsrfGuard.LiteralBlocked(url, out _));
        var spec = """{"openapi":"3.0.3","info":{"title":"X","version":"1"},"servers":[{"url":"%URL%"}],"paths":{"/x":{"get":{"operationId":"get_x"}}}}""".Replace("%URL%", url);
        var generated = Teammates.Api.OpenApiSpec.Generate(spec, url.StartsWith("http", StringComparison.Ordinal) ? "" : url);
        Assert.False(generated.Ok);
        Assert.Null(generated.Manifest);
    }

    [Fact]
    public void OversizedAndWideSpecsAreRejected()
    {
        var huge = new string('{', Teammates.Api.PluginLimits.MaxSpecBytes + 8);
        var sized = Teammates.Api.OpenApiSpec.Generate(huge, "");
        Assert.Equal("spec_too_large", sized.Error);
        var paths = string.Join(",", Enumerable.Range(0, Teammates.Api.PluginLimits.MaxOperations + 1).Select(i => $"\"/i{i}\":{{\"get\":{{\"operationId\":\"get_item_{i}\"}}}}"));
        var wide = "{\"openapi\":\"3.0.3\",\"info\":{\"title\":\"Wide\",\"version\":\"1\"},\"servers\":[{\"url\":\"https://wide.example.com\"}],\"paths\":{" + paths + "}}";
        var generated = Teammates.Api.OpenApiSpec.Generate(wide, "https://wide.example.com/openapi.json");
        Assert.Equal("too_many_operations", generated.Error);
        Assert.False(Teammates.Api.OpenApiSpec.Generate(":\n- :\n", "").Ok);
        Assert.Equal("spec_not_json", Teammates.Api.OpenApiSpec.Generate("\topenapi: 1\n", "").Error);
    }

    [Fact]
    public void PrivateAddressesStayBlockedAfterResolution()
    {
        var uri = new Uri("https://public.example.com/mcp");
        Assert.True(Teammates.Api.SsrfGuard.UriBlocked(uri, [System.Net.IPAddress.Parse("10.0.0.8")], out var reason));
        Assert.Equal("private_ip", reason);
        Assert.True(Teammates.Api.SsrfGuard.AddressBlocked(System.Net.IPAddress.Parse("::ffff:127.0.0.1")));
        Assert.True(Teammates.Api.SsrfGuard.LiteralBlocked("http://2130706433/", out _));
    }

    [Theory]
    [InlineData("list_pets", "", "GET", "read")]
    [InlineData("create_pet", "Create a pet", "POST", "write")]
    [InlineData("send_email", "Email the customer", "POST", "send_message")]
    [InlineData("send_payment", "Charge the card", "POST", "payment")]
    [InlineData("delete_pet", "", "DELETE", "delete")]
    [InlineData("list_messages", "List messages", "GET", "read")]
    public void RiskComesFromTheTool(string name, string description, string method, string expected)
    {
        Assert.Equal(expected, Teammates.Api.PluginRisk.Derive(name, description, method));
    }

    [Fact]
    public void PluginCallsUseTheDerivedClassInsideTheGate()
    {
        var send = Gate("plugin_abcd1234_send_email", Teammates.Api.ActionClasses.SendMessage);
        Assert.Equal(Teammates.Api.PolicyEngine.Ask, send.Decision);
        Assert.Equal(Teammates.Api.ActionClasses.SendMessage, send.RiskClass);
        var payment = Gate("plugin_abcd1234_charge", Teammates.Api.ActionClasses.Payment);
        Assert.Equal(Teammates.Api.PolicyEngine.Ask, payment.Decision);
        var read = Gate("plugin_abcd1234_list_pets", Teammates.Api.ActionClasses.Read);
        Assert.Equal(Teammates.Api.PolicyEngine.Allow, read.Decision);
        var named = Teammates.Api.PolicyGate.Evaluate(
            "plugin_abcd1234_send_email",
            JsonDocument.Parse("{}").RootElement,
            new HashSet<string>(),
            Teammates.Api.UserPolicy.Default,
            [],
            null,
            false);
        Assert.Equal(Teammates.Api.ActionClasses.SendMessage, named.RiskClass);
    }

    private static Teammates.Api.PolicyDecision Gate(string tool, string action)
    {
        return Teammates.Api.PolicyGate.Evaluate(
            tool,
            JsonDocument.Parse("{}").RootElement,
            new HashSet<string>(),
            Teammates.Api.UserPolicy.Default,
            [],
            null,
            false,
            null,
            new Teammates.Api.PluginCallHint(action, tool, "POST"));
    }

    private static Teammates.Api.PluginManifest Sample() => new(
        "mcp_0123456789abcdef01234567",
        "Example",
        "example",
        "https://github.com/example/remote",
        "1.0.0",
        "mcp",
        "remote",
        "none",
        "MCP",
        "unknown",
        "official",
        "listed",
        "pending",
        "",
        "remote:https://mcp.example.com/rpc",
        "https://mcp.example.com/rpc",
        "",
        [],
        "",
        "",
        "");
}
