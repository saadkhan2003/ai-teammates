using System.Net;
using System.Text;
using System.Text.Json;
using Teammates.Api;
using ApiPlatform = Teammates.Api.Platform;

namespace Teammates.UnitTests;

public sealed class AiModelTests
{
    private static JsonElement Parse(string json) => JsonDocument.Parse(json).RootElement.Clone();
    private static AiProvider Provider(Guid id, string model = "m") => new(id, "test", "mock", "http://mock/v1", true, [new(model, Tools: true)], true, null);
    private static AiEndpoint Endpoint(Guid id) => new(id, "mock", "http://mock/v1", "m", _ => Task.FromResult<byte[]?>(Encoding.UTF8.GetBytes("fake-test-key")));

    [Theory]
    [InlineData("mock", null, "mock/planner")]
    [InlineData("openrouter", null, ApiPlatform.DefaultRealModel)]
    [InlineData("mock", "custom", "custom")]
    public void Environment_bootstrap_retains_legacy_model(string provider, string? configured, string expected)
    {
        var config = AiModelRegistry.Bootstrap(provider, ApiPlatform.PlannerModel(provider, configured));
        Assert.Equal(Guid.Empty, config.Roles["chat"].Primary.Provider);
        Assert.Equal(expected, config.Roles["chat"].Primary.Model);
    }

    [Fact]
    public void Rollout_is_deterministic_and_obeys_percent_edges()
    {
        var users = Enumerable.Range(0, 1000).Select(_ => Guid.NewGuid()).ToArray();
        foreach (var user in users)
        {
            Assert.False(AiModelRegistry.Candidate(user, 2, 0));
            Assert.True(AiModelRegistry.Candidate(user, 2, 100));
            Assert.Equal(AiModelRegistry.Candidate(user, 2, 31), AiModelRegistry.Candidate(user, 2, 31));
        }
        Assert.InRange(users.Count(u => AiModelRegistry.Candidate(u, 2, 31)), 220, 410);
        Assert.Contains(users, u => AiModelRegistry.Candidate(u, 2, 31) != AiModelRegistry.Candidate(u, 3, 31));
    }

    [Fact]
    public void Validation_checks_roles_provider_model_rollout_prices_and_urls()
    {
        var id = Guid.NewGuid();
        var provider = Provider(id);
        var config = new AiConfig(new() { ["chat"] = new(new(id, "m")) });
        Assert.Empty(AiModelRegistry.Validate(config, [provider]));
        Assert.NotEmpty(AiModelRegistry.Validate(config with { Roles = [] }, [provider]));
        Assert.NotEmpty(AiModelRegistry.Validate(config, [provider with { Enabled = false }]));
        Assert.NotEmpty(AiModelRegistry.Validate(config, [provider with { Models = [new("other")] }]));
        Assert.NotEmpty(AiModelRegistry.Validate(config with { Rollout = new(2, 101) }, [provider]));
        Assert.NotEmpty(AiModelRegistry.Validate(config with { Rollout = new(null, 1) }, [provider]));
        Assert.NotEmpty(AiModelRegistry.Validate(config with { CreditPrices = new() { ["default"] = new() { ["m"] = new(-1, 1, 1) } } }, [provider]));
        Assert.Throws<ArgumentException>(() => AiAdmin.ValidateProvider(provider with { BaseUrl = "https://user:password@example.com/v1" }));
        Assert.Throws<ArgumentException>(() => AiAdmin.ValidateProvider(provider with { BaseUrl = "https://example.com/v1?key=x" }));
    }

    [Theory]
    [InlineData(429)]
    [InlineData(500)]
    [InlineData(503)]
    [InlineData(-1)]
    [InlineData(-2)]
    public async Task Transient_failures_try_next_provider(int status)
    {
        var first = Endpoint(Guid.NewGuid()); var second = Endpoint(Guid.NewGuid());
        var count = 0;
        using var http = new HttpClient(new Fake(async request =>
        {
            count++;
            var body = await request.Content!.ReadAsStringAsync();
            Assert.DoesNotContain("fake-test-key", body);
            if (count == 1)
            {
                if (status == -1) throw new TaskCanceledException("timeout");
                if (status == -2) throw new HttpRequestException("connect");
                return new((HttpStatusCode)status);
            }
            return new(HttpStatusCode.OK) { Content = new StringContent("{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"ok\"}}]}") };
        }));
        var resolution = new AiResolution(first, [second], new(), new(), 7, new(new() { ["chat"] = new(new(first.ProviderId, "m")) }, Retry: new(0)));
        var result = await AiGateway.Complete(http, resolution, Parse("[{\"role\":\"user\",\"content\":\"fake-test-key\"}]"), Array.Empty<object>(), Guid.NewGuid(), default);
        Assert.True(result.Ok); Assert.Equal(second.ProviderId, result.Served.ProviderId); Assert.Equal(2, count);
    }

