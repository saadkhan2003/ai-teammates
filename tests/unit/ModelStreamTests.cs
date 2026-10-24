using System.Net;
using System.Text;
using System.Text.Json;
using Teammates.Api;
namespace Teammates.UnitTests;

public class ModelStreamTests
{
    private static JsonElement Parse(string json)=>JsonDocument.Parse(json).RootElement.Clone();
    private static string Sse(object value)=>"data: "+JsonSerializer.Serialize(value)+"\r\n\r\n";
    private static string Compatible() => Sse(new {choices=new[]{new {index=0,delta=new {content="Hello. More text. "}}}})
        + Sse(new {choices=new[]{new {index=0,delta=new {tool_calls=new[]{new {index=1,id="call_one",function=new {name="read_file",arguments="{\"path\":\""}}}}}}})
        + Sse(new {choices=new[]{new {index=0,delta=new {tool_calls=new[]{new {index=1,function=new {arguments="/workspace/é\"}"}}}}}}})
        + Sse(new {choices=Array.Empty<object>(),usage=new {prompt_tokens=30,completion_tokens=4,prompt_tokens_details=new {cached_tokens=20},cost=.001}})+"data: [DONE]\n\n";
    private static AiResolution Resolution(string kind="mock")
    {
        var one=new AiEndpoint(Guid.NewGuid(),kind,"http://mock/v1","chosen",_=>Task.FromResult<byte[]?>(Encoding.UTF8.GetBytes("test-key-for-stream")));
        var two=one with {ProviderId=Guid.NewGuid(),BaseUrl="http://fallback/v1"};
        return new(one,[two],new(),new(1000),9,new(new(){["chat"]=new(new(one.ProviderId,"chosen"))}, Retry: new(0)));
    }
    private static object[] Tools => [new {type="function",function=new {name="read_file",parameters=new {type="object"}}}];
    [Fact]
    public async Task Compatible_frames_split_mid_json_and_utf8_assemble_tools_text_and_usage()
    {
        var assembly=new ModelStream.Assembly(); var deltas=new List<ModelDelta>();
        await foreach(var frame in ModelStream.Frames(new Pieces(Encoding.UTF8.GetBytes(Compatible()),3))) deltas.AddRange(assembly.Read(frame,false));
        Assert.True(assembly.Finished); var result=assembly.Response(false); var message=result.GetProperty("choices")[0].GetProperty("message");
        Assert.Equal("Hello. More text. ",message.GetProperty("content").GetString());
        var tool=Assert.Single(message.GetProperty("tool_calls").EnumerateArray());
        Assert.Equal("call_one",tool.GetProperty("id").GetString()); Assert.Equal("/workspace/é",Parse(tool.GetProperty("function").GetProperty("arguments").GetString()!).GetProperty("path").GetString());
        var usage=ProviderWire.ReadUsage(result); Assert.Equal(30,usage.PromptTokens); Assert.Equal(4,usage.CompletionTokens); Assert.Equal(20,usage.CachedTokens); Assert.Equal(.001m,usage.CostUsd);
        Assert.Equal("read_file",deltas.First(d=>d.Name!=null).Name);
    }
    [Fact]
    public async Task Native_anthropic_splits_capture_message_start_tool_input_and_message_delta_usage()
    {
        var frames=Sse(new {type="message_start",message=new {usage=new {input_tokens=10,output_tokens=0,cache_read_input_tokens=20,cache_creation_input_tokens=5}}})
            + Sse(new {type="content_block_delta",index=0,delta=new {type="text_delta",text="hello"}})
            + Sse(new {type="content_block_start",index=2,content_block=new {type="tool_use",id="t1",name="read_file",input=new {}}})
            + Sse(new {type="content_block_delta",index=2,delta=new {type="input_json_delta",partial_json="{\"p\":"}})
            + Sse(new {type="content_block_delta",index=2,delta=new {type="input_json_delta",partial_json="1}"}})
            + Sse(new {type="message_delta",usage=new {output_tokens=7}})+Sse(new {type="message_stop"});
        var assembly=new ModelStream.Assembly();
        await foreach(var frame in ModelStream.Frames(new Pieces(Encoding.UTF8.GetBytes(frames),1))) assembly.Read(frame,true);
        Assert.True(assembly.Finished); var result=assembly.Response(true); var usage=ProviderWire.ReadUsage(result);
        Assert.Equal(35,usage.PromptTokens); Assert.Equal(7,usage.CompletionTokens); Assert.Equal(20,usage.CachedTokens); Assert.Equal(5,usage.CacheWriteTokens);
        Assert.Equal("{\"p\":1}",result.GetProperty("choices")[0].GetProperty("message").GetProperty("tool_calls")[0].GetProperty("function").GetProperty("arguments").GetString());
    }
    [Fact]
    public async Task Streaming_measures_first_delta_before_total_and_preserves_served_model_and_usage()
    {
        using var http=new HttpClient(new Handler(_=>new(HttpStatusCode.OK){Content=new StreamContent(new Pieces(Encoding.UTF8.GetBytes(Compatible()),64,2))}));
        var seen=new List<ModelDelta>();
        var result=await AiStreamingGateway.Stream(http,Resolution(),Parse("[]"),Tools,Guid.NewGuid(),d=>{seen.Add(d);return Task.CompletedTask;},default);
        Assert.True(result.Call.Ok); Assert.NotNull(result.TtftMs); Assert.True(result.TtftMs<result.TotalMs);
        Assert.Equal("chosen",result.Call.Served.Model); Assert.Equal(30,ProviderWire.ReadUsage(result.Call.Response).PromptTokens);
        Assert.Contains(seen,d=>d.Name=="read_file"); Assert.DoesNotContain(seen,d=>d.Arguments!=null);
    }
    [Theory]
    [InlineData(true)] [InlineData(false)]
    public async Task Fallback_before_first_content_even_when_malformed_bytes_arrived(bool failBefore)
    {
        var calls=0;
        using var http=new HttpClient(new Handler(_=>{
            calls++;
            if(calls==1) return new(HttpStatusCode.OK){Content=new StreamContent(failBefore ? new FailingStream() : new Pieces(Encoding.UTF8.GetBytes("data: {broken\n\n"),2))};
            return new(HttpStatusCode.OK){Content=new StringContent(Compatible())};
        }));
        var result=await AiStreamingGateway.Stream(http,Resolution(),Parse("[]"),Tools,Guid.NewGuid(),_=>Task.CompletedTask,default);
        Assert.True(result.Call.Ok); Assert.Equal(2,calls);
    }
    [Fact]
    public async Task Truncated_success_response_is_error_and_does_not_fallback()
    {
        var calls=0; using var http=new HttpClient(new Handler(_=>{calls++;return new(HttpStatusCode.OK){Content=new StringContent(Sse(new {choices=new[]{new {delta=new {content="partial"}}}}))};}));
        var result=await AiStreamingGateway.Stream(http,Resolution(),Parse("[]"),Tools,Guid.NewGuid(),_=>Task.CompletedTask,default);
        Assert.False(result.Call.Ok); Assert.Equal(1,calls);
    }
    [Theory]
    [InlineData("Card 4242 4242 4242 4242. Next sentence. ")]
    [InlineData("Token sk-or-abcdefghijklmno. Next sentence. ")]
    [InlineData("national id: AB1234567. Next sentence. ")]
    [InlineData("-----BEGIN PRIVATE KEY-----\na-secret. not-safe\n-----END PRIVATE KEY-----\nDone. ")]
    public void Dlp_withholds_identifiers_across_arbitrary_chunk_boundaries(string text)
    {
        for(var split=0;split<=text.Length;split++)
        {
            var redactor=new StreamRedactor();
            var output=redactor.Push(text[..split])+redactor.Push(text[split..])+redactor.Push("",true);
            Assert.Equal(Dlp.Redact(text),output);
        }
    }
    [Fact]
    public void Exact_credentials_crossing_sentence_boundaries_are_withheld()
    {
        var redactor=new StreamRedactor(["abcdef. ghijkl"]);
        Assert.Equal("",redactor.Push("abcdef. gh"));
        var output=redactor.Push("ijkl done. Next. ")+redactor.Push("",true);
        Assert.DoesNotContain("abcdef",output); Assert.Contains("[REDACTED]",output);
    }
    [Fact]
    public void Scoped_events_cannot_replay_to_another_user_and_gap_detects_ring_overflow_and_restart()
    {
        var owner=Guid.NewGuid(); var other=Guid.NewGuid(); var log=new SseLog();
        var frame=log.Append(JsonSerializer.Serialize(new {type="message.delta",ownerId=owner,delta="safe"}));
        Assert.True(EventProjection.Visible(frame.Format(),owner)); Assert.False(EventProjection.Visible(frame.Format(),other));
        Assert.False(log.HasGap(frame.Id)); Assert.True(new SseLog().HasGap(frame.Id));
        for(var i=0;i<210;i++)log.Append("{}"); Assert.True(log.HasGap(frame.Id));
    }

