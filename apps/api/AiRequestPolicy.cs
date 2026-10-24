using System.Text.Json;
using System.Text.Json.Nodes;

namespace Teammates.Api;

public static class AiRequestPolicy
{
    public static JsonObject Payload(AiEndpoint endpoint, List<AiEndpoint> chain, AiResolution resolution, JsonElement messages, object tools, Guid session)
    {
        var native = endpoint.Kind == "anthropic";
        var payload = JsonSerializer.SerializeToNode(native
            ? ProviderWire.AnthropicCompletion(endpoint.Model, messages, tools, resolution.Caching)
            : ProviderWire.Completion(endpoint.Model, messages, tools))!.AsObject();
        payload["max_tokens"] = chain.Min(e => AiCapabilities.MaxTokens(resolution.Role, e));
        if (resolution.Role?.Temperature is { } temperature) payload["temperature"] = temperature;
        if (!native)
        {
            if (endpoint.Kind is not ("openrouter" or "mock")) payload.Remove("usage");
            if (JsonSerializer.SerializeToElement(tools).GetArrayLength() == 0) payload.Remove("tools");
            if (resolution.Caching.Enabled && resolution.Caching.SessionIdPerConversation) payload["prompt_cache_key"] = session.ToString("D");
            if (endpoint.Kind == "openrouter")
            {
                payload["models"] = new JsonArray(chain.Select(e => (JsonNode?)JsonValue.Create(e.Model)).ToArray());
                // OpenRouter accepts either model or models, with models representing the ordered chain.
                payload.Remove("model");
                var routing = new JsonObject { ["require_parameters"] = true };
                if (resolution.Role?.Privacy == true) { routing["zdr"] = true; routing["data_collection"] = "deny"; }
                if (resolution.Latency.PreferredMaxLatencyMs is { } ms) routing["max_latency"] = ms / 1000.0;
                payload["provider"] = routing;
                if (resolution.Caching.Enabled && resolution.Caching.SessionIdPerConversation) payload["session_id"] = session.ToString("D");
            }
            if (resolution.Caching.Enabled && resolution.Caching.AnthropicCacheControl && endpoint.Model.Contains("claude", StringComparison.OrdinalIgnoreCase))
            {
                // One fixed system block and the stable tool prefix: two breakpoints, preserving order.
                var system = payload["messages"]?.AsArray().OfType<JsonObject>().FirstOrDefault(m => m["role"]?.GetValue<string>() == "system");
                if (system?["content"] is JsonValue content && content.TryGetValue<string>(out var text))
                    system["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = text, ["cache_control"] = Cache(resolution.Caching) });
                else if (system?["content"] is JsonArray parts && parts.FirstOrDefault() is JsonObject first) first["cache_control"] = Cache(resolution.Caching);
                if (payload["tools"]?.AsArray().LastOrDefault() is JsonObject last) last["cache_control"] = Cache(resolution.Caching);
            }
        }
        return payload;
    }
    private static JsonObject Cache(AiCaching config) => new() { ["type"] = "ephemeral", ["ttl"] = config.Ttl };
}
