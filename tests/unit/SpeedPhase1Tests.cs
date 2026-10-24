using System.Text.Json;
using Teammates.Api;
namespace Teammates.UnitTests;
public class SpeedPhase1Tests
{
    [Fact]
    public void Consecutive_rounds_keep_system_catalog_memory_and_history_prefix_byte_stable()
    {
        var first = JsonSerializer.SerializeToElement(new[] { new { role="system", content="rules\n<<<BOT-OWNED CONTEXT memory\n[skill-catalog]\nread" }, new { role="user", content="hello" } });
        var next = JsonSerializer.SerializeToElement(first.EnumerateArray().Select(m => (object)m).Append(new { role="assistant", content="reply" }));
        var a = PromptOrder.Build(first, new { time=1, budget=10 });
        var b = PromptOrder.Build(next, new { time=2, budget=9 });
        Assert.Equal(a.EnumerateArray().Take(4).Select(m=>m.GetRawText()), b.EnumerateArray().Take(4).Select(m=>m.GetRawText()));
        Assert.Contains("skill-catalog", a[1].GetProperty("content").GetString());
        Assert.Contains("memory", a[2].GetProperty("content").GetString());
        Assert.Contains("live-state", a[4].GetProperty("content").GetString());
        var native = JsonSerializer.SerializeToElement(ProviderWire.AnthropicCompletion("test", a, Array.Empty<object>(), new()));
        Assert.True(native.GetProperty("system")[0].TryGetProperty("cache_control", out _));
        Assert.True(native.GetProperty("system")[2].TryGetProperty("cache_control", out _));
    }
    [Fact]
    public void Session_cache_bounds_expiry_and_invalidates_inflight_lookups_on_revoke_or_role_change()
    {
        var clock = new Clock(); var cache = new SessionUserCache(2, clock); var user = Guid.NewGuid();
        cache.Set("a",user,clock.GetUtcNow().AddHours(1),cache.Generation); Assert.True(cache.TryGet("a",out var found)); Assert.Equal(user,found);
        var generation=cache.Generation; cache.Invalidate(user); cache.Set("a",user,clock.GetUtcNow().AddHours(1),generation); Assert.False(cache.TryGet("a",out _));
        cache.Set("a",user,clock.GetUtcNow().AddSeconds(3),cache.Generation); clock.Now=clock.Now.AddSeconds(4); Assert.False(cache.TryGet("a",out _));
        cache.Set("a",user,clock.GetUtcNow().AddHours(1),cache.Generation); clock.Now=clock.Now.AddSeconds(46); Assert.False(cache.TryGet("a",out _));
        foreach(var hash in new[]{"a","b","c"}) cache.Set(hash,user,clock.GetUtcNow().AddHours(1),cache.Generation);
        Assert.False(cache.TryGet("a",out _)); Assert.True(cache.TryGet("c",out _)); cache.Invalidate(hash:"c"); Assert.False(cache.TryGet("c",out _));
    }

    [Fact]
    public void Distributed_invalidation_targets_users_or_hashed_sessions()
    {
        var cache=new SessionUserCache(); var a=Guid.NewGuid(); var b=Guid.NewGuid();
        cache.Set("a",a,DateTimeOffset.UtcNow.AddHours(1),cache.Generation); cache.Set("b",b,DateTimeOffset.UtcNow.AddHours(1),cache.Generation);
        SessionCacheInvalidator.Apply(cache,"user:"+a); Assert.False(cache.TryGet("a",out _)); Assert.True(cache.TryGet("b",out _));
        SessionCacheInvalidator.Apply(cache,"hash:b"); Assert.False(cache.TryGet("b",out _));
    }
    private sealed class Clock : TimeProvider { public DateTimeOffset Now = DateTimeOffset.UtcNow; public override DateTimeOffset GetUtcNow()=>Now; }
}