    [Theory]
    [InlineData(true)] [InlineData(false)]
    public async Task Streaming_routing_hints_are_optional_and_do_not_change_resolved_model(bool configured)
    {
        var resolution=Resolution("openrouter") with { Latency=configured ? new(1234) : new(), Role = new(new(Guid.Empty, "chosen"), MaxTokens: 77) };
        var requests=new List<string>();
        using var http=new HttpClient(new Handler(request=>{requests.Add(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());return new(HttpStatusCode.OK){Content=new StringContent(Compatible())};}));
        var session=Guid.NewGuid();
        var result=await AiStreamingGateway.Stream(http,resolution,Parse("[{\"role\":\"system\",\"content\":\"stable\"}]"),Tools,session,_=>Task.CompletedTask,default);
        Assert.True(result.Call.Ok);
        var payload=Parse(Assert.Single(requests)); Assert.True(payload.GetProperty("stream").GetBoolean()); Assert.Equal(77,payload.GetProperty("max_tokens").GetInt32());
        Assert.Equal("chosen",payload.GetProperty("models")[0].GetString()); Assert.Equal(session.ToString(),payload.GetProperty("session_id").GetString());
        Assert.True(payload.GetProperty("stream_options").GetProperty("include_usage").GetBoolean());
        Assert.True(payload.GetProperty("messages")[0].GetProperty("content")[0].TryGetProperty("cache_control",out _));
        if(configured) Assert.Equal(1.234,payload.GetProperty("provider").GetProperty("preferred_max_latency").GetDouble());
        else Assert.False(payload.GetProperty("provider").TryGetProperty("preferred_max_latency",out _));
    }
    [Fact]
    public async Task Gateway_publishes_only_redacted_deltas_and_returns_the_same_redacted_text()
    {
        var text="Start here. Card 4242424242424242 and test-key-for-stream. More text. ";
        var frames=Sse(new {choices=new[]{new {index=0,delta=new {content=text}}}})+"data: [DONE]\n\n";
        using var http=new HttpClient(new Handler(_=>new(HttpStatusCode.OK){Content=new StreamContent(new Pieces(Encoding.UTF8.GetBytes(frames),1))}));
        var published=new StringBuilder();
        var result=await AiStreamingGateway.Stream(http,Resolution(),Parse("[]"),Tools,Guid.NewGuid(),d=>{published.Append(d.Text);return Task.CompletedTask;},default);
        Assert.True(result.Call.Ok); Assert.DoesNotContain("4242424242424242",published.ToString()); Assert.DoesNotContain("test-key-for-stream",published.ToString());
        Assert.Equal(result.Call.Response.GetProperty("choices")[0].GetProperty("message").GetProperty("content").GetString(),published.ToString());
    }
    private sealed class Handler(Func<HttpRequestMessage,HttpResponseMessage> respond):HttpMessageHandler
    { protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)=>Task.FromResult(respond(request)); }
    private class Pieces(byte[] bytes,int width,int delay=0):MemoryStream(bytes)
    { public override async ValueTask<int> ReadAsync(Memory<byte> buffer,CancellationToken ct=default){if(delay>0)await Task.Delay(delay,ct);return await base.ReadAsync(buffer[..Math.Min(width,buffer.Length)],ct);} }
    private sealed class FailingStream():Pieces([],1)
    { public override ValueTask<int> ReadAsync(Memory<byte> buffer,CancellationToken ct=default)=>throw new IOException("before first byte"); }
}
