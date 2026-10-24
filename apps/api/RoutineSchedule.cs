using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace Teammates.Api;

/// <summary>Pure timing and wording rules for scheduled runs: jitter, the missed-run window, the quiet rule and the hidden-turn framing.</summary>
public static class RoutineSchedule
{
    public const int JitterCapSeconds = 15 * 60;
    public static readonly TimeSpan RecurringWindow = TimeSpan.FromHours(6);
    public static readonly TimeSpan OnceWindow = TimeSpan.FromHours(24);

    /// <summary>Same routine, same offset every time. Half the gap between runs, at most 15 minutes, none for gaps of 5 minutes or less.</summary>
    public static int JitterSeconds(Guid routineId, string cron)
    {
        var gap = PeerLimits.CronGapMinutes(cron);
        if (gap == null || gap <= RoutineService.MinMinutes) return 0;
        var limit = Math.Min(gap.Value * 60 / 2, JitterCapSeconds);
        var hash = SHA256.HashData(routineId.ToByteArray());
        var value = BitConverter.ToUInt32(hash, 0);
        return (int)(value % (uint)(limit + 1));
    }

    /// <summary>A run that is too late is skipped instead of firing hours after it was due.</summary>
    public static bool TooLate(string kind, DateTimeOffset scheduledFor, DateTimeOffset now) =>
        now - scheduledFor > (kind == "once" ? OnceWindow : RecurringWindow);

    public static bool IsQuiet(string? quietRule, string? text)
    {
        if (string.IsNullOrWhiteSpace(quietRule) || string.IsNullOrWhiteSpace(text)) return false;
        var bare = Regex.Replace(text.Trim(), @"^[\s`*_""']+|[\s`*_""'.!]+$", "");
        return string.Equals(bare, RoutineService.QuietSentinel, StringComparison.Ordinal);
    }

    public static string Framing(string name, string instruction, string? quietRule, string scheduledLocal)
    {
        var quiet = string.IsNullOrWhiteSpace(quietRule)
            ? "none, always report."
            : $"{quietRule.Trim()} If that applies, reply with exactly {RoutineService.QuietSentinel} and nothing else.";
        return $"This is a scheduled run, not a user message. Routine: {name}. Scheduled for {scheduledLocal}. Quiet rule: {quiet}\n\n{instruction}";
    }

    public static string Excerpt(string? text, int max = 160)
    {
        var clean = Dlp.Redact(Regex.Replace(text ?? "", @"\s+", " ").Trim());
        return clean.Length <= max ? clean : clean[..max].TrimEnd() + "...";
    }
}
