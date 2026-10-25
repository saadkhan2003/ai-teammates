using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;

namespace Teammates.Api;

public static class Totp
{
    public static byte[] NewSecret() => RandomNumberGenerator.GetBytes(20);

    public static string Code(ReadOnlySpan<byte> secret, long unixSeconds)
    {
        var counter = BitConverter.GetBytes(unixSeconds / 30);
        if (BitConverter.IsLittleEndian) Array.Reverse(counter);
        using var hmac = new HMACSHA1(secret.ToArray());
        var hash = hmac.ComputeHash(counter);
        var offset = hash[^1] & 0x0f;
        var binary = ((hash[offset] & 0x7f) << 24) | ((hash[offset + 1] & 0xff) << 16)
            | ((hash[offset + 2] & 0xff) << 8) | (hash[offset + 3] & 0xff);
        return (binary % 1_000_000).ToString("D6", System.Globalization.CultureInfo.InvariantCulture);
    }

    public static bool Verify(ReadOnlySpan<byte> secret, string? code, DateTimeOffset? now = null)
    {
        if (code is null || code.Length != 6 || !code.All(char.IsAsciiDigit)) return false;
        var seconds = (now ?? DateTimeOffset.UtcNow).ToUnixTimeSeconds();
        for (var delta = -1; delta <= 1; delta++)
            if (CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(Code(secret, seconds + delta * 30)), Encoding.ASCII.GetBytes(code))) return true;
        return false;
    }
}

public sealed class AccountRateLimiter
{
    private readonly ConcurrentDictionary<string, (int Count, DateTimeOffset Start)> _events = new();
    public bool Allow(string key, int maximum = 8, TimeSpan? window = null)
    {
        var duration = window ?? TimeSpan.FromMinutes(10);
        var now = DateTimeOffset.UtcNow;
        while (true)
        {
            var previous = _events.GetOrAdd(key, (0, now));
            var next = now - previous.Start >= duration ? (1, now) : (previous.Count + 1, previous.Start);
            if (_events.TryUpdate(key, next, previous)) return next.Item1 <= maximum;
        }
    }
}

public static class AccountSecurityPolicy
{
    public static bool CanRevokeSession(Guid sessionOwner, Guid actor, bool current) => sessionOwner == actor && !current;
    public static bool CanReadTicket(Guid ticketOwner, Guid actor, bool staff) => staff || ticketOwner == actor;
    public static bool CanManageSupport(string? role) => Access.IsStaff(role);
    public static bool HasDeleteConfirmation(string? value) => value == "DELETE MY ACCOUNT";
}
