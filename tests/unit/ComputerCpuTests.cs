using System.Reflection;
using System.Runtime.CompilerServices;
using Docker.DotNet.Models;
using Teammates.Compute;

namespace Teammates.UnitTests;

public sealed class ComputerCpuTests
{
    private static CreateContainerParameters Create(DockerComputeOptions options, uint cpu = 0)
    {
        // Build the request without constructing a client or contacting Docker.
        var provider = (DockerComputeProvider)RuntimeHelpers.GetUninitializedObject(typeof(DockerComputeProvider));
        typeof(DockerComputeProvider).GetField("_options", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(provider, options);
        var id = new ComputerId(Guid.NewGuid().ToString());
        var spec = new CreateComputerSpec(id, "local", "owner", "test-image", IsolationClass.Docker,
            new ResourceLimits(cpu, 640UL * 1024 * 1024, 0, 256), "", new Dictionary<string, string>());
        return (CreateContainerParameters)typeof(DockerComputeProvider)
            .GetMethod("BuildCreate", BindingFlags.Instance | BindingFlags.NonPublic)!
            .Invoke(provider, [spec, "cpu-test", "workspace", "profile", false, 0UL, null])!;
    }

    [Theory]
    [InlineData(false, 200_000_000L)]
    [InlineData(true, 0L)]
    public void Disk_helpers_also_honor_quota_free_stacks(bool disabled, long nanos)
    {
        var type = typeof(DockerComputeProvider).Assembly.GetType("Teammates.Compute.LoopDisk")!;
        var disk = RuntimeHelpers.GetUninitializedObject(type);
        type.GetField("_disableCpuLimits", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(disk, disabled);
        var host = (HostConfig)type.GetMethod("Host", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(disk, [null, false, false])!;
        Assert.Equal(nanos, host.NanoCPUs);
        Assert.Equal("none", host.NetworkMode);
        Assert.False(host.Privileged);
    }

    [Fact]
    public void Recovery_rejects_containers_from_other_stacks_before_adopt_or_remove()
    {
        var provider = (DockerComputeProvider)RuntimeHelpers.GetUninitializedObject(typeof(DockerComputeProvider));
        typeof(DockerComputeProvider).GetField("_options", BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(provider, new DockerComputeOptions { Stack = "v04m" });
        var require = typeof(DockerComputeProvider).GetMethod("RequireOwned", BindingFlags.Instance | BindingFlags.NonPublic)!;
        require.Invoke(provider, [new Dictionary<string, string> { ["teammates.stack"] = "v04m" }]);
        foreach (var labels in new[] { new Dictionary<string, string>(), new Dictionary<string, string> { ["teammates.stack"] = "teammates" } })
        {
            var error = Assert.Throws<TargetInvocationException>(() => require.Invoke(provider, [labels]));
            Assert.IsType<ComputeException>(error.InnerException);
        }
        var source = File.ReadAllText(Path.Combine(MigrationManifestTests.Root(), "src/Compute.Docker/DockerComputeProvider.cs"));
        Assert.Contains("RequireOwned(existing.Config.Labels);", source);
        Assert.Contains("ComputerReadiness.ProbeScript", source);
    }

    [Fact]
    public void Defaults_give_two_cpu_weight_and_four_cpu_burst()
    {
        var create = Create(new DockerComputeOptions());
        Assert.Equal(2048, create.HostConfig.CPUShares);
        Assert.Equal(4_000_000_000L, create.HostConfig.NanoCPUs);
        Assert.Equal(0, create.HostConfig.CPUQuota);
        Assert.Contains("no-new-privileges:true", create.HostConfig.SecurityOpt);
        Assert.Contains("ALL", create.HostConfig.CapDrop);
    }

    [Theory]
    [InlineData("1.5", "6", false, 1536, 6_000_000_000L)]
    [InlineData("2", "4", true, 2048, 0L)]
    public void Config_changes_weight_and_burst_without_losing_security(string guarantee, string burst, bool disabled, long shares, long nanos)
    {
        var create = Create(new DockerComputeOptions().WithCpuBudget(guarantee, burst, disabled));
        Assert.Equal(shares, create.HostConfig.CPUShares);
        Assert.Equal(nanos, create.HostConfig.NanoCPUs);
        Assert.Contains("no-new-privileges:true", create.HostConfig.SecurityOpt);
    }

    [Fact]
    public void Explicit_resource_limit_is_honored_unless_quotas_are_disabled()
    {
        Assert.Equal(1_000_000_000L, Create(new DockerComputeOptions(), 1000).HostConfig.NanoCPUs);
        Assert.Equal(0L, Create(new DockerComputeOptions { DisableCpuLimits = true }, 1000).HostConfig.NanoCPUs);
    }

    [Theory]
    [InlineData("0", "4")]
    [InlineData("2", "1")]
    [InlineData("NaN", "4")]
    [InlineData("2", "oops")]
    public void Invalid_cpu_settings_fail_closed(string guarantee, string burst) =>
        Assert.Throws<ComputeException>(() => new DockerComputeOptions().WithCpuBudget(guarantee, burst));
}
