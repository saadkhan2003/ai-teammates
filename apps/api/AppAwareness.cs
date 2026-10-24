using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Dapper;
using Teammates.Compute;

namespace Teammates.Api;

public sealed class GuideSetting
{
    public string Id { get; set; } = "";
    public string Href { get; set; } = "";
    public string Label { get; set; } = "";
    public string Description { get; set; } = "";
}

public sealed class GuidePanel
{
    public string Id { get; set; } = "";
    public string Tab { get; set; } = "";
    public string Label { get; set; } = "";
    public string Description { get; set; } = "";
    public bool Alias { get; set; }
}

public static class AppGuide
{
    public const string Start = "[app-context]";
    public const string End = "[/app-context]";

    public static IReadOnlyList<GuideSetting> Settings { get; }
    public static IReadOnlyList<GuidePanel> Panels { get; }

    static AppGuide()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("app-guide.json")
            ?? throw new InvalidOperationException("app-guide.json is not embedded");
        var guide = JsonSerializer.Deserialize<GuideFile>(stream, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidOperationException("app-guide.json is empty");
        Settings = guide.Settings ?? [];
        Panels = guide.Panels ?? [];
    }

    public static string StyleText { get; } =
        "Reply in short, warm, plain language. Lead with the answer. "
        + "When the user asks where or how to do something in this app, answer with one link pill and do not describe a click-path. "
        + "Use app://settings?id=<anchor> or app://panel?tab=<tab>, and only anchors from the app map. "
        + "You may react to a user message with react_to_message and any single emoji. "
        + "A reaction can be the whole reply when text would be overkill, and it never replaces an answer, a result, or an error. "
        + "To quote a specific message, call reply_to_message with that message id, then write the reply.";

    public static string MapText()
    {
        var builder = new StringBuilder();
        builder.AppendLine("App map:");
        builder.AppendLine("Settings:");
        foreach (var setting in Settings)
            builder.Append("- ").Append(setting.Label).Append(": ").Append(setting.Description)
                .Append(" app://settings?id=").Append(setting.Id).AppendLine();
        builder.AppendLine("Side panel:");
        foreach (var panel in Panels)
        {
            if (panel.Alias) continue;
            builder.Append("- ").Append(panel.Label).Append(": ").Append(panel.Description)
                .Append(" app://panel?tab=").Append(panel.Id).AppendLine();
        }
        return builder.ToString().TrimEnd();
    }

    public static string Context(string state) => StyleText + "\n" + MapText() + "\n" + state;

    public static JsonElement Inject(JsonElement messages, string context)
    {
        var array = JsonNode.Parse(messages.GetRawText())?.AsArray() ?? new JsonArray();
        JsonObject? system = null;
        foreach (var node in array)
        {
            if (node is JsonObject obj && string.Equals(obj["role"]?.GetValue<string>(), "system", StringComparison.Ordinal))
            {
                system = obj;
                break;
            }
        }
        if (system == null)
        {
            system = new JsonObject { ["role"] = "system" };
            array.Insert(0, system);
        }
        var content = system["content"] is JsonValue value && value.TryGetValue<string>(out var text) ? text ?? "" : "";
        content = Block.Replace(content, "").Trim();
        var block = Start + "\n" + context.Trim() + "\n" + End;
        system["content"] = content.Length == 0 ? block : content + "\n\n" + block;
        using var doc = JsonDocument.Parse(array.ToJsonString());
        return doc.RootElement.Clone();
    }

    private static readonly Regex Block = new(Regex.Escape(Start) + @"[\s\S]*?" + Regex.Escape(End) + @"\s*", RegexOptions.Compiled);

    private sealed class GuideFile
    {
        public List<GuideSetting>? Settings { get; set; }
        public List<GuidePanel>? Panels { get; set; }
    }
}

