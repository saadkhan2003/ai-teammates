using Dapper;
using Npgsql;

namespace Teammates.Api;

/// <summary>Zone handling for routines: every schedule is read in an IANA zone, never silently in UTC.</summary>
public static class RoutineTime
{
    public const string DefaultZone = "Asia/Karachi";

    public static bool TryZone(string? id, out TimeZoneInfo zone)
    {
        zone = TimeZoneInfo.Utc;
        if (string.IsNullOrWhiteSpace(id) || id.Length > 64) return false;
        try { zone = TimeZoneInfo.FindSystemTimeZoneById(id.Trim()); return true; }
        catch (Exception ex) when (ex is TimeZoneNotFoundException or InvalidTimeZoneException) { return false; }
    }

    /// <summary>The zone for an id; an unknown or empty id falls back to the user default, then UTC.</summary>
    public static TimeZoneInfo Zone(string? id)
    {
        if (TryZone(id, out var zone)) return zone;
        return TryZone(DefaultZone, out var fallback) ? fallback : TimeZoneInfo.Utc;
    }

    /// <summary>Next fire time of a cron expression in the named zone.</summary>
    public static DateTimeOffset Next(string cron, DateTimeOffset after, string? zoneId) => Cron.Next(cron, after, Zone(zoneId));

    public static DateTimeOffset? NextOrNull(string cron, DateTimeOffset after, string? zoneId)
    {
        try { return Next(cron, after, zoneId); }
        catch (Exception) { return null; }
    }

    public static async Task<string> OwnerZoneId(NpgsqlConnection conn, Guid owner)
    {
        var id = await conn.ExecuteScalarAsync<string?>("SELECT timezone FROM users WHERE id=@owner", new { owner });
        return TryZone(id, out _) ? id!.Trim() : DefaultZone;
    }

    public static async Task<string> BotOwnerZoneId(NpgsqlConnection conn, Guid botId)
    {
        var id = await conn.ExecuteScalarAsync<string?>("SELECT u.timezone FROM bots b JOIN users u ON u.id=b.owner_id WHERE b.id=@botId", new { botId });
        return TryZone(id, out _) ? id!.Trim() : DefaultZone;
    }
}
