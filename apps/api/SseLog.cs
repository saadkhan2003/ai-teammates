namespace Teammates.Api;

public readonly record struct SseFrame(long Id, string Data)
{
    public string Format()
    {
        var lines = Data.Replace("\r\n", "\n").Split('\n');
        var body = string.Join("\n", lines.Select(line => "data: " + line));
        return $"id: {Id}\n{body}\n\n";
    }
}

// A short ring of published events so a phone can resume with Last-Event-ID
// after the browser suspends the stream. Older ids than the ring are gone.
public sealed class SseLog
{
    public const int Capacity = 200;
    private readonly object _gate = new();
    private readonly Queue<SseFrame> _recent = new();
    private long _next = 1;

    public SseFrame Append(string data)
    {
        lock (_gate)
        {
            var frame = new SseFrame(_next++, data ?? "");
            _recent.Enqueue(frame);
            while (_recent.Count > Capacity) _recent.Dequeue();
            return frame;
        }
    }

    public IReadOnlyList<SseFrame> After(long id)
    {
        lock (_gate)
        {
            return _recent.Where(frame => frame.Id > id).ToArray();
        }
    }
}
