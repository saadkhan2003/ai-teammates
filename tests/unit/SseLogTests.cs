using Teammates.Api;

namespace Teammates.UnitTests;

public class SseLogTests
{
    [Fact]
    public void AfterReturnsOnlyNewerFrames()
    {
        var log = new SseLog();
        var first = log.Append("{\"type\":\"task\"}");
        var second = log.Append("{\"type\":\"message\"}");
        var replay = log.After(first.Id);
        Assert.Single(replay);
        Assert.Equal(second.Id, replay[0].Id);
        Assert.Contains("data: {\"type\":\"message\"}", replay[0].Format());
        Assert.StartsWith($"id: {second.Id}\n", replay[0].Format());
    }

    [Fact]
    public void RingDropsEventsOlderThanTheCapacity()
    {
        var log = new SseLog();
        long first = 0;
        for (var i = 0; i < SseLog.Capacity + 5; i++)
        {
            var frame = log.Append("x");
            if (i == 0) first = frame.Id;
        }
        var replay = log.After(0);
        Assert.Equal(SseLog.Capacity, replay.Count);
        Assert.DoesNotContain(replay, frame => frame.Id == first);
    }
}
