using Teammates.Compute;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Teammates.Api;

public static partial class ProviderWire
{
    public static object AnthropicCompletion(string model, JsonElement messages, object tools, AiCaching caching)
    {
        var converted = ToOpenAi(messages);
        var system = new JsonArray();
        var output = new JsonArray();
        foreach (var m in converted.EnumerateArray())
        {
            var role = m.GetProperty("role").GetString();
            if (role == "system")
            {
                system.Add(new JsonObject { ["type"] = "text", ["text"] = ContentText(m) });
                continue;
            }
            var blocks = new JsonArray();
            if (role == "tool")
                blocks.Add(new JsonObject { ["type"] = "tool_result", ["tool_use_id"] = m.GetProperty("tool_call_id").GetString(), ["content"] = ContentText(m) });
            else
            {
                if (m.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
                {
                    foreach (var part in content.EnumerateArray())
                    {
                        if (Text(part, "type") == "text") blocks.Add(new JsonObject { ["type"] = "text", ["text"] = Text(part, "text") ?? "" });
                        else if (Text(part, "type") == "image_url")
                        {
                            var url = part.GetProperty("image_url").GetProperty("url").GetString() ?? "";
                            JsonObject source;
                            if (url.StartsWith("data:") && url.Contains(";base64,"))
                            {
                                var split = url.IndexOf(";base64,", StringComparison.Ordinal);
                                source = new() { ["type"] = "base64", ["media_type"] = url[5..split], ["data"] = url[(split + 8)..] };
                            }
                            else source = new() { ["type"] = "url", ["url"] = url };
                            blocks.Add(new JsonObject { ["type"] = "image", ["source"] = source });
                        }
                    }
                }
                else if (ContentText(m) is { Length: > 0 } text) blocks.Add(new JsonObject { ["type"] = "text", ["text"] = text });
                if (m.TryGetProperty("tool_calls", out var calls))
                    foreach (var call in calls.EnumerateArray())
                    {
                        var fn = call.GetProperty("function");
                        blocks.Add(new JsonObject { ["type"] = "tool_use", ["id"] = Text(call, "id"), ["name"] = Text(fn, "name"), ["input"] = JsonNode.Parse(Text(fn, "arguments") ?? "{}") });
                    }
            }
            if (blocks.Count == 0) blocks.Add(new JsonObject { ["type"] = "text", ["text"] = " " });
            var nextRole = role == "assistant" ? "assistant" : "user";
            // Messages requires consecutive tool results to share one user turn.
            if (output.LastOrDefault() is JsonObject previous && previous["role"]?.GetValue<string>() == nextRole)
                foreach (var block in blocks.ToArray()) ((JsonArray)previous["content"]!).Add(block!.DeepClone());
            else output.Add(new JsonObject { ["role"] = nextRole, ["content"] = blocks });
        }
        var definitions = new JsonArray();
        foreach (var tool in JsonSerializer.SerializeToElement(tools).EnumerateArray())
        {
            var fn = tool.GetProperty("function");
            definitions.Add(new JsonObject { ["name"] = Text(fn, "name"), ["description"] = Text(fn, "description") ?? "", ["input_schema"] = JsonNode.Parse(fn.GetProperty("parameters").GetRawText()) });
        }
        if (caching.Enabled && caching.AnthropicCacheControl)
        {
            foreach (var anchor in new[] { definitions.LastOrDefault(), system.FirstOrDefault(), system.LastOrDefault() }.Distinct())
                if (anchor is JsonObject obj) obj["cache_control"] = new JsonObject { ["type"] = "ephemeral", ["ttl"] = caching.Ttl };
        }
        var payload = new JsonObject { ["model"] = model, ["max_tokens"] = MaxTokens, ["messages"] = output };
        if (system.Count > 0) payload["system"] = system;
        if (definitions.Count > 0) payload["tools"] = definitions;
        return payload;
    }

