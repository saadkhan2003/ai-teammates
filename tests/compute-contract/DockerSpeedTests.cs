using System.Text.Json;
using Teammates.Compute;
using Teammates.Compute.Testing;

namespace Teammates.Compute.ContractTests;

public class DockerSpeedTests
{
    [Fact]
    public async Task TemplateClaimCreatesFreshVolumesAndRecordsStagesThenWakeConverges()
    {
        await using var engine = new MockDockerEngine();
        var desktop = new MockDockerEngine.DesktopHandler();
        await using var provider = new DockerComputeProvider(new DockerComputeOptions
        { Stack = "speed-contract", NetworkName = "speed-contract-computers", WarmPoolSize = 1, MaxComputers = 2 },
            new MockDockerEngine.NoSecrets(), new MockDockerEngine.NoSnapshots(), computerHttpHandler: desktop, dockerClient: engine.Client);
        var stages = new List<(string Name, double Ms, string Path)>();
        provider.RecordPerformance = (name, ms, attrs) => stages.Add((name, ms, JsonSerializer.SerializeToElement(attrs).GetProperty("path").GetString()!));
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var pool = provider.RunWarmPoolAsync(cancel.Token);
        while (provider.WarmPoolCount != 1) await Task.Delay(10, cancel.Token);
        var template = Assert.Single(engine.Containers.Values);
        Assert.Equal("template", template.Request.GetProperty("Labels").GetProperty("teammates.warm_pool").GetString());
        Assert.True(template.Paused); Assert.Empty(template.Request.GetProperty("Env").EnumerateArray());
        Assert.Empty(template.Request.GetProperty("HostConfig").GetProperty("Binds").EnumerateArray());
        var id = new ComputerId(Guid.NewGuid().ToString());
        var spec = new CreateComputerSpec(id, "local", "owner-a", "test-image", IsolationClass.Docker, new ResourceLimits(0, 0, 0, 256), "", new Dictionary<string, string>());
        await provider.CreateComputerAsync(spec, new IdempotencyKey("create"), cancel.Token);
        Assert.Contains(template.Id, engine.Removed);
        var assigned = engine.Containers.Values.Single(x => x.Request.GetProperty("Labels").TryGetProperty("teammates.computer_id", out _));
        Assert.Equal("owner-a", assigned.Request.GetProperty("Labels").GetProperty("teammates.owner_id").GetString());
        var binds = assigned.Request.GetProperty("HostConfig").GetProperty("Binds").EnumerateArray().Select(x => x.GetString()).ToArray();
        Assert.Equal(2, binds.Length); Assert.All(binds, x => Assert.Contains(id.Value.Replace("-", ""), x!));
        Assert.Contains(stages, x => x.Name == "computer_create_ms" && x.Path == "pool");
        Assert.Contains(stages, x => x.Name == "computer_unpause_ms" && x.Path == "pool");
        Assert.Contains(stages, x => x.Name == "computer_chrome_healthy_ms" && x.Path == "pool");
        Assert.Contains(stages, x => x.Name == "warm_pool_ready_ms" && x.Path == "pool");
        assigned.Paused = true;
        await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => provider.PrewarmExistingAsync(id, "owner-a", cancel.Token)));
        Assert.Equal(1, assigned.Unpauses);
        Assert.Single(stages, x => x.Name == "wake_paused_ms" && x.Path == "unpause");
        Assert.All(stages, x => Assert.True(double.IsFinite(x.Ms) && x.Ms >= 0));
        Assert.Contains("/json/version", desktop.Probes);
        await Assert.ThrowsAsync<ComputeException>(() => provider.PrewarmExistingAsync(id, "owner-b", cancel.Token));
        var before = engine.Containers.Count;
        await Assert.ThrowsAsync<ComputeException>(() => provider.PrewarmExistingAsync(new ComputerId("missing"), "owner-a", cancel.Token));
        Assert.Equal(before, engine.Containers.Count);
        cancel.Cancel(); await pool;
        Assert.Equal(0, provider.WarmPoolCount);
        await provider.DeleteComputerAsync(id, new DeleteOptions(false), new IdempotencyKey("delete"), CancellationToken.None);
    }

    [Fact]
    public async Task ResumeWaitsForChromeAndDoesNotRecordSuccessOnDeadline()
    {
        await using var engine = new MockDockerEngine();
        var desktop = new MockDockerEngine.DesktopHandler();
        await using var provider = new DockerComputeProvider(new DockerComputeOptions { Stack = "speed-contract", NetworkName = "speed-contract-computers", ReadinessDeadline = TimeSpan.FromMilliseconds(100) },
            new MockDockerEngine.NoSecrets(), new MockDockerEngine.NoSnapshots(), computerHttpHandler: desktop, dockerClient: engine.Client);
        var stages = new List<string>(); provider.RecordPerformance = (name, _, _) => stages.Add(name);
        var id = new ComputerId(Guid.NewGuid().ToString());
        await provider.CreateComputerAsync(new(id, "local", "owner", "test", IsolationClass.Docker, new(0, 0, 0, 256), "", new Dictionary<string, string>()), new("create"), CancellationToken.None);
        var assigned = Assert.Single(engine.Containers.Values); assigned.Running = false;
        stages.Clear(); desktop.Healthy = false;
        var error = await Assert.ThrowsAsync<ComputeException>(() => provider.PrewarmExistingAsync(id, "owner", CancellationToken.None));
        Assert.True(error.IsRecovering);
        Assert.DoesNotContain("wake_paused_ms", stages); Assert.DoesNotContain("computer_chrome_healthy_ms", stages);
        desktop.Healthy = true;
        // A failed readiness probe must invalidate the old marker before a retry.
        await provider.PrewarmExistingAsync(id, "owner", CancellationToken.None);
        Assert.True(provider.IsComputerReady(id));
    }
    [Fact]
    public async Task DisabledPoolReapsStaleTemplatesOnlyFromItsOwnStack()
    {
        await using var engine = new MockDockerEngine();
        foreach (var stack in new[] { "speed-contract", "other-stack" })
        {
            var request = JsonSerializer.SerializeToElement(new { Labels = new Dictionary<string, string>
                { ["teammates.managed"] = "1", ["teammates.stack"] = stack, ["teammates.warm_pool"] = "template" } });
            engine.Containers[stack] = new MockDockerEngine.Container(stack, stack, request) { Running = true, Paused = true };
        }
        await using var provider = new DockerComputeProvider(new DockerComputeOptions { Stack = "speed-contract", WarmPoolSize = 0 },
            new MockDockerEngine.NoSecrets(), new MockDockerEngine.NoSnapshots(), dockerClient: engine.Client);
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        var run = provider.RunWarmPoolAsync(cancel.Token);
        while (!engine.Removed.Contains("speed-contract")) await Task.Delay(10, cancel.Token);
        cancel.Cancel(); await run;
        Assert.False(engine.Containers.ContainsKey("speed-contract")); Assert.True(engine.Containers.ContainsKey("other-stack"));
        Assert.Equal(0, provider.WarmPoolCount);
    }

    [Theory]
    [InlineData(1, int.MaxValue, "no computer capacity")]
    [InlineData(2, 1, "owner computer quota")]
    public async Task ResumeCannotExceedHostOrOwnerActiveSlots(int max, int ownerLimit, string reason)
    {
        await using var engine = new MockDockerEngine();
        await using var provider = new DockerComputeProvider(new DockerComputeOptions { MaxComputers = max, NetworkName = "speed-contract-computers", Stack = "speed-contract" },
            new MockDockerEngine.NoSecrets(), new MockDockerEngine.NoSnapshots(), computerHttpHandler: new MockDockerEngine.DesktopHandler(), dockerClient: engine.Client);
        var first = new ComputerId(Guid.NewGuid().ToString()); var second = new ComputerId(Guid.NewGuid().ToString());
        foreach (var id in new[] { first, second })
        {
            await provider.CreateComputerAsync(new(id, "local", "owner", "test", IsolationClass.Docker, new(0, 0, 0, 256), "", new Dictionary<string, string>()), new("create-" + id.Value), CancellationToken.None);
            if (id == first) await provider.StopComputerAsync(id, new(false, TimeSpan.FromSeconds(1)), new("stop"), CancellationToken.None);
        }
        var error = await Assert.ThrowsAsync<ComputeException>(() => provider.PrewarmExistingAsync(first, "owner", CancellationToken.None, ownerLimit));
        Assert.Equal(ComputeErrorCode.ResourceExhausted, error.Code); Assert.Equal(reason, error.Message);
        var stopped = engine.Containers.Values.Single(x => x.Request.GetProperty("Labels").GetProperty("teammates.computer_id").GetString() == first.Value);
        Assert.False(stopped.Running);
    }

}
