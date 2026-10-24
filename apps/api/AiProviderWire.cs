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
            foreach (var anchor in new[] { system.FirstOrDefault(), definitions.LastOrDefault() })
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
            model = Text(response, "model"),
            choices = new[] { new { message = new { role = "assistant", content = text.ToString(), tool_calls = calls } } },
            usage = new { prompt_tokens = Whole(usage, "input_tokens") + read + write, completion_tokens = Whole(usage, "output_tokens"), cache_read_input_tokens = read, cache_creation_input_tokens = write }
        });
    }
}

public sealed record AiCallResult(bool Ok, bool MissingKey, bool ContextError, JsonElement Response, JsonElement Prompt, AiEndpoint Served, string? AnsweredModel = null, string? BlockReason = null, bool FallbackUsed = false);

/// <summary>Non-streaming adapter seam: retries select an endpoint, then translate one complete response.</summary>
public static class AiGateway
{
    public static string MessagesUrl(string baseUrl) => baseUrl.TrimEnd('/').EndsWith("/v1", StringComparison.Ordinal) ? baseUrl.TrimEnd('/') + "/messages" : baseUrl.TrimEnd('/') + "/v1/messages";
    public static Task<AiCallResult> Complete(HttpClient http, AiResolution resolution, JsonElement messages, object tools, Guid sessionId, CancellationToken ct,
        Func<TimeSpan, CancellationToken, Task>? delay = null) => AiControlledGateway.Complete(http, resolution, messages, tools, sessionId, ct, delay);
}
