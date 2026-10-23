using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Dapper;
using Npgsql;

namespace Teammates.Api;

public readonly record struct ToolLine(string Name, string Description, string Label);

/// <summary>Compact tool index. Full schemas stay behind load_tool.</summary>
public static class ToolIndex
{
    public const int SearchLimit = 8;
    public const int IndexBudget = 1800;

    public static string Compact(IReadOnlyList<ToolLine> tools, int total, int budget = IndexBudget)
    {
        var builder = new StringBuilder();
        var shown = 0;
        foreach (var tool in tools)
        {
            var line = tool.Name + " (" + (tool.Label.Length == 0 ? "write" : tool.Label) + ") " + Trim(tool.Description, 80);
            if (builder.Length + line.Length + 1 > budget) break;
            if (builder.Length > 0) builder.Append('\n');
            builder.Append(line);
            shown++;
        }
        var extra = Math.Max(0, total - shown);
        if (extra > 0)
        {
            if (builder.Length > 0) builder.Append('\n');
            builder.Append(extra.ToString(CultureInfo.InvariantCulture));
            builder.Append(" more. search_tools to find them.");
        }
        return builder.ToString();
    }

    public static IReadOnlyList<ToolLine> Search(IReadOnlyList<ToolLine> tools, string? query, int limit = SearchLimit)
    {
        var needle = (query ?? "").Trim();
        var hits = new List<ToolLine>();
        foreach (var tool in tools)
        {
            if (needle.Length == 0
                || tool.Name.Contains(needle, StringComparison.OrdinalIgnoreCase)
                || tool.Description.Contains(needle, StringComparison.OrdinalIgnoreCase))
                hits.Add(tool);
            if (hits.Count >= limit) break;
        }
        return hits;
    }

    public static Dictionary<string, object> Schema(string name, string description, string method, string path)
    {
        var properties = new Dictionary<string, object>();
        foreach (Match match in Regex.Matches(path ?? "", "\\{([A-Za-z0-9_]+)\\}"))
            properties[match.Groups[1].Value] = new Dictionary<string, string> { ["type"] = "string", ["description"] = "Path value" };
        var verb = (method ?? "").ToUpperInvariant();
        if (verb is "" or "POST" or "PUT" or "PATCH")
            properties["body"] = new Dictionary<string, string> { ["type"] = "object", ["description"] = "JSON body" };
        return new Dictionary<string, object>
        {
            ["type"] = "function",
            ["function"] = new Dictionary<string, object>
            {
                ["name"] = name,
                ["description"] = string.IsNullOrWhiteSpace(description) ? name : description,
                ["parameters"] = new Dictionary<string, object> { ["type"] = "object", ["properties"] = properties }
            }
        };
    }

    private static string Trim(string text, int max)
    {
        var value = (text ?? "").Replace('\n', ' ').Trim();
        return value.Length <= max ? value : value[..max];
    }
}

public static class PluginRiskLabels
{
    public const string Read = "read";
    public const string Write = "write";
    public const string Send = "send";
    public const string Money = "money";
    public const string Destructive = "destructive";

    public static string FromAction(string actionClass) => actionClass switch
    {
        ActionClasses.Read => Read,
        ActionClasses.SendMessage or ActionClasses.ExternalPost => Send,
        ActionClasses.Payment => Money,
        ActionClasses.Delete => Destructive,
        _ => Write
    };

    public static string ToAction(string? label) => (label ?? "").Trim().ToLowerInvariant() switch
    {
        Read => ActionClasses.Read,
        Write => ActionClasses.Write,
        Send => ActionClasses.SendMessage,
        Money => ActionClasses.Payment,
        Destructive => ActionClasses.Delete,
        _ => ""
    };

    /// <summary>A stored label can tighten the gate. It cannot turn a payment into a read.</summary>
    public static string Apply(string actionClass, string? label)
    {
        var mapped = ToAction(label);
        if (mapped.Length == 0) return actionClass;
        return Rank(mapped) > Rank(actionClass) ? mapped : actionClass;
    }

