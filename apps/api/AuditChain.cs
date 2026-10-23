using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Teammates.Api;

public static class AuditChain
{
    public const string Genesis = "genesis";

    public static DateTime Stamp(DateTime utc)
    {
        var ticks = utc.Ticks / 10 * 10;
        return new DateTime(ticks, DateTimeKind.Utc);
    }

    public static string Format(DateTime utc) =>
        Stamp(utc).ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'", CultureInfo.InvariantCulture);

    public static string Canonical(long id, DateTime at, string actor, string action, string? bot, string? task, string detail, string prev) =>
        $"{id}|{Format(at)}|{actor}|{action}|{bot ?? ""}|{task ?? ""}|{detail}|{prev}";

    public static string Hash(long id, DateTime at, string actor, string action, string? bot, string? task, string detail, string prev)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(Canonical(id, at, actor, action, bot, task, detail, prev)));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }
}
