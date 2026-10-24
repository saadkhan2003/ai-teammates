using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Teammates.Compute;

namespace Teammates.Api;

// Mutable state belongs to one wire attempt, never to a request or config snapshot.
internal sealed class AiWireAttempt
{
    public bool ContentStarted { get; set; }
    public JsonElement Response { get; set; }
}

/// <summary>Shared admission, routing, retry and key rotation for complete and streaming calls.</summary>
public static class AiControlledGateway
{
    public static Task<AiCallResult> Complete(HttpClient http, AiResolution resolution, JsonElement messages, object tools, Guid sessionId, CancellationToken ct,
        Func<TimeSpan, CancellationToken, Task>? delay = null)
    {
        return Execute(http, resolution, messages, tools, sessionId, ct, delay);
    }

    internal static async Task<AiCallResult> Execute(HttpClient http, AiResolution resolution, JsonElement messages, object tools, Guid sessionId, CancellationToken ct,
        Func<TimeSpan, CancellationToken, Task>? delay = null,
        Func<HttpResponseMessage, AiEndpoint, IReadOnlyList<string>, AiWireAttempt, CancellationToken, Task<JsonElement>>? readStream = null)
    {
        delay ??= Task.Delay;
        var prompt = messages;
        var served = resolution.Primary;
        var policy = resolution.Config.Retry ?? new();
        var breaker = resolution.Breakers;
        var endpoints = new[] { resolution.Primary }.Concat(resolution.Fallbacks).ToList();
        if (resolution.KillSwitch?.Mode == "stop") return new(false, false, false, default, prompt, served, BlockReason: "Model requests are temporarily paused.");
        var spend = resolution.CheckSpend == null ? new AiSpendDecision() : await resolution.CheckSpend(ct);
        if (spend.Blocked || resolution.KillSwitch is { Mode: "safe", SafeModel: { } capSafe } && spend.Downgrade != null && spend.Downgrade != capSafe) return new(false, false, false, default, prompt, served, BlockReason: "The spending limit has been reached. Please try again later.");
        var forced = resolution.KillSwitch is { Mode: "safe", SafeModel: { } safe } ? safe : spend.Downgrade;
        if (forced != null)
        {
            if (resolution.EndpointFor == null) return new(false, false, false, default, prompt, served, BlockReason: "Model requests are temporarily paused.");
            var selected = resolution.EndpointFor(forced);
            if (resolution.Role?.Privacy == true && selected.Kind != "openrouter")
                return new(false, false, false, default, prompt, served, BlockReason: "Model requests are temporarily paused.");
            endpoints = [selected];
        }
        // The same runtime gate protects both adapters, including emergency targets.
        if (endpoints.Any(e => resolution.Role?.Privacy == true && e.Kind != "openrouter" ||
            resolution.Role != null && e.Catalog != null && AiCapabilities.Reasons(resolution.RoleName, resolution.Role,
                new(e.ProviderId, "", e.Kind, e.BaseUrl, true, [e.Catalog], true, null), e.Catalog).Count > 0))
            return new(false, false, false, default, prompt, served, BlockReason: "Model requests are temporarily paused.");
        // Origin console restrictions also apply to forced targets and router-side fallbacks.
        if (resolution.CheckEndpoint != null)
        {
            var allowed = new List<AiEndpoint>();
            string? denied = null;
            foreach (var endpoint in endpoints)
            {
                var reason = await resolution.CheckEndpoint(endpoint, ct);
                if (reason == null) allowed.Add(endpoint); else denied ??= reason;
            }
            if (allowed.Count == 0) return new(false, false, false, default, prompt, served, BlockReason: denied);
            endpoints = allowed;
        }
        var missing = true;
        // Router-side fallback is restricted to models configured on the same provider.
        var grouped = new HashSet<(Guid, string)>();
        foreach (var endpoint in endpoints)
        {
            if (grouped.Contains((endpoint.ProviderId, endpoint.Model))) continue;
            var routed = endpoint.Kind == "openrouter" ? endpoints.Where(e => e.ProviderId == endpoint.ProviderId).ToList() : [endpoint];
            // Exclude open models, and take one probe lease for each model sent to the router.
            var admitted = routed.Where(e => breaker?.Enter(e) ?? true).ToList();
            foreach (var e in routed) grouped.Add((e.ProviderId, e.Model));
            if (admitted.Count == 0) continue;
            var current = admitted[0];
            var bytes = await current.Key(ct);
            if (bytes == null) { foreach (var e in admitted) breaker?.CancelProbe(e); continue; }
            missing = false; served = current;
            var key = Encoding.UTF8.GetString(bytes);
            var knownKeys = new List<string> { key };
            CryptographicOperations.ZeroMemory(bytes);
            var rotated = false;
            var finished = false;
            try
            {
                prompt = JsonSerializer.Deserialize<JsonElement>(Dlp.Redact(OutputRedactor.Redact(prompt.GetRawText(), [key])));
                var payload = AiRequestPolicy.Payload(current, admitted, resolution, prompt, tools, sessionId);
                for (var attempt = 0; attempt <= policy.MaxRetries; attempt++)
                {
                    var wire = new AiWireAttempt();
                    try
                    {
                        if (readStream != null)
                        {
                            payload["stream"] = true;
                            if (current.Kind != "anthropic")
                            {
                                payload.Remove("usage");
                                payload["stream_options"] = new System.Text.Json.Nodes.JsonObject { ["include_usage"] = true };
                            }
                        }
                        using var request = new HttpRequestMessage(HttpMethod.Post, current.Kind == "anthropic" ? AiGateway.MessagesUrl(current.BaseUrl) : current.BaseUrl.TrimEnd('/') + "/chat/completions");
                        if (current.Kind == "anthropic") { request.Headers.Add("x-api-key", key); request.Headers.Add("anthropic-version", "2023-06-01"); }
                        else request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
                        request.Content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json");
                        using var response = await http.SendAsync(request, readStream == null ? HttpCompletionOption.ResponseContentRead : HttpCompletionOption.ResponseHeadersRead, ct);
                        if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized && !rotated && current.NextKey != null)
                        {
                            var next = await current.NextKey(ct);
                            rotated = true;
                            if (next != null)
                            {
                                var nextKey = Encoding.UTF8.GetString(next); CryptographicOperations.ZeroMemory(next);
                                // Neither rotating slot may escape via a prompt echo or error body.
                                prompt = JsonSerializer.Deserialize<JsonElement>(Dlp.Redact(OutputRedactor.Redact(prompt.GetRawText(), [key, nextKey])));
                                key = nextKey; knownKeys.Add(key);
                                payload = AiRequestPolicy.Payload(current, admitted, resolution, prompt, tools, sessionId);
                                attempt--; continue;
                            }
                        }
                        if (response.StatusCode is System.Net.HttpStatusCode.TooManyRequests or System.Net.HttpStatusCode.RequestTimeout || (int)response.StatusCode >= 500)
                        {
                            if (attempt < policy.MaxRetries) { await delay(AiCircuitBreaker.Backoff(response.Headers.RetryAfter, attempt, DateTimeOffset.UtcNow), ct); continue; }
                            foreach (var e in admitted) breaker?.Failure(e, policy);
                            finished = true; break;
                        }
                        if (!response.IsSuccessStatusCode)
                        {
                            var raw = await response.Content.ReadAsStringAsync(ct);
                            foreach (var e in admitted) breaker?.Success(e);
                            finished = true;
                            return new(false, false, raw.Contains("context_length", StringComparison.OrdinalIgnoreCase) || raw.Contains("maximum context", StringComparison.OrdinalIgnoreCase) || raw.Contains("too many tokens", StringComparison.OrdinalIgnoreCase), default, prompt, served);
                        }
                        JsonElement result;
                        if (readStream != null) result = await readStream(response, current, knownKeys, wire, ct);
                        else
                        {
                            var raw = await response.Content.ReadAsStringAsync(ct);
                            using var doc = JsonDocument.Parse(OutputRedactor.Redact(raw, knownKeys));
                            result = current.Kind == "anthropic" ? ProviderWire.FromAnthropic(doc.RootElement) : doc.RootElement.Clone();
                        }
                        var answered = result.TryGetProperty("model", out var model) && model.ValueKind == JsonValueKind.String ? model.GetString() ?? current.Model : current.Model;
                        // Router response identifies which configured model actually answered.
                        var actual = admitted.FirstOrDefault(e => e.Model == answered) ?? current;
                        var actualIndex = admitted.IndexOf(actual);
                        for (var index = 0; index < admitted.Count; index++)
                            if (index < actualIndex) breaker?.Failure(admitted[index], policy);
                            else if (index == actualIndex) breaker?.Success(admitted[index]);
                            else breaker?.CancelProbe(admitted[index]);
                        finished = true;
                        return new(true, false, false, result, prompt, actual, answered,
                            FallbackUsed: actual.ProviderId != resolution.Primary.ProviderId || answered != resolution.Primary.Model);
                    }
                    catch (Exception ex) when (!ct.IsCancellationRequested && (ex is HttpRequestException or IOException or InvalidDataException or OperationCanceledException or JsonException ||
                        readStream != null && ex is (InvalidOperationException or KeyNotFoundException or FormatException)))
                    {
                        if (wire.ContentStarted)
                        {
                            // Content/tool output makes this attempt final, even if DLP is still buffering it.
                            var answered = wire.Response.ValueKind == JsonValueKind.Object && wire.Response.TryGetProperty("model", out var model) ? model.GetString() ?? current.Model : current.Model;
                            var actual = admitted.FirstOrDefault(e => e.Model == answered) ?? current;
                            foreach (var e in admitted) { if (e == actual) breaker?.Failure(e, policy); else breaker?.CancelProbe(e); }
                            finished = true;
                            return new(false, false, false, wire.Response, prompt, actual, answered,
                                FallbackUsed: actual.ProviderId != resolution.Primary.ProviderId || answered != resolution.Primary.Model);
                        }
                        if (attempt < policy.MaxRetries) { await delay(AiCircuitBreaker.Backoff(null, attempt, DateTimeOffset.UtcNow), ct); continue; }
                        foreach (var e in admitted) breaker?.Failure(e, policy);
                        finished = true;
                    }
                }
            }
            finally { key = ""; knownKeys.Clear(); if (!finished) foreach (var e in admitted) breaker?.CancelProbe(e); }
        }
        return new(false, missing, false, default, prompt, served);
    }
}