    private static int Rank(string action) => action switch
    {
        ActionClasses.Read => 0,
        ActionClasses.Write => 1,
        _ => 2
    };
}

public static class PluginHealth
{
    public static bool VisibleToBots(string? checkStatus, string? healthStatus, bool blocked) =>
        !blocked && !string.Equals(checkStatus, "failed", StringComparison.Ordinal) && !string.Equals(healthStatus, "unhealthy", StringComparison.Ordinal);
}

public static class CatalogSchedule
{
    public const int DefaultMinutes = 1440;
    public const int ScheduledPages = 1;

    public static int ImportIntervalMinutes(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return DefaultMinutes;
        if (!int.TryParse(raw.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var minutes) || minutes < 0)
            return DefaultMinutes;
        return minutes;
    }
}

public static class RoutineWatch
{
    public static bool Changed(string? previous, string? next)
    {
        if (string.IsNullOrEmpty(next)) return false;
        return !string.Equals(previous ?? "", next, StringComparison.Ordinal);
    }

    public static string Fingerprint(string material)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(material ?? ""));
        return Convert.ToHexString(hash).ToLowerInvariant();
    }
}

public static class OutboundLog
{
    public static bool Tracks(string tool, string actionClass)
    {
        if (tool is "send_message" or "external_post" or "delete_file") return true;
        if (actionClass == ActionClasses.Payment) return true;
        if (PluginIds.IsPluginTool(tool) && actionClass is ActionClasses.Write or ActionClasses.Delete or ActionClasses.SendMessage or ActionClasses.ExternalPost or ActionClasses.Payment)
            return true;
        return false;
    }

    public static string Kind(string tool, string actionClass)
    {
        if (tool == "delete_file") return "delete";
        if (tool == "send_message" || actionClass == ActionClasses.SendMessage) return "send";
        if (tool == "external_post" || actionClass == ActionClasses.ExternalPost) return "post";
        if (actionClass == ActionClasses.Payment) return "purchase";
        return "plugin_write";
    }

