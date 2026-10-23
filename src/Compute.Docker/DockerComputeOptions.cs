namespace Teammates.Compute;

public sealed record DockerComputeOptions
{
    public string DockerHost { get; init; } = "unix:///var/run/docker.sock";
    public string ImageRef { get; init; } = "teammates-computer:dev";
    public string? NetworkName { get; init; }
    /// <summary>Unix socket of the host isolation guard. Empty skips the check (contract tests).</summary>
    public string? IsolationSocket { get; init; }
    public string IsolationToken { get; init; } = "";
    public string? SeccompPath { get; init; }
    public int MaxComputers { get; init; } = 2;
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
    public long NanoCpus { get; init; } = 400_000_000;
    public TimeSpan IdleSuspend { get; init; } = TimeSpan.FromMinutes(10);
    public TimeSpan IdleHibernate { get; init; } = TimeSpan.FromMinutes(30);
    public TimeSpan ResumeTarget { get; init; } = TimeSpan.FromSeconds(15);
    public IdlePowerMode IdlePower { get; init; } = IdlePowerMode.Hibernate;
    public string? CgroupParent { get; init; }
    public string CgroupRoot { get; init; } = "/sys/fs/cgroup";
}
