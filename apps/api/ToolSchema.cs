using System.Text.Json;

namespace Teammates.Api;

public static class ToolSchema
{
    public readonly record struct Field(string Name, string Type, string Description, bool Required = false, string? Items = null, int? MinItems = null, int? MaxItems = null, string[]? Enum = null, string[]? ItemEnum = null);

    public static object[] ForModel() =>
        Builtins()
            .Select(Strip)
            .Where(tool =>
            {
                var name = ((Dictionary<string, object>)((Dictionary<string, object>)tool)["function"])["name"] as string;
                return name is not ("search_tools" or "load_tool");
            })
            .ToArray();

    public static object[] Builtins() =>
    [
        Fn("browser_open", "Open a URL in the bot browser", Req("url", "string", "Absolute URL"), Opt("wait", "string", "CSS selector to wait for")),
        Fn("browser_extract", "Read text from the current page", Opt("selector", "string", "CSS selector")),
        Fn("browser_click", "Click an element", Req("selector", "string", "CSS selector")),
        Fn("write_file", "Write a workspace file", Req("path", "string", "Path"), Req("content", "string", "Contents")),
        Fn("read_file", "Read a workspace file", Req("path", "string", "Path")),
        Fn("edit_file", "Replace text in a file", Req("path", "string", "Path"), Req("search", "string", "Text to find"), Req("replace", "string", "Replacement")),
        Fn("delete_file", "Delete a file", Req("path", "string", "Path")),
        Fn("shell", "Run a shell command", Req("command", "string", "Command")),
        Fn("setup_env", "Run a command with a secret in the environment", Req("secret_ref", "string", "secret:// reference"), Req("env_name", "string", "Env var"), Req("command", "string", "Command")),
        Fn("type_secret", "Type a stored secret into a password field", Req("secret_ref", "string", "secret:// reference"), Opt("selector", "string", "CSS selector"), Req("url", "string", "Page URL")),
        Fn("ask_user", "Ask the user to choose. Use this instead of asking in plain text. 1 to 6 options. style danger for a destructive option.",
            Req("prompt", "string", "Short question"),
            Arr("options", "Option labels", true, "string", 1, 6),
            Arr("styles", "primary or danger, one per option", false, "string", null, null, ["primary", "danger"]),
            Opt("multiple", "boolean", "Allow more than one"),
            Opt("allow_custom", "boolean", "Allow a typed answer")),
        Fn("save_memory", "Remember a fact", Req("content", "string", "Fact")),
        Fn("forget_memory", "Forget a saved fact", Req("content", "string", "Fact to remove")),
        Fn("search_memory", "Search memory", Req("query", "string", "Query")),
        Fn("save_artifact", "Save a workspace file as an artifact", Req("name", "string", "File name"), Req("path", "string", "Path")),
        Fn("report_coding_job", "Report a coding job the user can watch. Send the same title again to update it. status is queued, running, tests, finished, merged, or failed. step is the short live line, such as Running test suites.",
            Req("title", "string", "Job title"),
            Enum("status", "queued, running, tests, finished, merged, or failed", true, "queued", "running", "tests", "finished", "merged", "failed"),
            Opt("step", "string", "Short live status line"),
            Opt("pr_number", "string", "Pull request number"),
            Opt("pr_url", "string", "Pull request URL"),
            Opt("branch", "string", "Git branch name"),
            Opt("files_changed", "string", "Number of files changed"),
            Opt("additions", "string", "Lines added"),
            Opt("deletions", "string", "Lines deleted"),
            Opt("job_id", "string", "Existing job id")),
        Fn("react_to_message", "React to a user message with any single emoji. 👍 thanks or agreement, ❤️ appreciation, 🎉 good news, 😂 funny, ✅ a small visible request that is already done, or any other single emoji that fits. Same emoji removes it. A reaction can be the whole reply when text would be overkill, and never replaces an answer, result, or error.",
            Req("message_id", "string", "User message id"),
            Req("emoji", "string", "One emoji")),
        Fn("reply_to_message", "Quote a specific message in this reply. Call it, then write the reply. The assistant message stores reply_to as that message id.",
            Req("message_id", "string", "Message id to quote")),
        Fn("request_login", "Ask the user to fill a login form. Do not ask for the password in chat. Pass the page domain and the field selectors only.",
            Req("domain", "string", "Hostname of the login page"),
            Req("url", "string", "Absolute page URL"),
            Arr("fields", "Field kinds and selectors", true, "object", 1, null),
            Opt("submitSelector", "string", "Submit button selector")),
        Fn("send_message", "Send a message to a person", Req("to", "string", "Recipient"), Req("text", "string", "Message")),
        Fn("external_post", "Publish text outside the workspace", Req("url", "string", "Destination"), Req("text", "string", "Text")),
        Fn("search_tools", "Search the plugin tool index.", Req("query", "string", "Words to match")),
        Fn("load_tool", "Load the full JSON schema for one plugin tool from the index.", Req("name", "string", "Tool name from the index"))
    ];