    public static JsonElement FromAnthropic(JsonElement response)
    {
        var text = new StringBuilder();
        var calls = new List<object>();
        foreach (var block in response.GetProperty("content").EnumerateArray())
        {
            if (Text(block, "type") == "text") text.Append(Text(block, "text"));
            if (Text(block, "type") == "tool_use") calls.Add(new { id = Text(block, "id"), type = "function", function = new { name = Text(block, "name"), arguments = block.GetProperty("input").GetRawText() } });
        }
        var usage = response.GetProperty("usage");
        var read = Whole(usage, "cache_read_input_tokens");
        var write = Whole(usage, "cache_creation_input_tokens");
        return JsonSerializer.SerializeToElement(new
        {
            choices = new[] { new { message = new { role = "assistant", content = text.ToString(), tool_calls = calls } } },
            usage = new { prompt_tokens = Whole(usage, "input_tokens") + read + write, completion_tokens = Whole(usage, "output_tokens"), cache_read_input_tokens = read, cache_creation_input_tokens = write }
        });
    }
}

public sealed record AiCallResult(bool Ok, bool MissingKey, bool ContextError, JsonElement Response, JsonElement Prompt, AiEndpoint Served);

/// <summary>Non-streaming adapter seam: retries select an endpoint, then translate one complete response.</summary>
public static class AiGateway
{
    public static string MessagesUrl(string baseUrl) => baseUrl.TrimEnd('/').EndsWith("/v1", StringComparison.Ordinal) ? baseUrl.TrimEnd('/') + "/messages" : baseUrl.TrimEnd('/') + "/v1/messages";
    public static async Task<AiCallResult> Complete(HttpClient http, AiResolution resolution, JsonElement messages, object tools, Guid sessionId, CancellationToken ct)
    {
        var prompt = messages;
        var served = resolution.Primary;
        var missing = true;
        foreach (var endpoint in new[] { resolution.Primary }.Concat(resolution.Fallbacks))
        {
            var bytes = await endpoint.Key(ct);
            if (bytes == null) continue;
            missing = false;
            served = endpoint;
            var key = Encoding.UTF8.GetString(bytes);
            CryptographicOperations.ZeroMemory(bytes);
            try
            {
                prompt = JsonSerializer.Deserialize<JsonElement>(Dlp.Redact(OutputRedactor.Redact(prompt.GetRawText(), [key])));
                var anthropic = endpoint.Kind == "anthropic";
                object payload;
                if (anthropic) payload = ProviderWire.AnthropicCompletion(endpoint.Model, prompt, tools, resolution.Caching);
                else
                {
                    var completion = ProviderWire.Completion(endpoint.Model, prompt, tools);
                    completion["messages"] = PromptCaching.Messages((JsonElement)completion["messages"]!, resolution.Caching, endpoint.Kind);
                    if (endpoint.Kind is not ("openrouter" or "mock")) completion.Remove("usage");
                    if (JsonSerializer.SerializeToElement(tools).GetArrayLength() == 0) completion.Remove("tools");
                    if (resolution.Caching.Enabled && resolution.Caching.SessionIdPerConversation) completion["prompt_cache_key"] = sessionId.ToString("D");
                    if (endpoint.Kind == "openrouter")
                    {
                        if (resolution.Caching.SessionIdPerConversation) completion["session_id"] = sessionId.ToString("D");
                        if (resolution.Latency.PreferredMaxLatencyMs is { } ms) completion["provider"] = new { preferred_max_latency = ms / 1000.0 };
                    }
                    payload = completion;
                }
                using var request = new HttpRequestMessage(HttpMethod.Post, anthropic ? MessagesUrl(endpoint.BaseUrl) : endpoint.BaseUrl.TrimEnd('/') + "/chat/completions");
                if (anthropic) { request.Headers.Add("x-api-key", key); request.Headers.Add("anthropic-version", "2023-06-01"); }
                else request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
                request.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
                using var response = await http.SendAsync(request, ct);
                var raw = await response.Content.ReadAsStringAsync(ct);
                if (response.StatusCode == System.Net.HttpStatusCode.TooManyRequests || (int)response.StatusCode >= 500) continue;
                if (!response.IsSuccessStatusCode) return new(false, false, raw.Contains("context_length", StringComparison.OrdinalIgnoreCase) || raw.Contains("maximum context", StringComparison.OrdinalIgnoreCase) || raw.Contains("too many tokens", StringComparison.OrdinalIgnoreCase), default, prompt, served);
                using var doc = JsonDocument.Parse(OutputRedactor.Redact(raw, [key]));
                return new(true, false, false, anthropic ? ProviderWire.FromAnthropic(doc.RootElement) : doc.RootElement.Clone(), prompt, served);
            }
            catch (HttpRequestException) { }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested) { }
            finally { key = ""; }
        }
        return new(false, missing, false, default, prompt, served);
    }
}
