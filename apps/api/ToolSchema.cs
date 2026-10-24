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
        Fn("watch_video", "Analyze an attached, library, or workspace video. Use its library item id or a workspace path.", Opt("video_id", "string", "Video library item id"), Opt("source", "string", "File path under this bot's workspace")),
        Fn("ask_video", "Ask a follow-up about an analyzed library or workspace video", Req("question", "string", "Question about the video"), Opt("video_id", "string", "Video library item id"), Opt("source", "string", "File path under this bot's workspace"), Opt("around_ts", "number", "Focus on frames near this timestamp in seconds")),
        Fn("browser_click", "Click an element", Req("selector", "string", "CSS selector")),
        Fn("computer_screenshot", "Capture the desktop screen as task evidence"),
        Fn("computer_click", "Click at model-space desktop coordinates", Req("x", "number", "Horizontal coordinate from 0 to 1279"), Req("y", "number", "Vertical coordinate from 0 to 799"), Opt("button", "number", "Mouse button 1, 2, or 3")),
        Fn("computer_type", "Type text on the desktop", Req("text", "string", "Text to type")),
        Fn("computer_key", "Press up to 8 allowlisted desktop keys", Arr("keys", "Key names or combinations", true, "string", 1, 8)),
        Fn("computer_scroll", "Scroll at model-space desktop coordinates", Req("x", "number", "Horizontal coordinate from 0 to 1279"), Req("y", "number", "Vertical coordinate from 0 to 799"), Req("dy", "number", "Scroll steps from -20 to 20, excluding zero")),
        Fn("record_start", "Start a desktop recording, up to 600 seconds", Opt("name", "string", "Recording name"), Opt("maxSeconds", "number", "Maximum duration, 1 to 600 seconds")),
        Fn("record_stop", "Stop the desktop recording and save it as evidence"),
        Fn("write_file", "Write a workspace file", Req("path", "string", "Path"), Req("content", "string", "Contents")),
        Fn("read_file", "Read a workspace file", Req("path", "string", "Path")),
        Fn("edit_file", "Replace text in a file", Req("path", "string", "Path"), Req("search", "string", "Text to find"), Req("replace", "string", "Replacement")),
        Fn("delete_file", "Delete a file", Req("path", "string", "Path")),
        Fn("plan_set", "Set the task checklist", Arr("items", "Checklist titles", true, "string", 1, 20)),
        Fn("plan_update", "Update a checklist item by its one-based index", Req("index", "string", "One-based item number"), Enum("status", "pending, in_progress, done, or blocked", true, "pending", "in_progress", "done", "blocked")),
        Fn("git_status", "Show concise git status", Opt("repo", "string", "Repository path under workspace")),
        Fn("git_diff", "Show diff stats and up to 400 lines", Opt("repo", "string", "Repository path under workspace")),
        Fn("git_commit", "Commit workspace changes. Does not bypass hooks.", Req("message", "string", "Commit message"), Opt("repo", "string", "Repository path under workspace")),
        Fn("run_tests", "Run tests with a supported runner", Enum("runner", "Test runner", true, "auto", "npm", "pytest", "dotnet", "make"), Opt("args", "string", "Arguments without shell metacharacters"), Opt("repo", "string", "Repository path under workspace")),
        Fn("create_pr", "Ask first, then create a pull request. Use watch_ci to inspect checks.", Req("title", "string", "Title"), Req("body", "string", "Description"), Opt("base", "string", "Base branch"), Opt("repo", "string", "Repository path under workspace")),
        Fn("watch_ci", "Read current pull request CI checks", Opt("pr", "string", "Pull request number or URL")),
        Fn("spawn_child_task", "Create an isolated child worktree. Nothing is merged automatically; merge with git merge task/<id>.", Req("title", "string", "Short title"), Req("instruction", "string", "Child task"), Opt("repo", "string", "Repository path"), Opt("branch", "string", "Branch name")),
        Fn("child_status", "Read a child task status", Req("task_id", "string", "Child task id")),
        Fn("shell", "Run a shell command", Req("command", "string", "Command")),
        Fn("setup_env", "Run a command with a secret in the environment", Req("secret_ref", "string", "secret:// reference"), Req("env_name", "string", "Env var"), Req("command", "string", "Command")),
        Fn("type_secret", "Type a stored secret into a password field", Req("secret_ref", "string", "secret:// reference"), Opt("selector", "string", "CSS selector"), Req("url", "string", "Page URL")),
        Fn("ask_user", "Ask the user to choose. Use this instead of asking in plain text. 1 to 6 options. style danger for a destructive option.",
            Req("prompt", "string", "Short question"),
            Arr("options", "Option labels", true, "string", 1, 6),
            Arr("styles", "primary or danger, one per option", false, "string", null, null, ["primary", "danger"]),
            Opt("multiple", "boolean", "Allow more than one"),
            Opt("allow_custom", "boolean", "Allow a typed answer")),
        Fn("save_memory", "Remember a fact", Req("content", "string", "Fact"), Opt("kind", "string", "profile, journal, rule or fact"), Opt("scope", "string", "For a rule only: channel:email, channel:slack, channel:chat, or connector:<id>. Omit for a global rule."), Opt("memory_scope", "string", "agent or conversation"), Opt("visibility", "string", "bot or owner"), Opt("sensitivity", "string", "Whether the note is sensitive")),
        Fn("update_memory", "Correct a saved fact by writing a new version", Req("id", "string", "Memory id"), Req("content", "string", "Corrected fact")),
        Fn("forget_memory", "Forget a saved fact by id, query, or exact content", Opt("id", "string", "Memory id"), Opt("query", "string", "Search query"), Opt("content", "string", "Exact legacy content")),
        Fn("search_memory", "Search memory", Req("query", "string", "Query"), Opt("limit", "number", "1 to 20 results"), Opt("kind", "string", "Optional note kind")),
        Fn("load_skill", "Load a skill guide by name", Req("name", "string", "Skill name")),
        Fn("write_skill", "Create or update a bot-authored guide skill", Req("name", "string", "Slug"), Req("title", "string", "Title"), Req("when_to_use", "string", "One-line use case"), Req("body", "string", "Markdown body")),
        Fn("save_artifact", "Save a workspace file as an artifact", Req("name", "string", "File name"), Req("path", "string", "Path")),
        Fn("react_to_message", "React to a user message with one emoji. 👍 thanks or agreement, ❤️ appreciation, 🎉 good news, 😂 funny, ✅ a small visible request that is already done. Same emoji removes it. A reaction can be the whole reply when text would be overkill, and never replaces an answer, result, or error.",
            Req("message_id", "string", "User message id"),
            Enum("emoji", "One emoji", true, "👍", "❤️", "🎉", "😂", "✅")),
        Fn("request_login", "Ask the user to fill a login form. Do not ask for the password in chat. Pass the page domain and the field selectors only.",
            Req("domain", "string", "Hostname of the login page"),
            Req("url", "string", "Absolute page URL"),
            Arr("fields", "Field kinds and selectors", true, "object", 1, null),
            Opt("submitSelector", "string", "Submit button selector")),
        Fn("send_message", "Send a message to a person", Req("to", "string", "Recipient"), Req("text", "string", "Message")),
        Fn("external_post", "Publish text outside the workspace", Req("url", "string", "Destination"), Req("text", "string", "Text")),
        Fn("list_bots", "List the other teammates you can message (id, name, role, bio, busy or idle). Never returns their instructions."),
        Fn("message_bot", "Send a message to another teammate of the same user. Returns at once with a thread id. The reply comes back to you as a new task. Pass thread_id to continue a thread. Keep the title short.",
            Req("bot", "string", "Teammate name or id"),
            Req("title", "string", "Short thread title, 3 to 60 characters"),
            Req("text", "string", "What you need, up to 4000 characters"),
            Opt("thread_id", "string", "Continue this thread")),
        Fn("reply_to_bot", "Send a mid-task update on the thread you were asked on. Your final answer is sent back automatically.",
            Req("thread_id", "string", "Thread id"),
            Req("text", "string", "Update text")),
        Fn("thread_status", "Check a thread: status, last reply and pending approvals.", Req("thread_id", "string", "Thread id")),
        Fn("create_bot", "Create a new teammate. The user is asked first.",
            Req("name", "string", "Teammate name"),
            Opt("role", "string", "Role"),
            Opt("instructions", "string", "Standing instructions"),
            Opt("bio", "string", "Short bio, up to 60 characters"),
            Opt("avatarShape", "string", "Avatar shape"),
            Opt("avatarColor", "string", "Avatar color")),
        Fn("update_bot", "Update a teammate profile. With only bio and no bot, it sets your own bio. Changing another teammate asks the user first.",
            Opt("bio", "string", "Short bio, up to 60 characters"),
            Opt("bot", "string", "Teammate name or id; omit for yourself"),
            Opt("name", "string", "New name"),
            Opt("role", "string", "New role"),
            Opt("instructions", "string", "New instructions"),
            Opt("avatarShape", "string", "Avatar shape"),
            Opt("avatarColor", "string", "Avatar color")),
        Fn("list_routines", "List routines of a teammate (default yourself).", Opt("bot", "string", "Teammate name or id")),
        Fn("create_routine", "Create a recurring routine (5-field cron) or a one-off reminder (run_at). The user is asked first." + " Times are the owner's local time (the zone is in the result of get_routine/list_routines); use 'now' from get_routine to work out dates. For a message the user should see in the morning use a weekday 8am-7pm window unless they said otherwise. Minimum interval 5 minutes.",
            Opt("bot", "string", "Teammate name or id; omit for yourself"),
            Req("name", "string", "Routine name, up to 80 characters"),
            Opt("cron", "string", "Five field cron in the routine's timezone, for recurring routines"),
            Opt("run_at", "string", "ISO time for a one-off reminder (local time if it has no offset)"),
            Opt("timezone", "string", "IANA zone; default is the owner's zone"),
            Opt("expires_at", "string", "ISO time after which a recurring routine stops"),
            Opt("quiet", "string", "Quiet rule: when nothing is worth saying, reply only NOTHING_NEW and the user is not notified"),
            Opt("exact", "boolean", "Skip the small start-time jitter"),
            Req("instruction", "string", "What to do on each run")),
        Fn("get_routine", "Read one routine with its saved text and recent runs. Required before update_routine.",
            Req("routine", "string", "Routine id or name"), Opt("bot", "string", "Owner teammate when using a name")),
        Fn("update_routine", "Change a routine. Read it with get_routine first and edit the saved text, do not rewrite from memory. The user is asked first." + " Times are the owner's local time (the zone is in the result of get_routine/list_routines); use 'now' from get_routine to work out dates. For a message the user should see in the morning use a weekday 8am-7pm window unless they said otherwise. Minimum interval 5 minutes.",
            Req("routine", "string", "Routine id or name"), Opt("bot", "string", "Owner teammate when using a name"),
            Opt("name", "string", "New name"), Opt("instruction", "string", "New instruction"), Opt("cron", "string", "New five field cron"),
            Opt("run_at", "string", "New one-off time"), Opt("timezone", "string", "New IANA zone"), Opt("expires_at", "string", "New expiry"),
            Opt("quiet", "string", "New quiet rule"), Opt("exact", "boolean", "Skip jitter")),
        Fn("pause_routine", "Pause a routine. No approval needed.", Req("routine", "string", "Routine id or name"), Opt("bot", "string", "Owner teammate when using a name")),
        Fn("resume_routine", "Resume a paused routine. The user is asked first.", Req("routine", "string", "Routine id or name"), Opt("bot", "string", "Owner teammate when using a name")),
        Fn("delete_routine", "Delete a routine for good. The user is asked first.", Req("routine", "string", "Routine id or name"), Opt("bot", "string", "Owner teammate when using a name")),
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
            if (field.Type == "number" && (value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var number) || !double.IsFinite(number)))
                return tool + " " + field.Name + " must be a finite number";
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
        if (tool is "computer_click" or "computer_scroll")
        {
            if (!args.TryGetProperty("x", out var x) || !x.TryGetDouble(out var xv) || xv < 0 || xv >= 1280) return tool + " x must be from 0 to 1279";
            if (!args.TryGetProperty("y", out var y) || !y.TryGetDouble(out var yv) || yv < 0 || yv >= 800) return tool + " y must be from 0 to 799";
        }
        if (tool is "watch_video" or "ask_video")
        {
            var hasVideoId = args.TryGetProperty("video_id", out var videoId) && videoId.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(videoId.GetString());
            var hasSource = args.TryGetProperty("source", out var source) && source.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(source.GetString());
            if (!hasVideoId && !hasSource) return tool + " requires video_id or source";
            if (!VideoTools.SafeSource(VideoTools.Source(args))) return tool + " requires a safe video source";
        }
        if (tool == "computer_click" && args.TryGetProperty("button", out var button) && (!button.TryGetInt32(out var buttonValue) || buttonValue is < 1 or > 3)) return "computer_click button must be 1, 2, or 3";
        if (tool == "computer_scroll" && (!args.TryGetProperty("dy", out var dy) || !dy.TryGetInt32(out var delta) || delta is < -20 or > 20 or 0)) return "computer_scroll dy must be from -20 to 20, excluding zero";
        if (tool == "record_start" && args.TryGetProperty("maxSeconds", out var seconds) && (!seconds.TryGetInt32(out var duration) || duration is < 1 or > 600)) return "record_start maxSeconds must be from 1 to 600";
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
