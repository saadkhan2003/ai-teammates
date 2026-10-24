namespace Teammates.Api;

/// <summary>
/// Default awake-computer count per host. An explicit MAX_COMPUTERS wins.
/// Computers overcommit RAM (an 8 GB ceiling each, a small reservation, idle ones paused),
/// so a host with at least 6 GiB gets one slot per 1.5 GiB, at least 4 and at most 64.
/// Anything smaller, including a 4 GB VPS, gets 2.
/// </summary>
public static class HostBudget
{
    public const long EightGigabyteClass = 6L * 1024 * 1024 * 1024;
    public const long SlotBytes = 1536L * 1024 * 1024;
    public const int MinimumLargeHost = 4;

    public static int MaxComputers(long memTotalBytes, string? configured)
    {
        var raw = configured?.Trim();
        if (int.TryParse(raw, out var set) && set > 0) return set;
        if (memTotalBytes < EightGigabyteClass) return 2;
        return (int)Math.Clamp(memTotalBytes / SlotBytes, MinimumLargeHost, 64);
    }

    public static long ReadMemTotalBytes()
    {
        try
        {
            foreach (var line in File.ReadLines("/proc/meminfo"))
            {
                if (!line.StartsWith("MemTotal:", StringComparison.Ordinal)) continue;
                var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length >= 2 && long.TryParse(parts[1], out var kb)) return kb * 1024L;
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
        return 0;
    }
}
