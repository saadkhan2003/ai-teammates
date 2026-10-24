namespace Teammates.Api;

/// <summary>Bounded positive cache; generation fencing prevents an in-flight lookup repopulating a revoked entry.</summary>
public sealed class SessionUserCache(int capacity = 4096, TimeProvider? clock = null)
{
    private readonly object gate = new();
    private readonly Dictionary<string, (Guid User, DateTimeOffset Until)> entries = new();
    private readonly TimeProvider time = clock ?? TimeProvider.System;
    private long generation;
    public long Generation { get { lock (gate) return generation; } }
    public bool TryGet(string hash, out Guid user)
    {
        lock (gate)
        {
            if (entries.TryGetValue(hash, out var entry) && entry.Until > time.GetUtcNow()) { user = entry.User; return true; }
            entries.Remove(hash); user = default; return false;
        }
    }
    public void Set(string hash, Guid user, DateTimeOffset expires, long observedGeneration)
    {
        lock (gate)
        {
            if (generation != observedGeneration) return;
            if (entries.Count >= capacity) entries.Clear();
            entries[hash] = (user, expires < time.GetUtcNow().AddSeconds(45) ? expires : time.GetUtcNow().AddSeconds(45));
        }
    }
    public void Invalidate(Guid? user = null, string? hash = null)
    {
        lock (gate)
        {
            generation++;
            foreach (var key in entries.Where(e => user == null && hash == null || e.Value.User == user || e.Key == hash).Select(e => e.Key).ToArray()) entries.Remove(key);
        }
    }
}
