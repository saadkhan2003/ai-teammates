using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Teammates.Api;

public readonly record struct TokenUsage(int PromptTokens, int CompletionTokens, decimal CostUsd);

/// <summary>
/// OpenAI chat-completions wire shape. The worker keeps an internal transcript
/// (toolCalls, arguments as objects, toolCallId). Providers reject that shape.
/// </summary>
public static class ProviderWire
{
    public const int MaxTokens = 2048;

    public static Dictionary<string, object?> Completion(string model, JsonElement messages, object tools) =>
        new()
        {
            ["model"] = model,
            ["messages"] = ToOpenAi(messages),
            ["tools"] = tools,
            ["max_tokens"] = MaxTokens,
            ["usage"] = new Dictionary<string, object> { ["include"] = true }
        };

    public static JsonElement ToOpenAi(JsonElement messages)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartArray();
            foreach (var message in messages.EnumerateArray())
                WriteMessage(writer, message);
            writer.WriteEndArray();
        }
        return JsonDocument.Parse(stream.ToArray()).RootElement.Clone();
    }

    public static JsonElement Normalize(JsonElement message)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteString("role", "assistant");
            writer.WriteString("content", message.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.String ? content.GetString() : "");
            if (message.TryGetProperty("tool_calls", out var calls) && calls.ValueKind == JsonValueKind.Array)
            {
                writer.WritePropertyName("toolCalls");
                writer.WriteStartArray();
                foreach (var call in calls.EnumerateArray())
                {
                    var fn = call.GetProperty("function");
                    writer.WriteStartObject();
                    writer.WriteString("id", call.GetProperty("id").GetString());
                    writer.WriteString("name", fn.GetProperty("name").GetString());
                    var arguments = fn.GetProperty("arguments").GetString() ?? "{}";
                    writer.WritePropertyName("arguments");
                    using var parsed = JsonDocument.Parse(string.IsNullOrWhiteSpace(arguments) ? "{}" : arguments);
                    parsed.RootElement.WriteTo(writer);
                    writer.WriteEndObject();
                }
                writer.WriteEndArray();
            }
            writer.WriteEndObject();
        }
        return JsonDocument.Parse(stream.ToArray()).RootElement.Clone();
    }

    public static TokenUsage ReadUsage(JsonElement root)
    {
        if (!root.TryGetProperty("usage", out var usage) || usage.ValueKind != JsonValueKind.Object)
            return new TokenUsage(0, 0, 0);
        return new TokenUsage(Whole(usage, "prompt_tokens"), Whole(usage, "completion_tokens"), Money(usage));
    }

    /// <summary>The ask_user id from a stored assistant toolCalls array. Never invents call_1.</summary>
    public static string? AskToolCallId(string? toolCallsJson)
    {
        if (string.IsNullOrWhiteSpace(toolCallsJson)) return null;
        try
        {
            using var doc = JsonDocument.Parse(toolCallsJson);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return null;
            foreach (var call in doc.RootElement.EnumerateArray())
            {
                if (call.ValueKind != JsonValueKind.Object) continue;
                var name = Text(call, "name");
                if (name == null && call.TryGetProperty("function", out var fn) && fn.ValueKind == JsonValueKind.Object)
                    name = Text(fn, "name");
                if (name != "ask_user") continue;
                var id = Text(call, "id");
                if (!string.IsNullOrEmpty(id)) return id;
            }
        }
        catch (JsonException)
        {
            return null;
        }
        return null;
    }

    public static (bool Ok, int? Limit, string? Error) ReadKey(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
                return (false, null, "invalid");
            if (!data.TryGetProperty("limit_remaining", out var limit) || limit.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
                return (true, null, null);
            if (limit.ValueKind == JsonValueKind.Number)
            {
                if (limit.TryGetInt32(out var whole)) return (true, whole, null);
                return (true, (int)decimal.Truncate(limit.GetDecimal()), null);
            }
            if (limit.ValueKind == JsonValueKind.String && decimal.TryParse(limit.GetString(), NumberStyles.Number, CultureInfo.InvariantCulture, out var parsed))
                return (true, (int)decimal.Truncate(parsed), null);
            return (false, null, "invalid");
        }
        catch (JsonException)
        {
            return (false, null, "invalid");
        }
    }

    private static void WriteMessage(Utf8JsonWriter writer, JsonElement message)
    {
        var role = Text(message, "role") ?? "user";
        if (role == "tool")
        {
            writer.WriteStartObject();
            writer.WriteString("role", "tool");
            writer.WriteString("tool_call_id", ToolResultId(message));
            writer.WriteString("content", ContentText(message));
            writer.WriteEndObject();
            return;
        }
        if (role == "assistant")
        {
            var calls = CallsOf(message);
            writer.WriteStartObject();
            writer.WriteString("role", "assistant");
            var content = ContentText(message);
            if (calls.Count > 0 && content.Length == 0)
                writer.WriteNull("content");
            else
                writer.WriteString("content", content);
            if (calls.Count > 0)
            {
                writer.WritePropertyName("tool_calls");
                writer.WriteStartArray();
                foreach (var call in calls)
                {
                    writer.WriteStartObject();
                    writer.WriteString("id", call.Id);
                    writer.WriteString("type", "function");
                    writer.WritePropertyName("function");
                    writer.WriteStartObject();
                    writer.WriteString("name", call.Name);
                    writer.WriteString("arguments", call.ArgumentsJson);
                    writer.WriteEndObject();
                    writer.WriteEndObject();
                }
                writer.WriteEndArray();
            }
            writer.WriteEndObject();
            return;
        }
        message.WriteTo(writer);
    }

    private readonly record struct WireCall(string Id, string Name, string ArgumentsJson);

    private static List<WireCall> CallsOf(JsonElement message)
    {
        JsonElement calls = default;
        var found = message.TryGetProperty("toolCalls", out calls) && calls.ValueKind == JsonValueKind.Array;
        if (!found)
            found = message.TryGetProperty("tool_calls", out calls) && calls.ValueKind == JsonValueKind.Array;
        if (!found) return [];
        var list = new List<WireCall>();
        foreach (var call in calls.EnumerateArray())
        {
            if (call.ValueKind != JsonValueKind.Object) continue;
            var id = Text(call, "id");
            if (string.IsNullOrEmpty(id)) continue;
            string name;
            JsonElement arguments = default;
            if (call.TryGetProperty("function", out var fn) && fn.ValueKind == JsonValueKind.Object)
            {
                name = Text(fn, "name") ?? "";
                if (fn.TryGetProperty("arguments", out var args)) arguments = args;
            }
            else
            {
                name = Text(call, "name") ?? "";
                if (call.TryGetProperty("arguments", out var args)) arguments = args;
            }
            list.Add(new WireCall(id, name, ArgumentsOf(arguments)));
        }
        return list;
    }

    private static string ArgumentsOf(JsonElement arguments)
    {
        if (arguments.ValueKind == JsonValueKind.String)
        {
            var text = arguments.GetString();
            if (string.IsNullOrWhiteSpace(text)) return "{}";
            try
            {
                using var parsed = JsonDocument.Parse(text);
                return Compact(parsed.RootElement);
            }
            catch (JsonException)
            {
                return text;
            }
        }
        if (arguments.ValueKind is JsonValueKind.Object or JsonValueKind.Array)
            return Compact(arguments);
        return "{}";
    }

    private static string Compact(JsonElement value)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
            value.WriteTo(writer);
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static string ToolResultId(JsonElement message)
    {
        var native = Text(message, "tool_call_id");
        var internalId = Text(message, "toolCallId");
        if (!string.IsNullOrEmpty(internalId) && (string.IsNullOrEmpty(native) || native == "call_1"))
            return internalId;
        return native ?? internalId ?? "";
    }

    private static string ContentText(JsonElement message)
    {
        if (!message.TryGetProperty("content", out var content) || content.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            return "";
        return content.ValueKind == JsonValueKind.String ? content.GetString() ?? "" : content.GetRawText();
    }

    private static string? Text(JsonElement obj, string name) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static int Whole(JsonElement obj, string name)
    {
        if (!obj.TryGetProperty(name, out var value)) return 0;
        if (value.ValueKind == JsonValueKind.Number)
        {
            if (value.TryGetInt32(out var whole)) return whole;
            return (int)decimal.Truncate(value.GetDecimal());
        }
        if (value.ValueKind == JsonValueKind.String && int.TryParse(value.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
            return parsed;
        return 0;
    }

    private static decimal Money(JsonElement usage)
    {
        foreach (var name in new[] { "cost", "cost_usd" })
        {
            if (!usage.TryGetProperty(name, out var value) || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
                continue;
            if (value.ValueKind == JsonValueKind.Number) return value.GetDecimal();
            if (value.ValueKind == JsonValueKind.String && decimal.TryParse(value.GetString(), NumberStyles.Number, CultureInfo.InvariantCulture, out var parsed))
                return parsed;
        }
        return 0;
    }
}

public static class FileTools
{
    public const string StatProgram =
        "import pathlib,sys\n"
        + "p=pathlib.Path(sys.argv[1])\n"
        + "if p.is_dir():\n"
        + "    print('directory')\n"
        + "    raise SystemExit(3)\n"
        + "if p.exists():\n"
        + "    print('present')\n"
        + "    raise SystemExit(0)\n"
        + "print('absent')\n"
        + "raise SystemExit(2)\n";

    public const string ReadProgram =
        "import pathlib,sys\n"
        + "p=pathlib.Path(sys.argv[1])\n"
        + "if not p.is_file():\n"
        + "    print('not_found')\n"
        + "    raise SystemExit(2)\n"
        + "print(p.read_text()[:100000])\n";
}
