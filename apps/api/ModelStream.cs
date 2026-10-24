using System.Diagnostics;
using System.Net.Http.Headers;
using System.Security.Cryptography;
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
        public IEnumerable<ModelDelta> Read(string frame, bool anthropic)
        {
            if (frame == "[DONE]") { Finished = true; return []; }
            using var doc = JsonDocument.Parse(frame);
            var root = doc.RootElement;
            if (root.TryGetProperty("error", out _)) throw new InvalidDataException("model_stream_error");
            var deltas = new List<ModelDelta>();
            if (anthropic)
            {
                var type = root.GetProperty("type").GetString();
                if (type == "error") throw new InvalidDataException("model_stream_error");
                if (type == "message_stop") Finished = true;
                if (type == "message_start" && root.GetProperty("message").TryGetProperty("usage", out var initial)) MergeUsage(initial);
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
            return JsonSerializer.SerializeToElement(new { choices = new[] { new { message = new { role="assistant", content=text.ToString(), tool_calls=tools.Values.Select(t => new { id=t.Id, type="function", function=new { name=t.Name, arguments=t.Args.Length == 0 ? "{}" : t.Args.ToString() } }) } } }, usage=resultUsage });
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

/// <summary>Additive streaming adapter; the complete-response adapter remains available.</summary>
public static class AiStreamingGateway
{
    public static async Task<ModelStreamResult> Stream(HttpClient http, AiResolution resolution, JsonElement messages, object tools, Guid sessionId, Func<ModelDelta, Task> publish, CancellationToken ct, int? maxTokens = null)
    {
        var clock = Stopwatch.StartNew(); int? ttft = null; var missing = true;
        var served = resolution.Primary; var prompt = messages;
        foreach (var endpoint in new[] { resolution.Primary }.Concat(resolution.Fallbacks))
        {
            var bytes = await endpoint.Key(ct); if (bytes == null) continue;
            missing = false; served = endpoint;
            var key = Encoding.UTF8.GetString(bytes); CryptographicOperations.ZeroMemory(bytes);
            var received = false;
            ModelStreamResult Result(bool ok, JsonElement response = default, bool context = false) => new(new(ok, false, context, response, prompt, served), ttft, (int)clock.ElapsedMilliseconds);
            try
            {
                prompt = JsonSerializer.Deserialize<JsonElement>(Dlp.Redact(OutputRedactor.Redact(messages.GetRawText(), [key])));
                var anthropic = endpoint.Kind == "anthropic";
                var payload = anthropic ? JsonSerializer.SerializeToNode(ProviderWire.AnthropicCompletion(endpoint.Model,prompt,tools,resolution.Caching))!.AsObject() : JsonSerializer.SerializeToNode(ProviderWire.Completion(endpoint.Model,prompt,tools))!.AsObject();
                payload["stream"] = true;
                if (maxTokens is {} cap) payload["max_tokens"] = cap;
                if (!anthropic)
                {
                    payload["messages"] = JsonNode.Parse(PromptCaching.Messages(JsonSerializer.SerializeToElement(payload["messages"]),resolution.Caching,endpoint.Kind).GetRawText());
                    payload.Remove("usage"); payload["stream_options"] = new JsonObject { ["include_usage"] = true };
                    if (JsonSerializer.SerializeToElement(tools).GetArrayLength() == 0) payload.Remove("tools");
                    if (resolution.Caching.Enabled && resolution.Caching.SessionIdPerConversation) payload["prompt_cache_key"] = sessionId.ToString("D");
                    if (endpoint.Kind == "openrouter")
                    {
                        if (resolution.Caching.SessionIdPerConversation) payload["session_id"] = sessionId.ToString("D");
                        if (resolution.Latency.PreferredMaxLatencyMs is {} ms) payload["provider"] = new JsonObject { ["preferred_max_latency"] = ms / 1000.0 };
                    }
                }
                using var request = new HttpRequestMessage(HttpMethod.Post, anthropic ? AiGateway.MessagesUrl(endpoint.BaseUrl) : endpoint.BaseUrl.TrimEnd('/')+"/chat/completions");
                if (anthropic) { request.Headers.Add("x-api-key",key); request.Headers.Add("anthropic-version","2023-06-01"); }
                else request.Headers.Authorization = new AuthenticationHeaderValue("Bearer",key);
                request.Content = new StringContent(payload.ToJsonString(),Encoding.UTF8,"application/json");
                using var response = await http.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,ct);
                if (response.StatusCode == System.Net.HttpStatusCode.TooManyRequests || (int)response.StatusCode >= 500) continue;
                if (!response.IsSuccessStatusCode)
                {
                    var error = await response.Content.ReadAsStringAsync(ct);
                    return Result(false, context: error.Contains("context_length",StringComparison.OrdinalIgnoreCase) || error.Contains("maximum context",StringComparison.OrdinalIgnoreCase));
                }
                var assembly = new ModelStream.Assembly(); var redactor = new StreamRedactor([key]);
                await using var source = await response.Content.ReadAsStreamAsync(ct);
                await using var stream = new ObservedReadStream(source, () => received = true);
                var toolNames = new Dictionary<int,string>();
                var knownTools = JsonSerializer.SerializeToElement(tools).EnumerateArray().Select(t => t.GetProperty("function").GetProperty("name").GetString()).ToHashSet();
                await foreach (var frame in ModelStream.Frames(stream,ct))
                {
                    received = true;
                    foreach (var delta in assembly.Read(frame,anthropic))
                    {
                        if (delta.Text?.Length > 0 || delta.Name?.Length > 0 || delta.Arguments?.Length > 0 || delta.Index != null) ttft ??= (int)clock.ElapsedMilliseconds;
                        if (delta.Text is {} text)
                        {
                            var safe = redactor.Push(text);
                            if (safe.Length > 0) await publish(new(Text:safe));
                        }
                        // Arguments stay private until the complete call is redacted; chips
                        // need only a known tool name, never URLs, filenames or credentials.
                        if (delta.Index is int toolIndex && delta.Name is { Length: > 0 })
                        {
                            toolNames[toolIndex] = toolNames.GetValueOrDefault(toolIndex, "") + delta.Name;
                            if (knownTools.Contains(toolNames[toolIndex])) await publish(new(Index:toolIndex, Name:toolNames[toolIndex]));
                        }
                    }
                    if (assembly.Finished) break;
                }
                if (!assembly.Finished) return Result(false);
                var tail = redactor.Push("",final:true); if (tail.Length > 0) await publish(new(Text:tail));
                var assembled = JsonSerializer.Deserialize<JsonElement>(Dlp.Redact(OutputRedactor.Redact(assembly.Response(anthropic).GetRawText(),[key])));
                return Result(true,assembled);
            }
            catch (Exception ex) when (ex is HttpRequestException or IOException or JsonException or OperationCanceledException or InvalidOperationException or KeyNotFoundException or FormatException && !ct.IsCancellationRequested)
            {
                if (received) return Result(false);
            }
            finally { key = ""; }
        }
        return new(new(false,missing,false,default,prompt,served),ttft,(int)clock.ElapsedMilliseconds);
    }
}

internal sealed class ObservedReadStream(Stream inner, Action observed) : Stream
{
    public override bool CanRead => inner.CanRead;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override int Read(byte[] buffer,int offset,int count) { var n=inner.Read(buffer,offset,count); if(n>0) observed(); return n; }
    public override async ValueTask<int> ReadAsync(Memory<byte> buffer,CancellationToken ct=default) { var n=await inner.ReadAsync(buffer,ct); if(n>0) observed(); return n; }
    public override long Seek(long offset,SeekOrigin origin)=>throw new NotSupportedException();
    public override void SetLength(long value)=>throw new NotSupportedException();
    public override void Write(byte[] buffer,int offset,int count)=>throw new NotSupportedException();
    public override void Flush()=>throw new NotSupportedException();
}