    public static string? Validate(string tool, JsonElement args)
    {
        if (!Specs.TryGetValue(tool, out var fields)) return null;
        if (args.ValueKind != JsonValueKind.Object) return tool + " arguments must be an object";
        foreach (var field in fields)
        {
            var present = args.TryGetProperty(field.Name, out var value) && value.ValueKind is not JsonValueKind.Null and not JsonValueKind.Undefined;
            if (tool == "ask_user" && field.Name == "prompt" && !present) continue;
            if (field.Required && !present) return tool + " requires " + field.Name;
            if (!present) continue;
            if (field.Type == "string")
            {
                if (value.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(value.GetString()))
                    return tool + " " + field.Name + " must be a non-empty string";
                if (field.Enum is { Length: > 0 } && tool != "react_to_message" && !field.Enum.Contains(value.GetString()))
                    return tool + " " + field.Name + " must be one of " + string.Join(", ", field.Enum);
            }
            else if (field.Type == "array")
            {
                if (value.ValueKind != JsonValueKind.Array) return tool + " " + field.Name + " must be an array";
                var count = value.GetArrayLength();
                if (field.MinItems is int min && count < min) return tool + " " + field.Name + " needs at least " + min + " item" + (min == 1 ? "" : "s");
                if (field.MaxItems is int max && count > max) return tool + " " + field.Name + " allows at most " + max + " items";
                if (field.Items == "string")
                {
                    foreach (var item in value.EnumerateArray())
                    {
                        if (item.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(item.GetString()))
                            return tool + " " + field.Name + " items must be non-empty strings";
                        if (field.ItemEnum is { Length: > 0 } && !field.ItemEnum.Contains(item.GetString()))
                            return tool + " " + field.Name + " items must be one of " + string.Join(", ", field.ItemEnum);
                    }
                }
            }
        }
        if (tool == "ask_user")
        {
            var prompt = args.TryGetProperty("prompt", out var promptEl) && promptEl.ValueKind == JsonValueKind.String ? promptEl.GetString() ?? "" : "";
            if (prompt.Trim().Length == 0 && args.TryGetProperty("question", out var question) && question.ValueKind == JsonValueKind.String)
                prompt = question.GetString() ?? "";
            if (prompt.Trim().Length == 0) return "ask_user requires prompt";
        }
        return null;
    }

    private static readonly Dictionary<string, Field[]> Specs = BuildSpecs();

    private static Dictionary<string, Field[]> BuildSpecs()
    {
        var map = new Dictionary<string, Field[]>(StringComparer.Ordinal);
        foreach (var tool in Builtins())
        {
            if (tool is not Dictionary<string, object> root) continue;
            if (root["function"] is not Dictionary<string, object> function) continue;
            var name = (string)function["name"];
            map[name] = (Field[])function["x-fields"];
        }
        return map;
    }

    private static object Fn(string name, string description, params Field[] fields)
    {
        var properties = new Dictionary<string, object>();
        var required = new List<string>();
        foreach (var field in fields)
        {
            properties[field.Name] = Schema(field);
            if (field.Required) required.Add(field.Name);
        }
        var parameters = new Dictionary<string, object> { ["type"] = "object", ["properties"] = properties };
        if (required.Count > 0) parameters["required"] = required;
        return new Dictionary<string, object>
        {
            ["type"] = "function",
            ["function"] = new Dictionary<string, object>
            {
                ["name"] = name,
                ["description"] = description,
                ["parameters"] = parameters,
                ["x-fields"] = fields
            }
        };
    }

    private static Dictionary<string, object> Schema(Field field)
    {
        var schema = new Dictionary<string, object> { ["type"] = field.Type, ["description"] = field.Description };
        if (field.Enum is { Length: > 0 }) schema["enum"] = field.Enum;
        if (field.Type == "array")
        {
            var items = new Dictionary<string, object> { ["type"] = field.Items ?? "string" };
            if (field.ItemEnum is { Length: > 0 }) items["enum"] = field.ItemEnum;
            schema["items"] = items;
            if (field.MinItems is int min) schema["minItems"] = min;
            if (field.MaxItems is int max) schema["maxItems"] = max;
        }
        return schema;
    }

    private static object Strip(object tool)
    {
        var root = (Dictionary<string, object>)tool;
        var function = new Dictionary<string, object>((Dictionary<string, object>)root["function"]);
        function.Remove("x-fields");
        return new Dictionary<string, object> { ["type"] = "function", ["function"] = function };
    }

    private static Field Req(string name, string type, string description) => new(name, type, description, true);
    private static Field Opt(string name, string type, string description) => new(name, type, description, false);
    private static Field Enum(string name, string description, bool required, params string[] values) => new(name, "string", description, required, Enum: values);
    private static Field Arr(string name, string description, bool required, string items, int? min, int? max, string[]? itemEnum = null) =>
        new(name, "array", description, required, items, min, max, ItemEnum: itemEnum);
}