public static partial class AppLinks
{
    public static string Sanitize(string? text)
    {
        if (string.IsNullOrEmpty(text)) return text ?? "";
        var builder = new StringBuilder(text.Length);
        var index = 0;
        while (index < text.Length)
        {
            var fence = text.IndexOf("```", index, StringComparison.Ordinal);
            var match = MarkdownLink().Match(text, index);
            var linkAt = match.Success ? match.Index : -1;
            if (fence >= 0 && (linkAt < 0 || fence < linkAt))
            {
                var close = text.IndexOf("```", fence + 3, StringComparison.Ordinal);
                var end = close < 0 ? text.Length : close + 3;
                builder.Append(text, index, end - index);
                index = end;
                continue;
            }
            if (linkAt < 0)
            {
                builder.Append(text, index, text.Length - index);
                break;
            }
            builder.Append(text, index, match.Index - index);
            builder.Append(IsAllowed(match.Groups[2].Value) ? match.Value : match.Groups[1].Value);
            index = match.Index + match.Length;
        }
        return builder.ToString();
    }

    public static bool IsAllowed(string href)
    {
        var raw = href.Trim();
        if (!raw.StartsWith("app://", StringComparison.OrdinalIgnoreCase)) raw = "app://" + raw;
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var uri) || !uri.Scheme.Equals("app", StringComparison.OrdinalIgnoreCase))
            return false;
        if (uri.Host.Equals("settings", StringComparison.OrdinalIgnoreCase))
        {
            var id = Query(uri, "id");
            return AppGuide.Settings.Any(setting => setting.Id.Equals(id, StringComparison.OrdinalIgnoreCase));
        }
        if (uri.Host.Equals("panel", StringComparison.OrdinalIgnoreCase))
        {
            var tab = Query(uri, "tab");
            return AppGuide.Panels.Any(panel => panel.Id.Equals(tab, StringComparison.OrdinalIgnoreCase));
        }
        return false;
    }

    private static string Query(Uri uri, string key)
    {
        foreach (var part in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var eq = part.IndexOf('=');
            if (eq <= 0) continue;
            if (!part[..eq].Equals(key, StringComparison.OrdinalIgnoreCase)) continue;
            return Uri.UnescapeDataString(part[(eq + 1)..]);
        }
        return "";
    }

    [GeneratedRegex(@"\[([^\]]+)\]\((app://[^)\s]+)\)", RegexOptions.IgnoreCase)]
    private static partial Regex MarkdownLink();
}

public static partial class BotAwareness
{
    public sealed record Snapshot(string WorkingOn, string Computer, IReadOnlyList<string> Connected, IReadOnlyList<string> Routines);

    public static string StateText(Snapshot snapshot)
    {
        var work = string.IsNullOrWhiteSpace(snapshot.WorkingOn) ? "nothing right now" : snapshot.WorkingOn;
        var connected = snapshot.Connected.Count == 0 ? "none" : string.Join(", ", snapshot.Connected);
        var routines = snapshot.Routines.Count == 0 ? "none" : string.Join("; ", snapshot.Routines);
        return "Your state this turn:\n"
            + "- Working on: " + work + "\n"
            + "- Computer: " + snapshot.Computer + "\n"
            + "- Connected: " + connected + "\n"
            + "- Routines: " + routines;
    }

    public static async Task<string> ForTurn(Platform platform, Guid botId, Guid taskId, CancellationToken ct)
    {
        try
        {
            return StateText(await Load(platform, botId, taskId, ct));
        }
        catch (Exception)
        {
            return StateText(new Snapshot("unknown", "asleep", [], []));
        }
    }

    public static async Task<object> AttachReply(Platform platform, Guid botId, Guid taskId, string messageId, CancellationToken ct)
    {
        if (!Guid.TryParse(messageId, out var id))
            return new { ok = false, reason = "message_not_found" };
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var owns = await conn.ExecuteScalarAsync<int>(
            """
            SELECT count(*) FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            JOIN tasks t ON t.conversation_id = c.id
            WHERE m.id = @message AND c.bot_id = @bot AND t.id = @task
            """,
            new { message = id, bot = botId, task = taskId });
        if (owns == 0) return new { ok = false, reason = "message_not_found" };
        var updated = await conn.ExecuteAsync(
            """
            UPDATE tasks
            SET checkpoint = jsonb_set(checkpoint, '{replyTo}', to_jsonb(@reply::text), true), updated_at = now()
            WHERE id = @task AND bot_id = @bot
            """,
            new { reply = id.ToString(), task = taskId, bot = botId });
        if (updated == 0) return new { ok = false, reason = "message_not_found" };
        return new { ok = true, replyTo = id };
    }