    public static string Key(Guid? taskId, string tool, string canonicalArgs)
    {
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(tool + "\n" + canonicalArgs))).ToLowerInvariant();
        var scope = taskId.HasValue ? taskId.Value.ToString("N") : "direct";
        return scope + ":" + hash;
    }

    public static string Decide(string? status) => status switch
    {
        null or "" => "execute",
        "completed" => "replay",
        _ => "skip"
    };

    public static async Task<(string Action, string? ResultJson, string? Status)> Begin(NpgsqlConnection conn, Guid? owner, Guid? botId, Guid? taskId, string tool, string actionClass, string requestJson, CancellationToken ct = default)
    {
        var key = Key(taskId, tool, requestJson);
        var kind = Kind(tool, actionClass);
        var inserted = await conn.ExecuteScalarAsync<Guid?>(
            """
            INSERT INTO outbound_actions (idempotency_key, owner_user_id, bot_id, task_id, kind, tool, status, request)
            VALUES (@key, @owner, @bot, @task, @kind, @tool, 'pending', CAST(@request AS jsonb))
            ON CONFLICT (idempotency_key) DO UPDATE SET status='pending', finished_at=NULL, retry_attempts=outbound_actions.retry_attempts+1,
                request=outbound_actions.request - 'retry_safe'
            WHERE outbound_actions.status='failed' AND outbound_actions.request->>'retry_safe'='true' AND outbound_actions.retry_attempts<4
            RETURNING id
            """,
            new { key, owner, bot = botId, task = taskId, kind, tool, request = requestJson });
        if (inserted != null) return ("execute", null, "pending");
        var row = await conn.QuerySingleAsync<(string Status, string? Result)>(
            "SELECT status, result::text FROM outbound_actions WHERE idempotency_key=@key",
            new { key });
        var decision = Decide(row.Status);
        return decision == "execute" ? ("skip", null, row.Status) : (decision, row.Result, row.Status);
    }

    public static async Task<bool> TryClaim(NpgsqlConnection conn, string key, string? seenClaim, string stamp, CancellationToken ct = default)
    {
        var n = await conn.ExecuteAsync(
            """
            UPDATE outbound_actions
            SET request = jsonb_set(COALESCE(request, '{}'::jsonb), '{claim}', to_jsonb(@stamp::text), true)
            WHERE idempotency_key=@key AND status IN ('pending','failed')
              AND request->>'claim' IS NOT DISTINCT FROM @seen
            """,
            new { key, stamp, seen = seenClaim });
        return n == 1;
    }

    public static async Task<(string Status, string? Claim)> ReadClaim(NpgsqlConnection conn, string key)
    {
        var rows = (await conn.QueryAsync<(string Status, string? Claim)>(
            "SELECT status, request->>'claim' FROM outbound_actions WHERE idempotency_key=@key",
            new { key })).ToList();
        return rows.Count == 0 ? ("", null) : rows[0];
    }

    public static async Task ReleaseClaim(NpgsqlConnection conn, string key, string stamp)
    {
        await conn.ExecuteAsync(
            "UPDATE outbound_actions SET request = request - 'claim' WHERE idempotency_key=@key AND status='pending' AND request->>'claim'=@stamp",
            new { key, stamp });
    }

    public static async Task FinishKey(NpgsqlConnection conn, string key, string resultJson)
    {
        await conn.ExecuteAsync(
            """
            UPDATE outbound_actions
            SET status='completed', result=CAST(@result AS jsonb), finished_at=now()
            WHERE idempotency_key=@key AND status IN ('pending','failed')
            """,
            new { key, result = resultJson });
    }

    public static async Task FailKey(NpgsqlConnection conn, string key)
    {
        await conn.ExecuteAsync(
            "UPDATE outbound_actions SET status='failed', finished_at=now() WHERE idempotency_key=@key AND status IN ('pending','failed')",
            new { key });
    }

    public static async Task Surface(NpgsqlConnection conn, string key)
    {
        await conn.ExecuteAsync(
            """
            UPDATE outbound_actions
            SET status='failed', finished_at=COALESCE(finished_at, now()),
                request = jsonb_set(COALESCE(request, '{}'::jsonb), '{surfaced}', 'true'::jsonb, true)
            WHERE idempotency_key=@key AND status IN ('pending','failed')
            """,
            new { key });
    }

    public static async Task Finish(NpgsqlConnection conn, Guid? taskId, string tool, string requestJson, string resultJson)
    {
        var key = Key(taskId, tool, requestJson);
        await conn.ExecuteAsync(
            """
            UPDATE outbound_actions
            SET status='completed', result=CAST(@result AS jsonb), finished_at=now()
            WHERE idempotency_key=@key AND status='pending'
            """,
            new { key, result = resultJson });
    }

    public static async Task<object> Run(Platform platform, Guid owner, Guid botId, Guid? taskId, string tool, string actionClass, JsonElement args, Func<Task<object>> execute, CancellationToken ct = default)
    {
        if (!Tracks(tool, actionClass)) return await execute();
        var request = args.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null ? "{}" : Dlp.Redact(args.GetRawText());
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var begun = await Begin(conn, owner, botId, taskId, tool, actionClass, request, ct);
        if (begun.Action == "replay")
        {
            JsonElement output = default;
            if (!string.IsNullOrEmpty(begun.ResultJson))
            {
                using var doc = JsonDocument.Parse(begun.ResultJson);
                output = doc.RootElement.Clone();
            }
            return new { replayed = true, output };
        }
        if (begun.Action != "execute") return new { replayed = true, status = "already_sent" };
        try
        {
            var output = await execute();
            var outputJson = JsonSerializer.Serialize(output);
            using var parsed = JsonDocument.Parse(outputJson);
            var result = parsed.RootElement;
            if (RetryContract.CanRetry(result))
            {
                await conn.ExecuteAsync("UPDATE outbound_actions SET status='failed',request=jsonb_set(request,'{retry_safe}','true'::jsonb),result=CAST(@outputJson AS jsonb),finished_at=now() WHERE idempotency_key=@key AND status='pending'", new { key = Key(taskId, tool, request), outputJson });
            }
            else await Finish(conn, taskId, tool, request, outputJson);
            return output;
        }
        catch
        {
            await Fail(conn, taskId, tool, request);
            throw;
        }
    }

    public static async Task Fail(NpgsqlConnection conn, Guid? taskId, string tool, string requestJson)
    {
        var key = Key(taskId, tool, requestJson);
        await conn.ExecuteAsync(
            "UPDATE outbound_actions SET status='failed', finished_at=now() WHERE idempotency_key=@key AND status='pending'",
            new { key });
    }
}

