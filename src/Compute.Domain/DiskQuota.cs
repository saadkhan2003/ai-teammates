namespace Teammates.Compute;

public static class DiskQuota
{
    public const ulong DefaultBytes = 10UL * 1024 * 1024 * 1024;
    public const ulong MinimumBytes = 32UL * 1024 * 1024;

    /// <summary>
    /// Docker's <c>storage-opt size</c> is enforced only by overlay2 on XFS with project quotas.
    /// Other drivers accept the flag and ignore it, so the workdir needs a sized filesystem.
    /// </summary>
    public static bool UseStorageOpt(string? driver, string? backingFilesystem)
    {
        if (!string.Equals(driver, "overlay2", StringComparison.OrdinalIgnoreCase)) return false;
        return backingFilesystem != null && backingFilesystem.Contains("xfs", StringComparison.OrdinalIgnoreCase);
    }

    public static ulong Normalize(ulong requested)
    {
        if (requested == 0) return DefaultBytes;
        return requested < MinimumBytes ? MinimumBytes : requested;
    }

    /// <summary>A paused container still has its loop mount. Starting mkfs to check it is the slow part of resume.</summary>
    public static bool MountOnResume(bool containerPaused) => !containerPaused;
}
