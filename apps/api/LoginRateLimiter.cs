using System.Net;
using System.Net.Sockets;

namespace Teammates.Api;

public sealed class LoginRateLimiter
{
    public static readonly TimeSpan Window = TimeSpan.FromMinutes(10);
    public const int MaxFailures = 8;
    public const int MaxAttempts = 30;

    public const string TestHeader = "X-Teammates-Test-Login";
    public static bool RelaxFor(bool testHooks, IHeaderDictionary headers) =>
        testHooks && headers[TestHeader] == "true";

    public static (int Attempts, int Failures) LimitsFor(bool testHooks) =>
        testHooks ? (3000, 800) : (MaxAttempts, MaxFailures);

    private readonly (int Attempts, int Failures) _limits;
    public LoginRateLimiter(bool testHooks = false) => _limits = LimitsFor(testHooks);

    private readonly Dictionary<string, List<DateTimeOffset>> _failures = new();
    private readonly Dictionary<string, List<DateTimeOffset>> _attempts = new();

    public bool IsBlocked(string ip, DateTimeOffset now)
    {
        lock (_failures)
        {
            return Count(_failures, ip, now) >= _limits.Failures || Count(_attempts, ip, now) >= _limits.Attempts;
        }
    }

    public void NoteAttempt(string ip, DateTimeOffset now)
    {
        lock (_failures) Add(_attempts, ip, now);
    }

    public void NoteFailure(string ip, DateTimeOffset now)
    {
        lock (_failures) Add(_failures, ip, now);
    }

    private static void Add(Dictionary<string, List<DateTimeOffset>> store, string ip, DateTimeOffset now)
    {
        if (!store.TryGetValue(ip, out var list)) store[ip] = list = [];
        list.RemoveAll(at => at < now - Window);
        list.Add(now);
    }

    private static int Count(Dictionary<string, List<DateTimeOffset>> store, string ip, DateTimeOffset now)
    {
        if (!store.TryGetValue(ip, out var list)) return 0;
        list.RemoveAll(at => at < now - Window);
        return list.Count;
    }
}

public static class ClientAddress
{
    public static string From(HttpContext ctx)
    {
        var remote = ctx.Connection.RemoteIpAddress;
        var forwarded = ctx.Request.Headers["X-Forwarded-For"].ToString();
        if (remote != null && IsPrivate(remote) && !string.IsNullOrWhiteSpace(forwarded))
        {
            var first = forwarded.Split(',')[0].Trim();
            if (first.Length > 0 && first.Length <= 80) return first;
        }
        return remote?.ToString() ?? "local";
    }

    public static bool IsPrivate(IPAddress address)
    {
        if (IPAddress.IsLoopback(address)) return true;
        if (address.AddressFamily == AddressFamily.InterNetworkV6 && address.IsIPv4MappedToIPv6)
            address = address.MapToIPv4();
        var bytes = address.GetAddressBytes();
        if (bytes.Length != 4) return address.IsIPv6LinkLocal || address.IsIPv6SiteLocal;
        if (bytes[0] == 10 || bytes[0] == 127) return true;
        if (bytes[0] == 192 && bytes[1] == 168) return true;
        if (bytes[0] == 172 && bytes[1] is >= 16 and <= 31) return true;
        return false;
    }
}