public static class OutboundRecovery
{
    public const long ClaimTtlSeconds = 20;

    public static string Plan(string disk, bool claimed)
    {
        if (disk == "directory") return "mark";
        if (disk == "absent") return "complete";
        if (disk == "present" && claimed) return "unlink";
        return "leave";
    }

    /// <summary>
    /// happened: the effect is already recorded. missing: it is safe to perform once.
    /// unknown: do not perform it again.
    /// </summary>
    public static string PlanAction(string kind, string evidence)
    {
        if (kind == "delete")
        {
            return evidence switch
            {
                "present" => "unlink",
                "absent" or "happened" => "complete",
                "directory" => "mark",
                _ => "leave"
            };
        }
        if (evidence == "happened") return "complete";
        if (kind is "send" or "post")
            return evidence == "missing" ? "retry" : "mark";
        return "mark";
    }

    public static string? TextOf(string? requestJson, string field)
    {
        if (string.IsNullOrWhiteSpace(requestJson)) return null;
        try
        {
            using var doc = JsonDocument.Parse(requestJson);
            if (doc.RootElement.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String)
            {
                var text = value.GetString();
                return string.IsNullOrWhiteSpace(text) ? null : text;
            }
        }
        catch (JsonException)
        {
            return null;
        }
        return null;
    }

    public static bool ClaimStale(string? claim, string bootId, long nowEpoch)
    {
        if (string.IsNullOrEmpty(claim)) return true;
        var split = claim.IndexOf(':');
        if (split <= 0 || split == claim.Length - 1) return true;
        if (!string.Equals(claim[..split], bootId, StringComparison.Ordinal)) return true;
        if (!long.TryParse(claim[(split + 1)..], out var stamped)) return true;
        return nowEpoch - stamped >= ClaimTtlSeconds;
    }

    public static string? PathOf(string? requestJson)
    {
        if (string.IsNullOrWhiteSpace(requestJson)) return null;
        try
        {
            using var doc = JsonDocument.Parse(requestJson);
            if (doc.RootElement.TryGetProperty("path", out var path) && path.ValueKind == JsonValueKind.String)
            {
                var text = path.GetString();
                return string.IsNullOrWhiteSpace(text) ? null : text;
            }
        }
        catch (JsonException)
        {
            return null;
        }
        return null;
    }
}

public static class StdioMcp
{
    private static readonly HashSet<string> Allowed = new(StringComparer.Ordinal) { "python3", "python", "node", "npx", "uv", "uvx" };
    private static string? _wrapper;

    public static string Wrapper
    {
        get
        {
            if (_wrapper != null) return _wrapper;
            using var stream = typeof(StdioMcp).Assembly.GetManifestResourceStream("stdio_wrap.py");
            if (stream == null) throw new InvalidOperationException("stdio wrapper missing");
            using var reader = new StreamReader(stream);
            _wrapper = reader.ReadToEnd();
            return _wrapper;
        }
    }

