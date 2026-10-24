using Teammates.Api;

namespace Teammates.UnitTests;

public sealed class RfbClientStreamFilterTests
{
    [Fact]
    public void Watch_drops_input_messages_across_arbitrary_chunks()
    {
        var handshake = Enumerable.Range(0, 14).Select(x => (byte)x).ToArray();
        var safe = new byte[] { 0 }.Concat(new byte[19])
            .Concat(new byte[] { 2, 0, 0, 0 })
            .Concat(new byte[] { 3 }.Concat(new byte[9])).ToArray();
        var key = new byte[] { 4, 1, 0, 0, 0x41, 0, 0, 0 };
        var pointer = new byte[] { 5, 1, 0, 2, 0, 3 };
        var cut = new byte[] { 6, 0, 0, 0, 0, 0, 0, 3, (byte)'a', (byte)'b', (byte)'c' };
        var wire = handshake.Concat(safe).Concat(key).Concat(pointer).Concat(cut).Concat(safe).ToArray();
        var parser = new RfbClientStreamFilter("watch");
        var actual = new List<byte>();
        for (var offset = 0; offset < wire.Length;)
        {
            var count = Math.Min((offset % 7) + 1, wire.Length - offset);
            actual.AddRange(parser.Feed(wire.AsSpan(offset, count)));
            offset += count;
        }
        Assert.Equal(handshake.Concat(safe).Concat(safe), actual);
    }

    [Fact]
    public void Unknown_watch_message_is_rejected()
    {
        var parser = new RfbClientStreamFilter("watch");
        parser.Feed(new byte[14]);
        Assert.Throws<InvalidDataException>(() => parser.Feed(new byte[] { 127 }));
    }
}
