using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Teammates.Compute;

namespace Teammates.Api;

public sealed record ModelDelta(string? Text = null, int? Index = null, string? Id = null, string? Name = null, string? Arguments = null);
public sealed record ModelStreamResult(AiCallResult Call, int? TtftMs, int TotalMs);

/// <summary>Wire parsers consume SSE lines, so TCP and UTF-8 chunk boundaries can split anywhere.</summary>
public static class ModelStream
{
    public static async IAsyncEnumerable<string> Frames(Stream stream, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct = default)
    {
        using var reader = new StreamReader(stream, Encoding.UTF8, true, 4096, leaveOpen: true);
        var data = new StringBuilder();
        while (await reader.ReadLineAsync(ct) is { } line)
        {
            if (line.Length == 0)
            {
                if (data.Length > 0) { yield return data.ToString(); data.Clear(); }
            }
            else if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                if (data.Length > 0) data.Append('\n');
                data.Append(line[5..].TrimStart(' '));
                if (data.Length > 2_000_000) throw new InvalidDataException("model_frame_too_large");
            }
        }
        if (data.Length > 0) throw new InvalidDataException("model_stream_truncated");
    }

    public sealed class Assembly
    {
        private readonly StringBuilder text = new();
        private readonly SortedDictionary<int, (string Id, string Name, StringBuilder Args)> tools = new();
        private JsonObject usage = new();
        public bool Finished { get; private set; }
        public string? Model { get; private set; }
        public IEnumerable<ModelDelta> Read(string frame, bool anthropic)
        {
            if (frame == "[DONE]") { Finished = true; return []; }
            using var doc = JsonDocument.Parse(frame);
            var root = doc.RootElement;
            if (String(root, "model") is { } model) Model = model;
            if (root.TryGetProperty("error", out _)) throw new InvalidDataException("model_stream_error");
            var deltas = new List<ModelDelta>();
            if (anthropic)
            {
                var type = root.GetProperty("type").GetString();
                if (type == "error") throw new InvalidDataException("model_stream_error");
                if (type == "message_stop") Finished = true;
                if (type == "message_start")
                {
                    var message = root.GetProperty("message");
                    Model = String(message, "model") ?? Model;
                    if (message.TryGetProperty("usage", out var initial)) MergeUsage(initial);
                }
                if (type == "message_delta" && root.TryGetProperty("usage", out var final)) MergeUsage(final);
                if (type == "content_block_start")
                {
                    var block = root.GetProperty("content_block");
                    if (block.GetProperty("type").GetString() == "tool_use")
                        deltas.Add(new(Index: root.GetProperty("index").GetInt32(), Id: String(block,"id"), Name: String(block,"name")));
                    else if (String(block,"text") is { Length: > 0 } initialText) deltas.Add(new(Text: initialText));
                }
                if (type == "content_block_delta")
                {
                    var delta = root.GetProperty("delta");
                    if (String(delta,"type") == "text_delta") deltas.Add(new(Text: String(delta,"text")));
                    if (String(delta,"type") == "input_json_delta") deltas.Add(new(Index: root.GetProperty("index").GetInt32(), Arguments: String(delta,"partial_json")));
                }
            }
            else
            {
                if (root.TryGetProperty("usage", out var u) && u.ValueKind == JsonValueKind.Object) usage = JsonNode.Parse(u.GetRawText())!.AsObject();
                if (root.TryGetProperty("choices", out var choices))
                foreach (var choice in choices.EnumerateArray())
                {
                    if (choice.TryGetProperty("index", out var choiceIndex) && choiceIndex.GetInt32() != 0) continue;
                    if (!choice.TryGetProperty("delta", out var delta)) continue;
                    if (String(delta,"content") is { Length: > 0 } content) deltas.Add(new(Text: content));
                    if (delta.TryGetProperty("tool_calls", out var calls))
                    foreach (var call in calls.EnumerateArray())
                    {
                        var fn = call.TryGetProperty("function", out var f) ? f : default;
                        deltas.Add(new(Index: call.GetProperty("index").GetInt32(), Id: String(call,"id"), Name: String(fn,"name"), Arguments: String(fn,"arguments")));
                    }
                }
            }
            foreach (var delta in deltas)
            {
                if (delta.Text != null) text.Append(delta.Text);
                if (delta.Index is int index)
                {
                    if (!tools.TryGetValue(index,out var tool)) tool = ("", "", new());
                    tools[index] = (tool.Id + delta.Id, tool.Name + delta.Name, tool.Args.Append(delta.Arguments));
                }
            }
            if (text.Length > 1_000_000 || tools.Count > 128 || tools.Values.Any(t => t.Args.Length > 1_000_000)) throw new InvalidDataException("model_output_too_large");
            return deltas;
        }
        private void MergeUsage(JsonElement input) { foreach (var prop in input.EnumerateObject()) usage[prop.Name] = JsonNode.Parse(prop.Value.GetRawText()); }
        public JsonElement Response(bool anthropic)
        {
            var nativeUsage = JsonSerializer.SerializeToElement(usage);
            object resultUsage = usage;
            if (anthropic)
            {
                int N(string key) => nativeUsage.TryGetProperty(key,out var v) ? v.GetInt32() : 0;
                resultUsage = new { prompt_tokens=N("input_tokens")+N("cache_read_input_tokens")+N("cache_creation_input_tokens"), completion_tokens=N("output_tokens"), cache_read_input_tokens=N("cache_read_input_tokens"), cache_creation_input_tokens=N("cache_creation_input_tokens") };
            }
            return JsonSerializer.SerializeToElement(new { model = Model, choices = new[] { new { message = new { role="assistant", content=text.ToString(), tool_calls=tools.Values.Select(t => new { id=t.Id, type="function", function=new { name=t.Name, arguments=t.Args.Length == 0 ? "{}" : t.Args.ToString() } }) } } }, usage=resultUsage });
        }
        private static string? String(JsonElement element,string property) => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(property,out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    }
}

