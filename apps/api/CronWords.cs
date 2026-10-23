namespace Teammates.Api;

/// <summary>Plain-language schedule text. Same wording as the web list (apps/web/lib/cron.ts) so the approval card, the bot and the panel agree.</summary>
public static class CronWords
{
    private static readonly string[] Days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

    private static string Clock(int hour, int minute)
    {
        var suffix = hour >= 12 ? "PM" : "AM";
        var h = hour % 12 == 0 ? 12 : hour % 12;
        return $"{h}:{minute:00} {suffix}";
    }

    private static int? Num(string value, int max) =>
        value.Length is >= 1 and <= 2 && value.All(char.IsDigit) && int.Parse(value) <= max ? int.Parse(value) : null;

    private static string Ordinal(int n)
    {
        var rem = n % 100;
        if (rem is >= 11 and <= 13) return $"{n}th";
        return n + (n % 10) switch { 1 => "st", 2 => "nd", 3 => "rd", _ => "th" };
    }

    public static string Describe(string? cron)
    {
        var parts = (cron ?? "").Trim().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length != 5) return "Custom schedule";
        var (min, hour, dom, mon, dow) = (parts[0], parts[1], parts[2], parts[3], parts[4]);
        if (min.StartsWith("*/") && hour == "*" && dom == "*" && mon == "*" && dow == "*" && Num(min[2..], 59) is { } n)
            return n == 1 ? "Every minute" : n > 0 ? $"Every {n} minutes" : "Custom schedule";
        if (min == "*" && hour == "*" && dom == "*" && mon == "*" && dow == "*") return "Every minute";
        if (Num(min, 59) is not { } minute) return "Custom schedule";
        if (hour == "*" && dom == "*" && mon == "*" && dow == "*") return minute == 0 ? "Every hour" : $"Every hour at :{minute:00}";
        if (Num(hour, 23) is not { } h || mon != "*") return "Custom schedule";
        var at = Clock(h, minute);
        if (dom == "*" && dow == "*") return $"Every day at {at}";
        if (dom == "*" && dow == "1-5") return $"Every weekday at {at}";
        if (dom == "*" && (dow == "0,6" || dow == "6,0")) return $"Every weekend at {at}";
        if (dom == "*") return Num(dow == "7" ? "0" : dow, 6) is { } d ? $"Every {Days[d]} at {at}" : "Custom schedule";
        if (Num(dom, 31) is { } day && dow == "*" && day >= 1) return $"Monthly on the {Ordinal(day)} at {at}";
        return "Custom schedule";
    }

    /// <summary>Words for a stored routine: one-off reminders read as a date, recurring ones as the cron text, always with the zone.</summary>
    public static string ForRoutine(string kind, string cron, DateTimeOffset? runAt, string zoneId)
    {
        var zone = RoutineTime.Zone(zoneId);
        if (kind == "once" && runAt != null)
        {
            var local = TimeZoneInfo.ConvertTime(runAt.Value, zone);
            return $"Once on {local:ddd d MMM} at {Clock(local.Hour, local.Minute)} ({zoneId})";
        }
        return $"{Describe(cron)} ({zoneId})";
    }
}
