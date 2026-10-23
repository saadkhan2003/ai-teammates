namespace Teammates.Api;

/// <summary>
/// Default computer count for a small host. An explicit MAX_COMPUTERS wins.
/// Otherwise a machine with at least 6 GiB of MemTotal (an 8 GB VPS) gets 3,
/// and anything smaller, including a 4 GB VPS, gets 2. Larger hosts stay at 3
/// until an operator sets the variable.
/// </summary>
public static class HostBudget
{
    public const long EightGigabyteClass = 6L * 1024 * 1024 * 1024;

    public static int MaxComputers(long memTotalBytes, string? configured)
    {
        var raw = configured?.Trim();
        if (int.TryParse(raw, out var set) && set > 0) return set;
        if (memTotalBytes >= EightGigabyteClass) return 3;
        return 2;
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
