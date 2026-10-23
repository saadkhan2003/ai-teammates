using System.Buffers.Binary;
using System.Runtime.InteropServices;

namespace Teammates.Api;

/// <summary>Incremental RFB client stream filter used by view-only VNC sessions.</summary>
public sealed class RfbClientStreamFilter(string role, int maxMessage = 1 << 20)
{
    private readonly List<byte> _pending = [];
    private int _handshakeBytes = 14;

    public byte[] Feed(ReadOnlySpan<byte> input)
    {
        if (_pending.Count + input.Length > maxMessage + 22)
            throw new InvalidDataException("RFB message exceeds limit");
        _pending.AddRange(input.ToArray());
        var output = new List<byte>();
        var offset = 0;
        if (_handshakeBytes > 0)
        {
            var pass = Math.Min(_handshakeBytes, _pending.Count);
            output.AddRange(_pending.Take(pass));
            offset += pass;
            _handshakeBytes -= pass;
        }
        while (offset < _pending.Count)
        {
            var kind = _pending[offset];
            int length;
            if (kind == 6)
            {
                if (_pending.Count - offset < 8) break;
                var textLength = BinaryPrimitives.ReadUInt32BigEndian(CollectionsMarshal.AsSpan(_pending).Slice(offset + 4, 4));
                if (textLength > maxMessage - 8) throw new InvalidDataException("RFB message exceeds limit");
                length = checked(8 + (int)textLength);
            }
            else if (kind == 2)
            {
                if (_pending.Count - offset < 4) break;
                var encodings = BinaryPrimitives.ReadUInt16BigEndian(CollectionsMarshal.AsSpan(_pending).Slice(offset + 2, 2));
                length = 4 + 4 * encodings;
            }
            else
            {
                length = kind switch { 0 => 20, 3 => 10, 4 => 8, 5 => 6, _ => throw new InvalidDataException("Unsupported RFB client message") };
            }
            if (length > maxMessage) throw new InvalidDataException("RFB message exceeds limit");
            if (_pending.Count - offset < length) break;
            if (role != "watch" || kind is not (4 or 5 or 6))
                output.AddRange(_pending.Skip(offset).Take(length));
            offset += length;
        }
        if (offset > 0) _pending.RemoveRange(0, offset);
        return output.ToArray();
    }
}