/// <summary>Holds complete sentences for DLP context. No partial token/identifier is published.</summary>
public sealed class StreamRedactor(IEnumerable<string>? secrets = null)
{
    private readonly StringBuilder pending = new();
    private readonly string[] keys = secrets?.ToArray() ?? [];
    public string Push(string text, bool final = false)
    {
        pending.Append(text);
        // The redactor's identifiers may span whitespace, but cannot cross sentence
        // punctuation. PEM blocks can span anything, so hold them to completion.
        var raw = pending.ToString();
        var end = final ? raw.Length : 0;
        if (!final)
        {
            for (var i = 0; i < raw.Length - 1; i++)
                if (raw[i] is '.' or '!' or '?' && char.IsWhiteSpace(raw[i + 1])) end = i + 2;
            if (raw.Contains("-----BEGIN", StringComparison.Ordinal)) return "";
            // Exact credentials can contain punctuation; never cut a complete or
            // still-arriving credential at a sentence boundary.
            foreach (var key in keys.Where(k => k.Length >= 6))
            for (var start = Math.Max(0, end - key.Length); start < end; start++)
            {
                var length = Math.Min(raw.Length - start, key.Length);
                if (start + length > end && raw.AsSpan(start, length).SequenceEqual(key.AsSpan(0, length))) end = start;
            }
        }
        if (end <= 0) return "";
        var safe = Dlp.Redact(OutputRedactor.Redact(raw[..end], keys));
        pending.Remove(0,end);
        return safe;
    }
}

/// <summary>SSE decoding and safe publication; admission and retries belong to AiControlledGateway.</summary>
public static class AiStreamingGateway
{
    public static async Task<ModelStreamResult> Stream(HttpClient http, AiResolution resolution, JsonElement messages, object tools, Guid sessionId, Func<ModelDelta, Task> publish, CancellationToken ct,
        Func<TimeSpan, CancellationToken, Task>? delay = null)
    {
        var clock = Stopwatch.StartNew();
        int? ttft = null;
        async Task<JsonElement> Read(HttpResponseMessage response, AiEndpoint endpoint, IReadOnlyList<string> keys, AiWireAttempt attempt, CancellationToken token)
        {
            var anthropic = endpoint.Kind == "anthropic";
            var assembly = new ModelStream.Assembly();
            var redactor = new StreamRedactor(keys);
            var toolNames = new Dictionary<int, string>();
            var knownTools = JsonSerializer.SerializeToElement(tools).EnumerateArray().Select(t => t.GetProperty("function").GetProperty("name").GetString()).ToHashSet();
            JsonElement Snapshot() => JsonSerializer.Deserialize<JsonElement>(Dlp.Redact(OutputRedactor.Redact(assembly.Response(anthropic).GetRawText(), keys)));
            try
            {
                await using var stream = await response.Content.ReadAsStreamAsync(token);
                await foreach (var frame in ModelStream.Frames(stream, token))
                {
                    foreach (var delta in assembly.Read(frame, anthropic))
                    {
                        if (delta.Text?.Length > 0 || delta.Name?.Length > 0 || delta.Arguments?.Length > 0 || delta.Index != null)
                        {
                            attempt.ContentStarted = true;
                            ttft ??= (int)clock.ElapsedMilliseconds;
                        }
                        if (delta.Text is { } text)
                        {
                            var safe = redactor.Push(text);
                            if (safe.Length > 0) await publish(new(Text: safe));
                        }
                        // Chips contain known tool names only; arguments remain private.
                        if (delta.Index is int index && delta.Name is { Length: > 0 })
                        {
                            toolNames[index] = toolNames.GetValueOrDefault(index, "") + delta.Name;
                            if (knownTools.Contains(toolNames[index])) await publish(new(Index: index, Name: toolNames[index]));
                        }
                    }
                    if (assembly.Finished) break;
                }
                if (!assembly.Finished) throw new InvalidDataException("model_stream_truncated");
                var tail = redactor.Push("", final: true);
                if (tail.Length > 0) await publish(new(Text: tail));
                return Snapshot();
            }
            catch
            {
                // Preserve reported usage and served model on a failed stream without publishing buffered text.
                attempt.Response = Snapshot();
                throw;
            }
        }
        var call = await AiControlledGateway.Execute(http, resolution, messages, tools, sessionId, ct, delay, Read);
        return new(call, ttft, (int)clock.ElapsedMilliseconds);
    }
}
