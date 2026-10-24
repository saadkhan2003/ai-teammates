using System.Text.Json;
using System.Text.Json.Nodes;
namespace Teammates.Api;

public static class PromptCaching
{
    public static JsonElement Messages(JsonElement messages, AiCaching caching, string kind)
    {
        if (!caching.Enabled || !caching.AnthropicCacheControl || kind != "openrouter") return messages;
        var rows=JsonNode.Parse(messages.GetRawText())!.AsArray();
        var systems=rows.OfType<JsonObject>().Where(m=>m["role"]?.ToString()=="system").ToArray();
        foreach(var block in new[]{systems.FirstOrDefault(),systems.LastOrDefault()}.Distinct())
        {
            if(block?["content"] is JsonValue content && content.TryGetValue<string>(out var text))
                block["content"]=new JsonArray(new JsonObject{["type"]="text",["text"]=text,["cache_control"]=new JsonObject{["type"]="ephemeral",["ttl"]=caching.Ttl}});
        }
        return JsonSerializer.SerializeToElement(rows);
    }
    // Read the resolved role's serialized config to remain additive with the
    // concurrently extended control plane (older configs have no cap).
    public static int? MaxTokens(AiResolution resolution, string role)
    {
        role=role is "planner" ? "chat" : role is "compactor" ? "quick" : role;
        var selected=resolution.Config.Roles.GetValueOrDefault(role) ?? resolution.Config.Roles["chat"];
        var node=JsonSerializer.SerializeToElement(selected,AiModelRegistry.Json);
        return node.TryGetProperty("max_tokens",out var cap) && cap.TryGetInt32(out var value) && value>0 ? value : null;
    }
}