    public static (bool Ok, string Error, string[] Argv) Plan(IReadOnlyList<string> command, string rpc, string timeoutSeconds = "6")
    {
        if (command == null || command.Count == 0) return (false, "stdio_command_missing", []);
        if (command.Count > 12) return (false, "stdio_command_rejected", []);
        var exe = command[0];
        if (exe.Contains('/') || exe.Contains('\\') || !Allowed.Contains(exe))
            return (false, "stdio_command_rejected", []);
        foreach (var arg in command)
        {
            if (arg.Length == 0 || arg.Length > 400) return (false, "stdio_command_rejected", []);
            if (arg.Contains("..", StringComparison.Ordinal) || arg.Contains('\0') || arg.Contains('\n') || arg.Contains('\r'))
                return (false, "stdio_command_rejected", []);
            if (arg.Contains("docker.sock", StringComparison.OrdinalIgnoreCase)) return (false, "stdio_command_rejected", []);
            if (MentionsPrivateNetwork(arg)) return (false, "stdio_command_rejected", []);
        }
        var argv = new[] { "python3", "-c", Wrapper, JsonSerializer.Serialize(command), rpc, timeoutSeconds };
        return (true, "", argv);
    }

    public static bool MentionsPrivateNetwork(string text)
    {
        var value = text.ToLowerInvariant();
        if (value.Contains("localhost") || value.Contains(".internal") || value.Contains("metadata.google") || value.Contains("teammates-back"))
            return true;
        if (value.Contains("127.0.0.1") || value.Contains("169.254.") || value.Contains("10.") || value.Contains("192.168."))
            return true;
        return Regex.IsMatch(value, @"172\.(1[6-9]|2[0-9]|3[0-1])\.");
    }
}

public static class MockOauth
{
    public const string TokenUrl = "mock://oauth";
    private static readonly object Gate = new();
    private static readonly Dictionary<string, (string Redirect, string Token)> Codes = new();

    public static string Issue(string state, string redirect)
    {
        var code = "oa" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(state + "|" + redirect))).ToLowerInvariant()[..16];
        lock (Gate) Codes[code] = (redirect, "mock-access-token-" + code);
        return code;
    }

    public static string? Exchange(string code, string redirect)
    {
        lock (Gate)
        {
            if (!Codes.TryGetValue(code, out var row) || row.Redirect != redirect) return null;
            Codes.Remove(code);
            return row.Token;
        }
    }
}

