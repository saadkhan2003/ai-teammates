using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Teammates.UnitTests;

public class ProviderContractTests
{
    private static string Fixture(string name) =>
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "openrouter", name));

    private static string Canon(JsonElement value)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
            value.WriteTo(writer);
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    [Fact]
    public void RecordedTranscriptIsSentAsOpenAiToolCalls()
    {
        using var internalMessages = JsonDocument.Parse(Fixture("messages_internal.json"));
        using var expected = JsonDocument.Parse(Fixture("messages_provider.json"));
        var actual = Teammates.Api.ProviderWire.ToOpenAi(internalMessages.RootElement);
        Assert.Equal(Canon(expected.RootElement), Canon(actual));
        var wire = Canon(actual);
        Assert.DoesNotContain("toolCalls", wire);
        Assert.DoesNotContain("toolCallId", wire);
        Assert.Contains("\"type\":\"function\"", wire);
        Assert.Contains("\"tool_call_id\":\"call_del_9f2\"", wire);
        Assert.Contains("\"tool_call_id\":\"call_ls_3ab\"", wire);
    }

    [Fact]
    public void CompletionRequestsUsageAndMaxTokens()
    {
        using var internalMessages = JsonDocument.Parse(Fixture("messages_internal.json"));
        var body = Teammates.Api.ProviderWire.Completion("openai/gpt-4.1-mini", internalMessages.RootElement, Array.Empty<object>());
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(body));
        Assert.Equal(Teammates.Api.ProviderWire.MaxTokens, doc.RootElement.GetProperty("max_tokens").GetInt32());
        Assert.True(doc.RootElement.GetProperty("usage").GetProperty("include").GetBoolean());
        Assert.Equal("function", doc.RootElement.GetProperty("messages")[2].GetProperty("tool_calls")[0].GetProperty("type").GetString());
        Assert.StartsWith("{", doc.RootElement.GetProperty("messages")[2].GetProperty("tool_calls")[0].GetProperty("function").GetProperty("arguments").GetString());
    }

    [Fact]
    public void RecordedParallelResponseKeepsEveryCallAndItsCost()
    {
        using var recorded = JsonDocument.Parse(Fixture("response_parallel.json"));
        var message = Teammates.Api.ProviderWire.Normalize(recorded.RootElement.GetProperty("choices")[0].GetProperty("message"));
        var calls = message.GetProperty("toolCalls");
        Assert.Equal(2, calls.GetArrayLength());
        Assert.Equal("call_del_9f2", calls[0].GetProperty("id").GetString());
        Assert.Equal("call_ls_3ab", calls[1].GetProperty("id").GetString());
        Assert.Equal("delete_file", calls[0].GetProperty("name").GetString());
        Assert.Equal("/workspace/notes/ping.txt", calls[0].GetProperty("arguments").GetProperty("path").GetString());
        var usage = Teammates.Api.ProviderWire.ReadUsage(recorded.RootElement);
        Assert.Equal(180, usage.PromptTokens);
        Assert.Equal(36, usage.CompletionTokens);
        Assert.Equal(0.000128m, usage.CostUsd);
    }

    [Fact]
    public void QuestionCardUsesTheRecordedToolCallId()
    {
        var id = Teammates.Api.ProviderWire.AskToolCallId(Fixture("ask_tool_calls.json"));
        Assert.Equal("call_ask_77c", id);
        Assert.Null(Teammates.Api.ProviderWire.AskToolCallId("[{\"id\":\"call_1\",\"name\":\"delete_file\",\"arguments\":{}}]"));
        Assert.Null(Teammates.Api.ProviderWire.AskToolCallId(null));
    }

    [Theory]
    [InlineData("key_decimal.json", true, 12)]
    [InlineData("key_null.json", true, null)]
    [InlineData("key_int.json", true, 60)]
    public void OpenRouterLimitAcceptsDecimalAndNull(string fixture, bool ok, int? limit)
    {
        var read = Teammates.Api.ProviderWire.ReadKey(Fixture(fixture));
        Assert.Equal(ok, read.Ok);
        Assert.Equal(limit, read.Limit);
        Assert.Null(read.Error);
    }

    [Fact]
    public void MissingFileReadIsNotFoundWithoutATraceback()
    {
        var missing = Path.Combine(Path.GetTempPath(), "tm-missing-" + Guid.NewGuid().ToString("N"));
        var present = Path.Combine(Path.GetTempPath(), "tm-present-" + Guid.NewGuid().ToString("N"));
        File.WriteAllText(present, "hello");
        try
        {
            var gone = RunRead(missing);
            Assert.Equal(2, gone.Code);
            Assert.Equal("not_found", gone.Stdout.Trim());
            Assert.DoesNotContain("Traceback", gone.Stderr);
            var found = RunRead(present);
            Assert.Equal(0, found.Code);
            Assert.Contains("hello", found.Stdout);
            Assert.DoesNotContain("Traceback", found.Stderr);
        }
        finally
        {
            File.Delete(present);
        }
    }

    private static (int Code, string Stdout, string Stderr) RunRead(string path)
    {
        var start = new ProcessStartInfo("python3")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        start.ArgumentList.Add("-c");
        start.ArgumentList.Add(Teammates.Api.FileTools.ReadProgram);
        start.ArgumentList.Add(path);
        using var process = Process.Start(start);
        Assert.NotNull(process);
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        return (process.ExitCode, stdout, stderr);
    }
}