    [Fact]
    public async Task Invalid_credentials_do_not_trigger_fallback_and_cancellation_is_respected()
    {
        var endpoint = Endpoint(Guid.NewGuid()); var count = 0;
        var resolution = new AiResolution(endpoint, [endpoint], new(), new(), 1, new(new() { ["chat"] = new(new(endpoint.ProviderId, "m")) }));
        using var http = new HttpClient(new Fake(_ => { count++; return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Unauthorized) { Content = new StringContent("never echo this") }); }));
        var messages = Parse("[{\"role\":\"user\",\"content\":\"hello\"}]");
        Assert.False((await AiGateway.Complete(http, resolution, messages, Array.Empty<object>(), Guid.NewGuid(), default)).Ok);
        Assert.Equal(1, count);
        using var cancel = new CancellationTokenSource(); cancel.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => AiGateway.Complete(http, resolution, messages, Array.Empty<object>(), Guid.NewGuid(), cancel.Token));
    }

    [Fact]
    public void Anthropic_translates_system_tools_results_images_and_cache_usage()
    {
        var messages = Parse("""
        [{"role":"system","content":"instructions"}, {"role":"user","content":"hello"},
         {"role":"assistant","content":"","toolCalls":[{"id":"call_a","name":"read","arguments":{"path":"/workspace/a"}}]},
         {"role":"tool","toolCallId":"call_a","content":"answer"},
         {"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,YQ=="}}]}]
        """);
        var tools = Parse("""[{"type":"function","function":{"name":"read","description":"Read","parameters":{"type":"object","properties":{}}}}]""");
        var request = JsonSerializer.SerializeToElement(ProviderWire.AnthropicCompletion("claude-test", messages, tools, new()));
        Assert.Equal("instructions", request.GetProperty("system")[0].GetProperty("text").GetString());
        Assert.Equal("ephemeral", request.GetProperty("system")[0].GetProperty("cache_control").GetProperty("type").GetString());
        Assert.Equal("read", request.GetProperty("tools")[0].GetProperty("name").GetString());
        Assert.Equal("tool_use", request.GetProperty("messages")[1].GetProperty("content")[0].GetProperty("type").GetString());
        Assert.Equal("call_a", request.GetProperty("messages")[2].GetProperty("content")[0].GetProperty("tool_use_id").GetString());
        Assert.Equal("base64", request.GetProperty("messages")[2].GetProperty("content")[1].GetProperty("source").GetProperty("type").GetString());
        var response = ProviderWire.FromAnthropic(Parse("""
        {"content":[{"type":"text","text":"working"},{"type":"tool_use","id":"call_b","name":"read","input":{"path":"x"}}],"usage":{"input_tokens":10,"output_tokens":3,"cache_read_input_tokens":20,"cache_creation_input_tokens":5}}
        """));
        var usage = ProviderWire.ReadUsage(response);
        Assert.Equal(35, usage.PromptTokens); Assert.Equal(3, usage.CompletionTokens); Assert.Equal(20, usage.CacheReadTokens); Assert.Equal(5, usage.CacheCreationTokens);
        var normalized = ProviderWire.Normalize(response.GetProperty("choices")[0].GetProperty("message"));
        Assert.Equal("call_b", normalized.GetProperty("toolCalls")[0].GetProperty("id").GetString());
        Assert.Equal("x", normalized.GetProperty("toolCalls")[0].GetProperty("arguments").GetProperty("path").GetString());
        var uncached = JsonSerializer.Serialize(ProviderWire.AnthropicCompletion("m", messages, tools, new(false)));
        Assert.DoesNotContain("cache_control", uncached);
    }

    [Fact]
    public async Task Anthropic_adapter_sets_headers_and_uses_native_path()
    {
        using var http = new HttpClient(new Fake(async request =>
        {
            Assert.Equal("http://mock/anthropic/v1/messages", request.RequestUri!.ToString());
            Assert.Equal("fake-test-key", request.Headers.GetValues("x-api-key").Single());
            Assert.Equal("2023-06-01", request.Headers.GetValues("anthropic-version").Single());
            Assert.Null(request.Headers.Authorization);
            Assert.Contains("max_tokens", await request.Content!.ReadAsStringAsync());
            return new(HttpStatusCode.OK) { Content = new StringContent("{\"content\":[{\"type\":\"text\",\"text\":\"ok\"}],\"usage\":{\"input_tokens\":2,\"output_tokens\":1}}") };
        }));
        var endpoint = Endpoint(Guid.NewGuid()) with { Kind = "anthropic", BaseUrl = "http://mock/anthropic" };
        var resolution = new AiResolution(endpoint, [], new(), new(), 1, new(new() { ["chat"] = new(new(endpoint.ProviderId, "m")) }));
        var result = await AiGateway.Complete(http, resolution, Parse("[{\"role\":\"user\",\"content\":\"hi\"}]"), Array.Empty<object>(), Guid.NewGuid(), default);
        Assert.True(result.Ok);
        Assert.Equal("ok", result.Response.GetProperty("choices")[0].GetProperty("message").GetProperty("content").GetString());
    }

    [Fact]
    public void Credit_price_map_uses_plan_model_and_multiplier()
    {
        var config = new AiConfig([], CreditPrices: new() { ["default"] = new() { ["m"] = new(2, 6, 3) } });
        Assert.Equal(0.024m, AiModelRegistry.Credits(config, "default", "m", new(1000, 1000, 0)));
        Assert.Null(AiModelRegistry.Credits(config, "missing", "m", new(1000, 1000, 0)));
        Assert.Null(AiModelRegistry.Credits(config, "default", "other", new(1000, 1000, 0)));
    }
    private sealed class Fake(Func<HttpRequestMessage, Task<HttpResponseMessage>> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) { cancellationToken.ThrowIfCancellationRequested(); return send(request); }
    }
}
