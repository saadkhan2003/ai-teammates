using System.Text.Json;
using System.Text.Json.Nodes;

namespace Teammates.Api;

public static class PromptOrder
{
    // Tool definitions are a separate wire field before messages. Catalog and memory are
    // immutable system blocks; live state is a fresh trailing user block, never persisted.
    public static JsonElement Build(JsonElement messages, object? liveState = null)
    {
        var stable = new JsonArray();
        var history = new JsonArray();
        foreach (var message in messages.EnumerateArray())
        {
            var target = message.GetProperty("role").GetString() == "system" ? stable : history;
            if (target == stable && message.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.String)
            {
                var text = content.GetString()!;
                var catalogAt = text.IndexOf("[skill-catalog]", StringComparison.Ordinal);
                if (catalogAt >= 0)
                {
                    var before = text[..catalogAt].TrimEnd();
                    var memoryAt = before.IndexOf("<<<BOT-OWNED CONTEXT", StringComparison.Ordinal);
                    stable.Add(new JsonObject { ["role"] = "system", ["content"] = memoryAt >= 0 ? before[..memoryAt].TrimEnd() : before });
                    stable.Add(new JsonObject { ["role"] = "system", ["content"] = text[catalogAt..] });
                    if (memoryAt >= 0) stable.Add(new JsonObject { ["role"] = "system", ["content"] = before[memoryAt..] });
                    continue;
                }
            }
            target.Add(JsonNode.Parse(message.GetRawText()));
        }
        foreach (var message in history) stable.Add(message!.DeepClone());
        if (liveState != null) stable.Add(new JsonObject { ["role"] = "user", ["content"] = "[live-state]\n" + JsonSerializer.Serialize(liveState) });
        return JsonSerializer.SerializeToElement(stable);
    }
}
