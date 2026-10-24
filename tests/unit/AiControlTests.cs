using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Teammates.Api;

namespace Teammates.UnitTests;

public sealed class AiControlTests
{
    private static JsonElement J(string value) => JsonDocument.Parse(value).RootElement.Clone();
    private static readonly JsonElement Messages = J("""[{"role":"system","content":"fixed"},{"role":"system","content":"dynamic"},{"role":"user","content":"hello"}]""");
    private static readonly JsonElement Tools = J("""[{"type":"function","function":{"name":"read","parameters":{"type":"object"}}}]""");
    private static AiEndpoint Endpoint(string model = "m", Guid? provider = null) => new(provider ?? Guid.NewGuid(), "mock", "http://mock/v1", model, _ => Task.FromResult<byte[]?>(Encoding.UTF8.GetBytes("unit-active-key")));
    private static AiResolution Resolution(AiEndpoint endpoint, AiConfig? config = null) => new(endpoint, [], new(), new(), 1, config ?? new(new() { ["chat"] = new(new(endpoint.ProviderId, endpoint.Model)) }));
    private static HttpResponseMessage Ok(string model = "m") => new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(new { model, choices = new[] { new { message = new { role = "assistant", content = "ok" } } } })) };
    private sealed class Handler(Func<HttpRequestMessage, Task<HttpResponseMessage>> send) : HttpMessageHandler
    { protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) { ct.ThrowIfCancellationRequested(); return send(request); } }
    private sealed class Clock : TimeProvider { public DateTimeOffset At = DateTimeOffset.UtcNow; public override DateTimeOffset GetUtcNow() => At; }

    [Fact]
    public void Circuit_closes_opens_allows_single_probe_and_recovers()
    {
        var clock = new Clock(); var breaker = new AiCircuitBreaker(clock); var endpoint = Endpoint(); var policy = new AiRetry(0, 2, 10);
        Assert.True(breaker.Enter(endpoint)); breaker.Failure(endpoint, policy); Assert.True(breaker.Enter(endpoint));
        breaker.Failure(endpoint, policy); Assert.False(breaker.Enter(endpoint));
        clock.At += TimeSpan.FromSeconds(11); Assert.True(breaker.Enter(endpoint)); Assert.False(breaker.Enter(endpoint));
        Assert.Contains("half-open", JsonSerializer.Serialize(breaker.Health()));
        breaker.Failure(endpoint, policy); Assert.False(breaker.Enter(endpoint)); clock.At += TimeSpan.FromSeconds(11);
        Assert.True(breaker.Enter(endpoint)); breaker.Success(endpoint); Assert.True(breaker.Enter(endpoint)); Assert.Contains("closed", JsonSerializer.Serialize(breaker.Health()));
    }
    [Fact]
    public void Retry_after_honors_delta_date_and_uses_bounded_jitter()
    {
        var now = DateTimeOffset.UtcNow;
        Assert.Equal(TimeSpan.FromSeconds(7), AiCircuitBreaker.Backoff(new(TimeSpan.FromSeconds(7)), 0, now));
        Assert.Equal(TimeSpan.FromSeconds(12), AiCircuitBreaker.Backoff(new(now.AddSeconds(12)), 1, now));
        Assert.InRange(AiCircuitBreaker.Backoff(null, 1, now).TotalMilliseconds, 225, 300);
    }
    [Fact]
    public async Task Retries_transient_status_then_succeeds_and_records_served_model()
    {
        var e = Endpoint(); var calls = 0; var waits = new List<TimeSpan>();
        using var http = new HttpClient(new Handler(_ => { calls++; if (calls == 1) { var r = new HttpResponseMessage(HttpStatusCode.TooManyRequests); r.Headers.RetryAfter = new(TimeSpan.FromSeconds(3)); return Task.FromResult(r); } return Task.FromResult(Ok("actual")); }));
        var result = await AiGateway.Complete(http, Resolution(e), Messages, Array.Empty<object>(), Guid.NewGuid(), default, (d, _) => { waits.Add(d); return Task.CompletedTask; });
        Assert.True(result.Ok); Assert.Equal("actual", result.AnsweredModel); Assert.Equal(2, calls); Assert.Equal(TimeSpan.FromSeconds(3), Assert.Single(waits));
    }
    [Fact]
    public async Task Open_breaker_skips_primary_and_uses_next_provider()
    {
        var primary = Endpoint(); var fallback = Endpoint("b"); var breaker = new AiCircuitBreaker(); breaker.Failure(primary, new(0, 1, 60));
        var requests = 0; using var http = new HttpClient(new Handler(_ => { requests++; return Task.FromResult(Ok("b")); }));
        var r = await AiGateway.Complete(http, Resolution(primary) with { Fallbacks = [fallback], Breakers = breaker }, Messages, Array.Empty<object>(), Guid.NewGuid(), default);
        Assert.True(r.Ok); Assert.True(r.FallbackUsed); Assert.Equal(fallback.ProviderId, r.Served.ProviderId); Assert.Equal(1, requests);
    }
    [Fact]
    public async Task Router_chain_require_parameters_privacy_clamp_temperature_and_session_are_sent()
    {
        var primary = Endpoint("anthropic/claude-test") with { Kind = "openrouter", MaxCompletionTokens = 500 };
        var fallback = primary with { Model = "anthropic/claude-small", MaxCompletionTokens = 300 };
        var session = Guid.NewGuid(); var role = new AiRole(new(primary.ProviderId, primary.Model), MaxTokens: 900, Temperature: 0.2, Privacy: true);
        using var http = new HttpClient(new Handler(async request =>
        {
            var body = J(await request.Content!.ReadAsStringAsync());
            Assert.False(body.TryGetProperty("model", out _)); Assert.Equal(2, body.GetProperty("models").GetArrayLength());
            Assert.Equal(primary.Model, body.GetProperty("models")[0].GetString()); Assert.Equal(fallback.Model, body.GetProperty("models")[1].GetString());
            var provider = body.GetProperty("provider"); Assert.True(provider.GetProperty("require_parameters").GetBoolean()); Assert.True(provider.GetProperty("zdr").GetBoolean()); Assert.Equal("deny", provider.GetProperty("data_collection").GetString());
            Assert.Equal(session.ToString("D"), body.GetProperty("session_id").GetString()); Assert.Equal(300, body.GetProperty("max_tokens").GetInt32()); Assert.Equal(0.2, body.GetProperty("temperature").GetDouble());
            Assert.Equal("ephemeral", body.GetProperty("messages")[0].GetProperty("content")[0].GetProperty("cache_control").GetProperty("type").GetString());
            Assert.Equal("dynamic", body.GetProperty("messages")[1].GetProperty("content").GetString()); Assert.True(body.GetProperty("tools")[0].TryGetProperty("cache_control", out _));
            return Ok(fallback.Model);
        }));
        var result = await AiGateway.Complete(http, Resolution(primary) with { Fallbacks = [fallback], Role = role }, Messages, Tools, session, default);
        Assert.True(result.Ok); Assert.Equal(fallback.Model, result.AnsweredModel); Assert.True(result.FallbackUsed);
    }
    [Fact]
    public void Cache_flags_and_native_system_tool_breakpoints_preserve_order()
    {
        var e = Endpoint("claude-test") with { Kind = "openrouter" };
        var body = AiRequestPolicy.Payload(e, [e], Resolution(e) with { Caching = new(false) }, Messages, Tools, Guid.NewGuid()).ToJsonString();
        Assert.DoesNotContain("cache_control", body); Assert.DoesNotContain("session_id", body);
        var native = JsonSerializer.SerializeToElement(ProviderWire.AnthropicCompletion("m", Messages, Tools, new()));
        Assert.True(native.GetProperty("system")[0].TryGetProperty("cache_control", out _)); Assert.False(native.GetProperty("system")[1].TryGetProperty("cache_control", out _)); Assert.True(native.GetProperty("tools")[0].TryGetProperty("cache_control", out _));
        Assert.Equal(2048, AiCapabilities.MaxTokens(null, e)); Assert.Equal(100, AiCapabilities.MaxTokens(new(new(e.ProviderId, "m"), MaxTokens: 800), e with { MaxCompletionTokens = 100 }));
    }
    [Fact]
    public void Catalog_parses_capabilities_prices_limits_and_expiration()
    {
        var models = AiCatalog.Parse(J("""{"data":[{"id":"a","name":"A","supported_parameters":["tools"],"context_length":10000,"architecture":{"input_modalities":["text","image"],"output_modalities":["text"]},"top_provider":{"max_completion_tokens":2000},"pricing":{"prompt":"0.001"},"expiration_date":"2027-01-01"},{"id":"b"}]}"""));
        Assert.Equal(2, models.Count); var m = models[0]; Assert.True(m.Tools); Assert.True(m.Vision); Assert.Equal(10000, m.ContextTokens); Assert.Equal(2000, m.MaxCompletionTokens); Assert.Equal("0.001", m.Pricing!["prompt"]); Assert.Equal("2027-01-01", m.ExpirationDate); Assert.Null(models[1].ExpirationDate);
    }
    [Theory]
    [InlineData("chat", false, false, 2000, false, "tools")]
    [InlineData("coding", false, false, 2000, false, "tools")]
    [InlineData("vision", true, false, 2000, false, "image")]
    [InlineData("quick", true, false, 100, false, "context_length")]
    [InlineData("chat", true, true, 2000, true, "privacy")]
    public void Capability_rejections_explain_the_missing_contract(string role, bool tools, bool vision, int context, bool privacy, string reason)
    {
        var e = Endpoint(); var provider = new AiProvider(e.ProviderId, "test", "mock", e.BaseUrl, true, [], false, null);
        Assert.Contains(AiCapabilities.Reasons(role, new(new(e.ProviderId, "m"), Privacy: privacy, MinContextTokens: 1000), provider, new("m", Tools: tools, Vision: vision, ContextTokens: context)), error => error.Contains(reason));
    }
    [Fact]
    public async Task Kill_stop_is_fast_and_safe_mode_pins_every_role()
    {
        var e = Endpoint(); var safe = Endpoint("safe"); var requests = 0;
        using var http = new HttpClient(new Handler(_ => { requests++; return Task.FromResult(Ok("safe")); }));
        var stopped = await AiGateway.Complete(http, Resolution(e) with { KillSwitch = new("stop") }, Messages, Array.Empty<object>(), Guid.NewGuid(), default);
        Assert.False(stopped.Ok); Assert.Contains("paused", stopped.BlockReason); Assert.Equal(0, requests);
        var pinned = await AiGateway.Complete(http, Resolution(e) with { KillSwitch = new("safe", new(safe.ProviderId, safe.Model)), EndpointFor = _ => safe }, Messages, Array.Empty<object>(), Guid.NewGuid(), default);
        Assert.True(pinned.Ok); Assert.Equal(safe.ProviderId, pinned.Served.ProviderId); Assert.Equal(1, requests);
        var privateRole = new AiRole(new(e.ProviderId, e.Model), Privacy: true);
        var blockedPrivacy = await AiGateway.Complete(http, Resolution(e) with { Role = privateRole, KillSwitch = new("safe", new(safe.ProviderId, safe.Model)), EndpointFor = _ => safe }, Messages, Array.Empty<object>(), Guid.NewGuid(), default);
        Assert.False(blockedPrivacy.Ok); Assert.NotNull(blockedPrivacy.BlockReason); Assert.Equal(1, requests);
    }
    [Fact]
    public async Task Spend_plan_user_bot_caps_block_or_downgrade_without_provider_calls_when_blocked()
    {
        var owner = Guid.NewGuid(); var bot = Guid.NewGuid(); var e = Endpoint(); var cheap = new AiTarget(e.ProviderId, "cheap");
        var budgets = new AiBudgets(Plans: new() { ["default"] = new(10, 100) }, Users: new() { [owner] = new(2, Action: "downgrade", Downgrade: cheap) }, Bots: new() { [bot] = new(Monthly: 1) });
        Assert.False(AiSpendCache.Decide(budgets, owner, bot, new(0, 0), new(0, 0)).Blocked);
        Assert.Equal(cheap, AiSpendCache.Decide(budgets, owner, bot, new(2, 2), new(0, 0)).Downgrade);
        Assert.True(AiSpendCache.Decide(budgets, owner, bot, new(2, 2), new(0, 1)).Blocked);
        var requests = 0; using var http = new HttpClient(new Handler(_ => { requests++; return Task.FromResult(Ok("cheap")); }));
        var blocked = await AiGateway.Complete(http, Resolution(e) with { CheckSpend = _ => Task.FromResult(new AiSpendDecision(true)) }, Messages, Array.Empty<object>(), Guid.NewGuid(), default);
        Assert.Contains("spending limit", blocked.BlockReason); Assert.Equal(0, requests);
        var result = await AiGateway.Complete(http, Resolution(e) with { CheckSpend = _ => Task.FromResult(new AiSpendDecision(false, cheap)), EndpointFor = _ => e with { Model = "cheap" } }, Messages, Array.Empty<object>(), Guid.NewGuid(), default);
        Assert.True(result.Ok); Assert.Equal("cheap", result.Served.Model); Assert.Equal(1, requests);
    }
    [Fact]
    public async Task Unauthorized_active_retries_once_with_next_and_no_key_material_is_returned()
    {
        var count = 0; var e = Endpoint() with { NextKey = _ => Task.FromResult<byte[]?>(Encoding.UTF8.GetBytes("unit-next-key")) };
        using var http = new HttpClient(new Handler(request =>
        {
            count++; Assert.Equal(count == 1 ? "unit-active-key" : "unit-next-key", request.Headers.Authorization!.Parameter);
            return Task.FromResult(count == 1 ? new(HttpStatusCode.Unauthorized) : Ok());
        }));
        var result = await AiGateway.Complete(http, Resolution(e), Messages, Array.Empty<object>(), Guid.NewGuid(), default);
        Assert.True(result.Ok); Assert.Equal(2, count); Assert.DoesNotContain("unit-next-key", JsonSerializer.Serialize(result, AiModelRegistry.Json));
        count = 0; using var invalid = new HttpClient(new Handler(_ => { count++; return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Unauthorized)); }));
        Assert.False((await AiGateway.Complete(invalid, Resolution(e), Messages, Array.Empty<object>(), Guid.NewGuid(), default)).Ok); Assert.Equal(2, count);
    }
    [Fact]
    public void Golden_hard_checks_judge_bounds_and_eval_gate_are_fail_closed()
    {
        var c = new AiGoldenCase("json", "input", new(["ok"], Json: true), "rubric");
        Assert.True(AiEvals.HardCheck(c, "{\"ok\":true}")); Assert.False(AiEvals.HardCheck(c, "ok")); Assert.False(AiEvals.HardCheck(c, "{}"));
        Assert.Equal(0.9m, AiEvals.JudgeScore("{\"score\":0.9}")); Assert.Throws<JsonException>(() => AiEvals.JudgeScore("{\"score\":2}"));
        Assert.True(AiEvals.MayPublish(0.95m, 1, true, 0.05m)); Assert.False(AiEvals.MayPublish(0.94m, 1, true, 0.05m)); Assert.False(AiEvals.MayPublish(1, 1, false, 0.05m));
    }
    [Fact]
    public void Catalog_cost_estimate_includes_cache_tokens_and_preserves_reported_cost()
    {
        var e = Endpoint() with { Catalog = new("m", Pricing: new() { ["prompt"] = "0.1", ["completion"] = "0.2", ["input_cache_read"] = "0.01", ["input_cache_write"] = "0.2" }) };
        Assert.Equal(13.2m, AiUsage.Price(new(100, 20, 0, 20, 10), e).CostUsd);
        Assert.Equal(1m, AiUsage.Price(new(100, 20, 1, 20, 10), e).CostUsd);
    }
    [Fact]
    public void Downgrade_requires_a_cheaper_capable_model_and_valid_role_controls()
    {
        var id = Guid.NewGuid();
        var provider = new AiProvider(id, "p", "openrouter", "http://mock/v1", true, [new("primary", Tools: true, Pricing: new() { ["prompt"] = "0.1", ["completion"] = "0.2" }), new("cheap", Tools: true, Pricing: new() { ["prompt"] = "0.01", ["completion"] = "0.02" })], true, null);
        var config = new AiConfig(new() { ["chat"] = new(new(id, "primary")) }, Budgets: new(Plans: new() { ["default"] = new(1, Action: "downgrade", Downgrade: new(id, "cheap")) }));
        Assert.Empty(AiModelRegistry.Validate(config, [provider]));
        Assert.NotEmpty(AiModelRegistry.Validate(config with { Roles = new() { ["chat"] = new(new(id, "cheap")) } }, [provider]));
        Assert.NotEmpty(AiModelRegistry.Validate(config with { Roles = new() { ["chat"] = new(new(id, "primary"), Temperature: 3) } }, [provider]));
    }

}
