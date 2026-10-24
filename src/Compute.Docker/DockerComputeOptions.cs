namespace Teammates.Compute;

public sealed record DockerComputeOptions
{
    public int EgressProxyPort { get; init; }
    public string DockerHost { get; init; } = "unix:///var/run/docker.sock";
    public string ImageRef { get; init; } = "teammates-computer:dev";
    public string? NetworkName { get; init; }
    /// <summary>Unix socket of the host isolation guard. Empty skips the check (contract tests).</summary>
    public string? IsolationSocket { get; init; }
    public string IsolationToken { get; init; } = "";
    public string? SeccompPath { get; init; }
    public int MaxComputers { get; init; } = 2;
    public int WarmPoolSize { get; init; }
    public TimeSpan ReadinessDeadline { get; init; } = TimeSpan.FromSeconds(45);
    /// <summary>Compose project name; scopes which containers on a shared Docker daemon this provider owns.</summary>
    public string? Stack { get; init; }
    public string ComputerToken { get; init; } = "";
    public string ComputerDns { get; init; } = Environment.GetEnvironmentVariable("COMPUTER_DNS") ?? "1.1.1.1,8.8.8.8";
    public bool SecondDisplay { get; init; } = !string.Equals(Environment.GetEnvironmentVariable("COMPUTER_SECOND_DISPLAY"), "false", StringComparison.OrdinalIgnoreCase);
    public IReadOnlyList<string> DnsServers()
    {
        var servers = ComputerDns.Split(',').Select(x => x.Trim()).ToArray();
        if (servers.Length == 0 || servers.Any(x => !System.Net.IPAddress.TryParse(x, out var ip) || ip.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork || ip.ToString() != x))
            throw ComputeException.InvalidArgument("COMPUTER_DNS requires comma-separated IPv4 addresses");
        return servers.Distinct().ToArray();
    }
    public string DisplayGeometry { get; init; } = "1920x1200";
    public string DisplayDepth { get; init; } = "24";
    public long MemoryBytes { get; init; } = 640L * 1024 * 1024;
    /// <summary>Soft memory reservation per computer. Limits above it are overcommitted across the host.</summary>
    public long MemoryReservationBytes { get; init; }
    /// <summary>Relative CPU entitlement: 1024 shares per CPU, default two CPUs under contention.</summary>
    public long CpuShares { get; init; } = 2048;
    /// <summary>Burst ceiling; zero disables CFS quotas for test hosts.</summary>
    public long NanoCpus { get; init; } = 4_000_000_000;
    public bool DisableCpuLimits { get; init; }

    public DockerComputeOptions WithCpuBudget(string? guarantee, string? burst, bool disabled = false)
    {
        static double Parse(string? raw, double fallback) => string.IsNullOrWhiteSpace(raw) ? fallback
            : double.TryParse(raw, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var value)
              && double.IsFinite(value) && value > 0 && value <= 1024 ? value
            : throw ComputeException.InvalidArgument("Computer CPU values must be positive numbers up to 1024");
        var entitlement = Parse(guarantee, 2);
        var ceiling = Parse(burst, 4);
        if (ceiling < entitlement) throw ComputeException.InvalidArgument("COMPUTER_CPU_BURST must be at least COMPUTER_CPU_GUARANTEE");
        return this with { CpuShares = Math.Max(2, (long)(entitlement * 1024)), NanoCpus = (long)(ceiling * 1_000_000_000), DisableCpuLimits = disabled };
    }
    public TimeSpan IdleSuspend { get; init; } = TimeSpan.FromMinutes(10);
    public TimeSpan IdleHibernate { get; init; } = TimeSpan.FromMinutes(30);
    public TimeSpan ResumeTarget { get; init; } = TimeSpan.FromSeconds(15);
    public IdlePowerMode IdlePower { get; init; } = IdlePowerMode.Hibernate;
    public string? CgroupParent { get; init; }
    public string CgroupRoot { get; init; } = "/sys/fs/cgroup";
}