    private static async Task<Snapshot> Load(Platform platform, Guid botId, Guid taskId, CancellationToken ct)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var task = await conn.QuerySingleOrDefaultAsync<(string? Instruction, string? Kind)>(
            "SELECT instruction, kind FROM tasks WHERE id=@task AND bot_id=@bot",
            new { task = taskId, bot = botId });
        var owner = await conn.ExecuteScalarAsync<Guid>("SELECT owner_id FROM bots WHERE id=@bot", new { bot = botId });
        var computerId = await conn.ExecuteScalarAsync<Guid?>("SELECT computer_id FROM user_computers WHERE user_id=@owner", new { owner });
        var computer = "asleep";
        if (computerId != null)
        {
            try
            {
                var status = await platform.Compute.GetStatusAsync(new ComputerId(computerId.Value.ToString()), ct);
                computer = status.State switch
                {
                    ComputerState.Running or ComputerState.Idle => "awake",
                    ComputerState.Provisioning or ComputerState.Recreating or ComputerState.Restoring => "busy",
                    _ => "asleep"
                };
            }
            catch (ComputeException)
            {
                computer = "asleep";
            }
        }
        if (computer == "awake")
        {
            var others = await conn.ExecuteScalarAsync<int>(
                """
                SELECT count(*) FROM tasks
                WHERE bot_id=@bot AND id<>@task
                  AND status IN ('queued','planning','running','waiting_approval','waiting_human','waiting_resource','recovering')
                """,
                new { bot = botId, task = taskId });
            if (others > 0 || string.Equals(task.Kind, "work", StringComparison.Ordinal)) computer = "busy";
        }
        var connected = new List<string>();
        var openRouter = await conn.ExecuteScalarAsync<int>(
            "SELECT count(*) FROM secrets WHERE owner_user_id=@owner AND provider='openrouter' AND name='default' AND revoked_at IS NULL",
            new { owner });
        if (openRouter > 0) connected.Add("OpenRouter");
        var plugins = await conn.QueryAsync<string>(
            """
            SELECT DISTINCT p.name
            FROM plugins p
            JOIN plugin_bot_enable e ON e.plugin_id = p.id
            WHERE e.bot_id = @bot AND e.enabled
              AND (p.secret_id IS NOT NULL OR p.auth_type = 'none')
            ORDER BY p.name
            """,
            new { bot = botId });
        foreach (var name in plugins)
        {
            var clean = Clean(name, 80);
            if (clean.Length > 0) connected.Add(clean);
        }
        var routines = new List<string>();
        var rows = await conn.QueryAsync<(string Name, string Cron, bool Enabled)>(
            "SELECT name, cron, enabled FROM routines WHERE bot_id=@bot ORDER BY created_at",
            new { bot = botId });
        foreach (var row in rows)
        {
            var name = Clean(row.Name, 80);
            if (name.Length == 0) continue;
            routines.Add(name + " (" + Clean(row.Cron, 40) + ", " + (row.Enabled ? "on" : "off") + ")");
        }
        return new Snapshot(Clean(task.Instruction, 240), computer, connected, routines);
    }

    private static string Clean(string? value, int max)
    {
        if (string.IsNullOrWhiteSpace(value)) return "";
        var text = value.Replace(AppGuide.Start, " ", StringComparison.Ordinal)
            .Replace(AppGuide.End, " ", StringComparison.Ordinal)
            .Replace('\r', ' ')
            .Replace('\n', ' ');
        text = Whitespace().Replace(text, " ").Trim();
        if (text.Length <= max) return text;
        return text[..max].TrimEnd() + "…";
    }

    [GeneratedRegex(@"\s+")]
    private static partial Regex Whitespace();
}