public static class YamlJson
{
    public static bool TryConvert(string yaml, out string json)
    {
        json = "";
        try
        {
            var lines = new List<(int Indent, string Text)>();
            foreach (var raw in yaml.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n'))
            {
                if (raw.Length > 0 && raw[0] == '\t') return false;
                var trimmed = StripComment(raw).TrimEnd();
                if (trimmed.Trim().Length == 0) continue;
                var indent = trimmed.Length - trimmed.TrimStart(' ').Length;
                lines.Add((indent, trimmed.Trim()));
            }
            if (lines.Count == 0) return false;
            var parser = new Parser(lines);
            json = parser.Parse().ToJsonString();
            return json.Length > 0 && json[0] is '{' or '[';
        }
        catch (Exception)
        {
            json = "";
            return false;
        }
    }

    private static string StripComment(string line)
    {
        var quote = '\0';
        for (var i = 0; i < line.Length - 1; i++)
        {
            var c = line[i];
            if (quote == '\0' && (c == '"' || c == '\'')) quote = c;
            else if (quote == c) quote = '\0';
            else if (quote == '\0' && c == '#' && (i == 0 || line[i - 1] == ' '))
                return line[..i];
        }
        return line;
    }

    private sealed class Parser(List<(int Indent, string Text)> lines)
    {
        private int _index;

        public JsonNode Parse() => ParseNode(lines[0].Indent);

        private JsonNode ParseNode(int indent)
        {
            if (_index >= lines.Count) throw new FormatException();
            return lines[_index].Text.StartsWith("-", StringComparison.Ordinal) ? ParseList(indent) : ParseMap(indent);
        }

        private JsonNode ParseMap(int indent)
        {
            var map = new JsonObject();
            while (_index < lines.Count && lines[_index].Indent == indent && !lines[_index].Text.StartsWith("-", StringComparison.Ordinal))
            {
                var text = lines[_index].Text;
                var split = text.IndexOf(": ", StringComparison.Ordinal);
                string key;
                string value;
                if (split < 0 && text.EndsWith(':'))
                {
                    key = text[..^1].Trim();
                    value = "";
                }
                else if (split > 0)
                {
                    key = text[..split].Trim();
                    value = text[(split + 2)..].Trim();
                }
                else throw new FormatException();
                _index++;
                map[key] = ValueNode(value, indent);
            }
            return map;
        }

        private JsonNode ParseList(int indent)
        {
            var list = new JsonArray();
            while (_index < lines.Count && lines[_index].Indent == indent && lines[_index].Text.StartsWith("-", StringComparison.Ordinal))
            {
                var text = lines[_index].Text[1..].Trim();
                _index++;
                if (text.Length == 0)
                {
                    if (_index >= lines.Count || lines[_index].Indent <= indent) throw new FormatException();
                    list.Add(ParseNode(lines[_index].Indent));
                    continue;
                }
                var split = text.IndexOf(": ", StringComparison.Ordinal);
                if (split > 0 || text.EndsWith(':'))
                {
                    var map = new JsonObject();
                    var key = split > 0 ? text[..split].Trim() : text[..^1].Trim();
                    var value = split > 0 ? text[(split + 2)..].Trim() : "";
                    map[key] = ValueNode(value, indent);
                    while (_index < lines.Count && lines[_index].Indent > indent && !lines[_index].Text.StartsWith("-", StringComparison.Ordinal))
                    {
                        var nestedIndent = lines[_index].Indent;
                        var nested = ParseMap(nestedIndent);
                        if (nested is JsonObject extra)
                        {
                            foreach (var pair in extra)
                                map[pair.Key] = pair.Value?.DeepClone();
                        }
                    }
                    list.Add(map);
                    continue;
                }
                list.Add(Scalar(text));
            }
            return list;
        }

        private JsonNode? ValueNode(string value, int indent)
        {
            if (value is "|" or ">")
            {
                var block = new StringBuilder();
                var blockIndent = _index < lines.Count ? lines[_index].Indent : indent + 1;
                while (_index < lines.Count && lines[_index].Indent >= blockIndent)
                {
                    if (block.Length > 0) block.Append('\n');
                    block.Append(lines[_index].Text);
                    _index++;
                }
                return JsonValue.Create(block.ToString());
            }
            if (value.Length == 0)
            {
                if (_index >= lines.Count || lines[_index].Indent <= indent) return JsonValue.Create("");
                return ParseNode(lines[_index].Indent);
            }
            return Scalar(value);
        }

        private static JsonNode? Scalar(string raw)
        {
            var text = raw.Trim();
            if (text.Length >= 2 && ((text[0] == '"' && text[^1] == '"') || (text[0] == '\'' && text[^1] == '\'')))
                return JsonValue.Create(text[1..^1]);
            if (text is "true" or "True") return JsonValue.Create(true);
            if (text is "false" or "False") return JsonValue.Create(false);
            if (text is "null" or "~" or "Null") return null;
            if (Regex.IsMatch(text, "^-?[0-9]+$") && long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var number))
                return JsonValue.Create(number);
            return JsonValue.Create(text);
        }
    }
}

public static class RetryContract
{
    public static bool CanRetry(JsonElement result) => result.ValueKind == JsonValueKind.Object
        && result.TryGetProperty("retrySafe", out var safe) && safe.ValueKind == JsonValueKind.True
        && result.TryGetProperty("status", out var status) && status.ValueKind == JsonValueKind.Number && status.TryGetInt32(out var code)
        && code is 408 or 429 or 500 or 502 or 503 or 504;
}
