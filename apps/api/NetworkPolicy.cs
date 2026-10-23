using System.Net;

namespace Teammates.Api;

public enum NetworkPolicyMode { AllowAll, DefaultsWithTeam, TeamOnly }

/// <summary>Immutable allow-list used at outbound connector boundaries.</summary>
public sealed class NetworkPolicy
{
    private static readonly string[] Defaults = ["example.com", "*.github.com", "*.githubusercontent.com", "*.npmjs.org", "*.pypi.org"];
    private readonly string[] _entries;
    public NetworkPolicyMode Mode { get; }
    public bool Locked { get; }

    public NetworkPolicy(NetworkPolicyMode mode, IEnumerable<string>? entries = null, bool locked = false)
    {
        Mode = mode;
        Locked = locked;
        var supplied = (entries ?? []).Take(501).Select(NormalizeEntry).ToArray();
        if (supplied.Length > 500) throw new ArgumentException("network policy accepts at most 500 entries", nameof(entries));
        _entries = supplied.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    }

    public NetworkPolicy WithGroupEntries(IEnumerable<string> entries) => Locked
        ? this
        : new NetworkPolicy(Mode, _entries.Concat(entries));

    public bool Allows(string host, int port)
    {
        if (Mode == NetworkPolicyMode.AllowAll) return true;
        if (MatchesAny(Mode == NetworkPolicyMode.DefaultsWithTeam ? Defaults : [], host, port)) return true;
        return MatchesAny(_entries, host, port);
    }

    public string BlockReason(string host) => $"blocked by policy: add {CleanHost(host)}";

    public static NetworkPolicy FromEnvironment(IConfiguration config)
    {
        var mode = config["NETWORK_POLICY_MODE"]?.Trim().ToLowerInvariant() switch
        {
            "allow_all" => NetworkPolicyMode.AllowAll,
            "defaults_with_team" => NetworkPolicyMode.DefaultsWithTeam,
            _ => NetworkPolicyMode.TeamOnly
        };
        var entries = (config["NETWORK_POLICY_ENTRIES"] ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var locked = bool.TryParse(config["NETWORK_POLICY_LOCKED"], out var value) && value;
        return new NetworkPolicy(mode, entries, locked);
    }

    private static bool MatchesAny(IEnumerable<string> entries, string host, int port)
    {
        host = CleanHost(host);
        foreach (var entry in entries)
        {
            var split = SplitPort(entry, out var entryPort);
            if (entryPort.HasValue && entryPort != port) continue;
            if (split.StartsWith("*.", StringComparison.Ordinal))
            {
                var suffix = split[1..];
                if (host.EndsWith(suffix, StringComparison.OrdinalIgnoreCase) && host.Length > suffix.Length) return true;
                continue;
            }
            if (split.Contains('/') && TryCidr(split[..split.IndexOf('/')], split[(split.IndexOf('/') + 1)..], host)) return true;
            if (IPAddress.TryParse(split, out var address))
            {
                if (IPAddress.TryParse(host, out var candidate) && address.Equals(candidate)) return true;
                continue;
            }
            if (host.Equals(split, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static string NormalizeEntry(string entry)
    {
        if (entry.Length is 0 or > 253 || entry.Any(char.IsControl) || entry.Contains('/') && !entry.Contains(':'))
        {
            if (entry.Length > 253 || entry.Any(char.IsControl)) throw new ArgumentException("invalid network policy entry");
        }
        var host = SplitPort(entry.Trim(), out var port);
        if (host.StartsWith("*.", StringComparison.Ordinal))
        {
            var suffix = CleanHost(host[2..]);
            if (Uri.CheckHostName(suffix) != UriHostNameType.Dns) throw new ArgumentException("invalid network policy wildcard");
            host = "*." + suffix;
        }
        else if (host.Contains('/'))
        {
            var parts = host.Split('/', 2);
            if (!IPAddress.TryParse(parts[0], out var network) || !int.TryParse(parts[1], out var prefix) || prefix < 0 || prefix > network.GetAddressBytes().Length * 8)
                throw new ArgumentException("invalid network policy CIDR");
        }
        else
        {
            host = CleanHost(host);
            if (Uri.CheckHostName(host) == UriHostNameType.Unknown) throw new ArgumentException("invalid network policy host");
        }
        if (port is < 1 or > 65535) throw new ArgumentException("invalid network policy port");
        return host + (port.HasValue ? ":" + port.Value : "");
    }

    private static string SplitPort(string value, out int? port)
    {
        port = null;
        var idx = value.LastIndexOf(':');
        if (idx > 0 && int.TryParse(value[(idx + 1)..], out var number))
        {
            // Do not mistake the final IPv6 component for a port.
            if (!value[..idx].Contains(':')) { port = number; return value[..idx]; }
        }
        return value;
    }

    private static string CleanHost(string host) => host.Trim().TrimEnd('.').ToLowerInvariant();

    private static bool TryCidr(string network, string prefixText, string host)
    {
        if (!IPAddress.TryParse(network, out var net) || !IPAddress.TryParse(host, out var ip) || !int.TryParse(prefixText, out var prefix)) return false;
        var a = net.GetAddressBytes(); var b = ip.GetAddressBytes();
        if (a.Length != b.Length || prefix < 0 || prefix > a.Length * 8) return false;
        var whole = prefix / 8; var bits = prefix % 8;
        for (var i = 0; i < whole; i++) if (a[i] != b[i]) return false;
        return bits == 0 || (a[whole] & (0xff << (8 - bits))) == (b[whole] & (0xff << (8 - bits)));
    }
}

public static class McpNetworkPolicyGuard
{
    public static string? Check(IConfiguration config, string url)
    {
        if (!bool.TryParse(config["NETWORK_POLICY_APPLY_TO_MCP"], out var enabled) || !enabled) return null;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || !NetworkPolicy.FromEnvironment(config).Allows(uri.Host, uri.Port))
            return "blocked by policy: add " + (Uri.TryCreate(url, UriKind.Absolute, out uri) ? uri.Host : "host");
        return null;
    }

    public static string? Check(string url)
    {
        var config = new ConfigurationBuilder().AddEnvironmentVariables().Build();
        return Check(config, url);
    }
}
