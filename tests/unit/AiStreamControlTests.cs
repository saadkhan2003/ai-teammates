using System.Net;
using System.Text;
using System.Text.Json;
using Teammates.Api;

namespace Teammates.UnitTests;

public class AiStreamControlTests
{
    private static JsonElement J(string json) => JsonSerializer.Deserialize<JsonElement>(json);
    private static readonly JsonElement Messages = J("""[{"role":"system","content":"fixed"},{"role":"system","content":"memory"},{"role":"user","content":"hello"}]""");
    private static readonly object[] Tools = [new { type = "function", function = new { name = "read", parameters = new { type = "object" } } }];
    private static AiEndpoint Endpoint(string model = "primary", string kind = "mock") => new(Guid.NewGuid(), kind, "http://mock/v1", model, _ => Task.FromResult<byte[]?>(Encoding.UTF8.GetBytes("unit-active-key")));
    private static AiResolution Resolution(AiEndpoint primary) => new(primary, [], new(), new(1234), 42,
        new(new() { ["chat"] = new(new(primary.ProviderId, primary.Model)) }, Retry: new(0, 1, 30)),
        Role: new(new(primary.ProviderId, primary.Model)), Breakers: new());
    private static string Frame(object data) => "data: " + JsonSerializer.Serialize(data) + "\n\n";
    private static string Chunk(string model, string text) => Frame(new { model, choices = new[] { new { delta = new { content = text } } } });
    private static HttpResponseMessage Ok(string model = "primary", string text = "Hello. ") => new(HttpStatusCode.OK) { Content = new StringContent(Chunk(model, text) +
        Frame(new { model, choices = Array.Empty<object>(), usage = new { prompt_tokens = 30, completion_tokens = 5, prompt_tokens_details = new { cached_tokens = 20 }, cache_creation_input_tokens = 2, cost = .001m } }) + "data: [DONE]\n\n") };
    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) { ct.ThrowIfCancellationRequested(); return Task.FromResult(send(request)); }
    }
    private static Task<ModelStreamResult> Stream(HttpClient http, AiResolution resolution, Func<ModelDelta, Task>? publish = null, CancellationToken ct = default,
        Func<TimeSpan, CancellationToken, Task>? delay = null) => AiStreamingGateway.Stream(http, resolution, Messages, Tools, Guid.NewGuid(), publish ?? (_ => Task.CompletedTask), ct, delay);

    [Fact]
    public async Task Kill_stop_and_spend_block_run_before_keys_or_network()
    {
        var keys = 0; var requests = 0;
        var e = Endpoint() with { Key = _ => { keys++; return Task.FromResult<byte[]?>([1]); } };
        using var http = new HttpClient(new Handler(_ => { requests++; return Ok(); }));
        var stopped = await Stream(http, Resolution(e) with { KillSwitch = new("stop") });
        Assert.Contains("paused", stopped.Call.BlockReason);
        var blocked = await Stream(http, Resolution(e) with { CheckSpend = _ => Task.FromResult(new AiSpendDecision(true)) });
        Assert.Contains("spending limit", blocked.Call.BlockReason);
        Assert.Equal(0, keys); Assert.Equal(0, requests);
        Assert.Null(stopped.TtftMs); Assert.Null(blocked.TtftMs);
    }

    [Theory]
    [InlineData(true)] [InlineData(false)]
    public async Task Safe_pin_and_spend_downgrade_cannot_escape_to_fallback(bool safe)
    {
        var primary = Endpoint(); var target = Endpoint("safe"); var calls = 0;
        using var http = new HttpClient(new Handler(request =>
        {
            calls++; Assert.Equal("safe", J(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult()).GetProperty("model").GetString());
            return new(HttpStatusCode.ServiceUnavailable);
        }));
        var r = Resolution(primary) with { Fallbacks = [Endpoint("escape")], EndpointFor = _ => target,
            KillSwitch = safe ? new("safe", new(target.ProviderId, target.Model)) : null,
            CheckSpend = _ => Task.FromResult(safe ? new AiSpendDecision() : new(false, new(target.ProviderId, target.Model))) };
        Assert.False((await Stream(http, r)).Call.Ok); Assert.Equal(1, calls);
        var conflict = await Stream(http, r with { KillSwitch = new("safe", new(target.ProviderId, target.Model)), CheckSpend = _ => Task.FromResult(new AiSpendDecision(false, new(primary.ProviderId, primary.Model))) });
        Assert.Contains("spending limit", conflict.Call.BlockReason); Assert.Equal(1, calls);
    }

    [Fact]
    public async Task Privacy_routing_fallback_array_cache_anchors_and_role_limits_share_one_payload()
    {
        var e = Endpoint("anthropic/claude-primary", "openrouter") with { MaxCompletionTokens = 700 };
        var fallback = e with { Model = "anthropic/claude-fallback", MaxCompletionTokens = 400 };
        using var http = new HttpClient(new Handler(request =>
        {
            var p = J(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
            Assert.True(p.GetProperty("stream").GetBoolean()); Assert.False(p.TryGetProperty("model", out _));
            Assert.Equal(new[] { e.Model, fallback.Model }, p.GetProperty("models").EnumerateArray().Select(v => v.GetString()));
            var routing = p.GetProperty("provider"); Assert.True(routing.GetProperty("require_parameters").GetBoolean());
            Assert.True(routing.GetProperty("zdr").GetBoolean()); Assert.Equal("deny", routing.GetProperty("data_collection").GetString());
            Assert.Equal(1.234, routing.GetProperty("preferred_max_latency").GetDouble());
            Assert.Equal(400, p.GetProperty("max_tokens").GetInt32()); Assert.Equal(.2, p.GetProperty("temperature").GetDouble());
            Assert.Equal(p.GetProperty("session_id").GetString(), p.GetProperty("prompt_cache_key").GetString());
            Assert.True(p.GetProperty("stream_options").GetProperty("include_usage").GetBoolean());
            foreach (var m in p.GetProperty("messages").EnumerateArray().Take(2)) Assert.True(m.GetProperty("content")[0].TryGetProperty("cache_control", out _));
            Assert.True(p.GetProperty("tools")[0].TryGetProperty("cache_control", out _));
            return Ok(fallback.Model);
        }));
        var result = await Stream(http, Resolution(e) with { Fallbacks = [fallback], Role = new(new(e.ProviderId, e.Model), MaxTokens: 900, Privacy: true, Temperature: .2) });
        Assert.True(result.Call.Ok); Assert.True(result.Call.FallbackUsed); Assert.Equal(fallback, result.Call.Served); Assert.Equal(fallback.Model, result.Call.AnsweredModel);
        var usage = ProviderWire.ReadUsage(result.Call.Response); Assert.Equal(20, usage.CachedTokens); Assert.Equal(2, usage.CacheWriteTokens); Assert.Equal(.001m, usage.CostUsd);
    }

    [Theory]
    [InlineData("chat", "mock", 73)] [InlineData("coding", "openai", 113)] [InlineData("quick", "anthropic", 29)] [InlineData("vision", "google", 41)]
    public async Task Each_request_uses_its_resolved_role_token_limit(string role, string kind, int cap)
    {
        var e = Endpoint(kind: kind);
        var seen = new List<int>();
        using var http = new HttpClient(new Handler(request =>
        {
            seen.Add(J(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult()).GetProperty("max_tokens").GetInt32());
            return kind == "anthropic" ? new(HttpStatusCode.OK) { Content = new StringContent(Frame(new { type = "message_stop" })) } : Ok();
        }));
        var r = Resolution(e) with { RoleName = role, Role = new(new(e.ProviderId, e.Model), MaxTokens: cap) };
        Assert.True((await Stream(http, r)).Call.Ok);
        Assert.True((await Stream(http, r with { Role = r.Role! with { MaxTokens = cap + 1 } })).Call.Ok);
        Assert.Equal(new[] { cap, cap + 1 }, seen);
    }

    [Fact]
    public async Task Privacy_and_catalog_capability_gate_block_before_network()
    {
        var e = Endpoint(); var calls = 0;
        using var http = new HttpClient(new Handler(_ => { calls++; return Ok(); }));
        Assert.NotNull((await Stream(http, Resolution(e) with { Role = new(new(e.ProviderId, e.Model), Privacy: true) })).Call.BlockReason);
        Assert.NotNull((await Stream(http, Resolution(e with { Catalog = new(e.Model, Tools: false) }))).Call.BlockReason);
        Assert.Equal(0, calls);
    }

    [Fact]
    public async Task Transient_failure_retries_with_retry_after_then_falls_back_and_opens_breaker()
    {
        var e = Endpoint(); var fallback = Endpoint("fallback"); var calls = 0; var waits = new List<TimeSpan>();
        using var http = new HttpClient(new Handler(_ =>
        {
            calls++; if (calls > 2) return Ok("fallback");
            var response = new HttpResponseMessage(HttpStatusCode.TooManyRequests); response.Headers.RetryAfter = new(TimeSpan.FromSeconds(7)); return response;
        }));
        var r = Resolution(e) with { Fallbacks = [fallback], Config = Resolution(e).Config with { Retry = new(1, 1, 30) } };
        var result = await Stream(http, r, delay: (d, _) => { waits.Add(d); return Task.CompletedTask; });
        Assert.True(result.Call.Ok); Assert.True(result.Call.FallbackUsed); Assert.Equal(fallback, result.Call.Served); Assert.Equal(3, calls);
        Assert.Equal(TimeSpan.FromSeconds(7), Assert.Single(waits)); Assert.False(r.Breakers!.Enter(e));
    }

    [Fact]
    public async Task Sse_error_before_content_can_fallback_but_never_after_published_text_or_tool()
    {
        foreach (var prefix in new[] { "", Chunk("primary", "Already visible. "), Frame(new { model = "primary", choices = new[] { new { delta = new { tool_calls = new[] { new { index = 0, function = new { name = "read" } } } } } } }) })
        {
            var e = Endpoint(); var calls = 0; var published = new List<ModelDelta>();
            using var http = new HttpClient(new Handler(_ => ++calls == 1 ? new(HttpStatusCode.OK) { Content = new StringContent(prefix + Frame(new { error = new { message = "transient" } })) } : Ok("fallback")));
            var result = await Stream(http, Resolution(e) with { Fallbacks = [Endpoint("fallback")] }, d => { published.Add(d); return Task.CompletedTask; });
            Assert.Equal(prefix.Length == 0, result.Call.Ok); Assert.Equal(prefix.Length == 0 ? 2 : 1, calls);
            if (prefix.Length > 0) { Assert.Single(published); Assert.False(result.Call.FallbackUsed); Assert.Equal("primary", result.Call.AnsweredModel); }
        }
    }

    [Fact]
    public async Task Midstream_failure_preserves_reported_usage_and_served_router_model()
    {
        var e = Endpoint(kind: "openrouter"); var fallback = e with { Model = "fallback" }; var calls = 0;
        using var http = new HttpClient(new Handler(_ =>
        {
            calls++;
            return new(HttpStatusCode.OK) { Content = new StringContent(Chunk("fallback", "Visible. ") + Frame(new { usage = new { prompt_tokens = 10, completion_tokens = 2, cost = .03m } }) + Frame(new { error = new { message = "broken" } })) };
        }));
        var result = await Stream(http, Resolution(e) with { Fallbacks = [fallback] });
        Assert.False(result.Call.Ok); Assert.True(result.Call.FallbackUsed); Assert.Equal("fallback", result.Call.AnsweredModel);
        Assert.Equal(.03m, ProviderWire.ReadUsage(result.Call.Response).CostUsd); Assert.Equal(1, calls);
    }

    [Fact]
    public async Task Active_401_rotates_once_and_redacts_both_keys_in_prompt_and_output()
    {
        var e = Endpoint() with { NextKey = _ => Task.FromResult<byte[]?>(Encoding.UTF8.GetBytes("unit-next-key")) }; var calls = 0;
        using var http = new HttpClient(new Handler(request =>
        {
            calls++; Assert.Equal(calls == 1 ? "unit-active-key" : "unit-next-key", request.Headers.Authorization!.Parameter);
            Assert.DoesNotContain("unit-next-key", request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
            return calls == 1 ? new(HttpStatusCode.Unauthorized) : Ok(text: "unit-active-key unit-next-key. ");
        }));
        var published = new StringBuilder();
        var result = await AiStreamingGateway.Stream(http, Resolution(e), J("""[{"role":"user","content":"unit-active-key"}]"""), Tools, Guid.NewGuid(), d => { published.Append(d.Text); return Task.CompletedTask; }, default);
        Assert.True(result.Call.Ok); Assert.Equal(2, calls); Assert.DoesNotContain("unit-active-key", published.ToString()); Assert.DoesNotContain("unit-next-key", published.ToString());
    }

    [Fact]
    public async Task Cancellation_does_not_retry_or_fallback()
    {
        var e = Endpoint(); var calls = 0; using var cts = new CancellationTokenSource();
        using var http = new HttpClient(new Handler(_ => { calls++; cts.Cancel(); throw new OperationCanceledException(cts.Token); }));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Stream(http, Resolution(e) with { Fallbacks = [Endpoint("fallback")] }, ct: cts.Token));
        Assert.Equal(1, calls);
    }
}
