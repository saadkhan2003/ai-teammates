using System.Text;
using Teammates.Compute;

namespace Teammates.Compute.ContractTests;

[Collection("compute-contract")]
public class Scenarios
{
    public static IEnumerable<object[]> Kinds()
    {
        yield return ["fake"];
        if (string.Equals(Environment.GetEnvironmentVariable("COMPUTE_CONTRACT_DOCKER"), "1", StringComparison.Ordinal))
            yield return ["docker"];
    }

    [Theory]
    [MemberData(nameof(Kinds))]
    public async Task Scenario01_CreateAndGetMatch(string kind)
    {
        await using var provider = Open(kind);
        var id = NewId();
        var created = await provider.Create(id);
        var fetched = await provider.GetComputerAsync(id, CancellationToken.None);
        Assert.Equal(created.Id, fetched.Id);
        Assert.Equal(ComputerState.Running, fetched.State);
        await provider.Delete(id);
    }

    [Theory]
    [MemberData(nameof(Kinds))]
    public async Task Scenario02_IdempotentCreateAndConflict(string kind)
    {
        await using var provider = Open(kind);
        var id = NewId();
        var key = IdempotencyKey.Require("create-" + id.Value);
        var first = await provider.CreateComputerAsync(Spec(id, kind), key, CancellationToken.None);
        var second = await provider.CreateComputerAsync(Spec(id, kind), key, CancellationToken.None);
        Assert.Equal(first.Id, second.Id);
        var clash = Assert.Throws<ComputeException>(() => provider.CreateComputerAsync(Spec(id, kind) with { ImageRef = "other:dev" }, key, CancellationToken.None).GetAwaiter().GetResult());
        Assert.Equal(ComputeErrorCode.IdempotencyConflict, clash.Code);
        await provider.Delete(id);
    }

    [Theory]
    [MemberData(nameof(Kinds))]
    public async Task Scenario03_StartStopConverge(string kind)
    {
        await using var provider = Open(kind);
        var id = NewId();
        await provider.Create(id);
        var stopped = await provider.StopComputerAsync(id, new StopOptions(true, TimeSpan.Zero), IdempotencyKey.Require("stop-" + id.Value), CancellationToken.None);
        Assert.Equal(ComputerState.Stopped, stopped.State);
        var started = await provider.StartComputerAsync(id, IdempotencyKey.Require("start-" + id.Value), CancellationToken.None);
        Assert.Equal(ComputerState.Running, started.State);
        await provider.Delete(id);
    }

    [Theory]
    [MemberData(nameof(Kinds))]
    public async Task Scenario04_FileSurvivesStopStartRestart(string kind)
    {
        await using var provider = Open(kind);
        var id = NewId();
        await provider.Create(id);
        await provider.WaitReady(id);
        await provider.Write(id, "/workspace/durable.txt", "kept");
        await provider.StopComputerAsync(id, new StopOptions(true, TimeSpan.Zero), IdempotencyKey.Require("s-" + id.Value), CancellationToken.None);
        await provider.StartComputerAsync(id, IdempotencyKey.Require("u-" + id.Value), CancellationToken.None);
        await provider.WaitReady(id);
        Assert.Equal("kept", (await provider.Read(id, "/workspace/durable.txt")).Trim());
        await provider.RestartComputerAsync(id, IdempotencyKey.Require("r-" + id.Value), CancellationToken.None);
        await provider.WaitReady(id);
        Assert.Equal("kept", (await provider.Read(id, "/workspace/durable.txt")).Trim());
        await provider.Delete(id);
    }

    [Theory]
    [MemberData(nameof(Kinds))]
    public async Task Scenario05_RecreateKeepsVolume(string kind)
    {
        await using var provider = Open(kind);
        var id = NewId();
        await provider.Create(id);
        await provider.WaitReady(id);
        await provider.Write(id, "/workspace/volume.txt", "volume");
        var recreated = await provider.RecreateComputerAsync(id, new RecreateOptions(null), IdempotencyKey.Require("re-" + id.Value), CancellationToken.None);
        Assert.Equal(ComputerState.Running, recreated.State);
        await provider.WaitReady(id);
        Assert.Equal("volume", (await provider.Read(id, "/workspace/volume.txt")).Trim());
        await provider.Delete(id);
    }

    [Theory]
    [MemberData(nameof(Kinds))]
    public async Task Scenario06_DeleteTwice(string kind)
    {
        await using var provider = Open(kind);
        var id = NewId();
        await provider.Create(id);
        await provider.Write(id, "/workspace/gone.txt", "x");
        await provider.DeleteComputerAsync(id, new DeleteOptions(false), IdempotencyKey.Require("d1-" + id.Value), CancellationToken.None);
        await provider.DeleteComputerAsync(id, new DeleteOptions(false), IdempotencyKey.Require("d2-" + id.Value), CancellationToken.None);
        var fetched = await provider.GetComputerAsync(id, CancellationToken.None);
        Assert.Equal(ComputerState.Deleted, fetched.State);
    }

    [Theory]
    [MemberData(nameof(Kinds))]
    public async Task Scenario07_ConcurrentLifecycleConflicts(string kind)
    {
        await using var provider = Open(kind);
        var id = NewId();
        await provider.Create(id);
        var stopping = provider.StopComputerAsync(id, new StopOptions(false, TimeSpan.FromSeconds(2)), IdempotencyKey.Require("slow-" + id.Value), CancellationToken.None);
        await Task.Delay(100);
        var conflict = await Assert.ThrowsAsync<ComputeException>(() => provider.StartComputerAsync(id, IdempotencyKey.Require("other-" + id.Value), CancellationToken.None));
        Assert.Equal(ComputeErrorCode.Conflict, conflict.Code);
        await stopping;
        await provider.Delete(id);
    }

    [Theory]
    [MemberData(nameof(Kinds))]
    public async Task Scenario08_ExecStreamExitTimeoutTruncation(string kind)
    {
        await using var provider = Open(kind);
        var id = NewId();
        await provider.Create(id);
        await provider.WaitReady(id);
        var ok = await provider.Run(id, ["python3", "-c", "print('pong')"], TimeSpan.FromSeconds(15), 100_000, "ok-" + id.Value);
        Assert.Contains(ok, item => item is ExecExited exited && exited.ExitCode == 0);
        Assert.Contains("pong", Text(ok));
        var timed = await provider.Run(id, ["python3", "-c", "import time; time.sleep(30)"], TimeSpan.FromMilliseconds(400), 100_000, "to-" + id.Value);
        Assert.Contains(timed, item => item is ExecError error && error.Code == ComputeErrorCode.DeadlineExceeded);
        var truncated = await provider.Run(id, ["python3", "-c", "print('abcdefghijklmnopqrstuvwxyz')"], TimeSpan.FromSeconds(10), 8, "tr-" + id.Value);
        Assert.Contains(truncated, item => item is ExecExited exited && exited.OutputTruncated);
        await provider.Delete(id);
    }

    [Theory]
    [MemberData(nameof(Kinds))]
    public async Task Scenario09_ExecRetryDoesNotRerun(string kind)
    {
        await using var provider = Open(kind);
        var id = NewId();
        await provider.Create(id);
        await provider.WaitReady(id);
        var key = "once-" + id.Value;
        var argv = new[] { "python3", "-c", "import pathlib; p=pathlib.Path('/workspace/count.txt'); p.write_text(str(int(p.read_text())+1) if p.exists() else '1')" };
        await provider.Run(id, argv, TimeSpan.FromSeconds(15), 100_000, key);
        await provider.Run(id, argv, TimeSpan.FromSeconds(15), 100_000, key);
        Assert.Equal("1", (await provider.Read(id, "/workspace/count.txt")).Trim());
        await provider.Delete(id);
    }

    [Theory]
    [MemberData(nameof(Kinds))]
    public async Task Scenario10_SecretEnvIsRedacted(string kind)
    {
        await using var provider = Open(kind);
        var id = NewId();
        await provider.Create(id);
        await provider.WaitReady(id);
        var spec = new ExecSpec(id, ["python3", "-c", "import os; print(os.environ['REGISTRY_TOKEN'])"], "/workspace", new Dictionary<string, string>(), [new SecretEnvBinding("REGISTRY_TOKEN", "secret://project/registry", "g")], "", TimeSpan.FromSeconds(15), 100_000, false);
        var events = new List<ExecEvent>();
        await foreach (var item in provider.ExecAsync(spec, IdempotencyKey.Require("sec-" + id.Value), CancellationToken.None))
            events.Add(item);
        var text = Text(events);
        Assert.DoesNotContain("RegistryTokenCanary9911", text);
        Assert.Contains("[REDACTED]", text);
        await provider.Delete(id);
    }

    [Theory]
    [MemberData(nameof(Kinds))]
    public async Task Scenario11_DesktopSessionRules(string kind)
    {
        await using var provider = Open(kind);
        var id = NewId();
        await provider.Create(id);
        var view = await provider.GetDesktopSessionAsync(id, new DesktopAccess(DesktopMode.View, 1, TimeSpan.FromMinutes(2), false), CancellationToken.None);
        Assert.False(string.IsNullOrWhiteSpace(view.Token));
        var endpoint = provider.RequireSession(view.Token, DateTimeOffset.UtcNow);
        Assert.Equal(5900, endpoint.Port);
        await Assert.ThrowsAsync<ComputeException>(() => provider.GetDesktopSessionAsync(id, new DesktopAccess(DesktopMode.Interactive, 1, TimeSpan.FromMinutes(1), false), CancellationToken.None));
        var interactive = await provider.GetDesktopSessionAsync(id, new DesktopAccess(DesktopMode.Interactive, 2, TimeSpan.FromMilliseconds(50), true), CancellationToken.None);
        Assert.Equal(6900, interactive.Port);
        await Task.Delay(80);
        Assert.Throws<ComputeException>(() => provider.RequireSession(interactive.Token, DateTimeOffset.UtcNow));
        await Assert.ThrowsAsync<ComputeException>(() => provider.GetDesktopSessionAsync(id, new DesktopAccess(DesktopMode.View, 1, TimeSpan.FromMinutes(1), false), CancellationToken.None));
        await provider.Delete(id);
    }

    [Theory]
    [MemberData(nameof(Kinds))]
    public async Task Scenario12_SnapshotRestore(string kind)
    {
        await using var provider = Open(kind);
        var id = NewId();
        await provider.Create(id);
        await provider.WaitReady(id);
        await provider.Write(id, "/workspace/snap.txt", "before");
        var snapshot = await provider.SnapshotAsync(id, new SnapshotOptions("label"), IdempotencyKey.Require("sn-" + id.Value), CancellationToken.None);
        await provider.Write(id, "/workspace/snap.txt", "after");
        await provider.RestoreAsync(id, snapshot.Id, IdempotencyKey.Require("rs-" + id.Value), CancellationToken.None);
        await provider.WaitReady(id);
        Assert.Equal("before", (await provider.Read(id, "/workspace/snap.txt")).Trim());
        await provider.Delete(id);
    }

    [Fact]
    public async Task Scenario13_CapacityAndExhaustion()
    {
        var root = Path.Combine(Path.GetTempPath(), "tm-cap-" + Guid.NewGuid().ToString("n"));
        var provider = new FakeComputeProvider(new FakeComputeOptions { MaxComputers = 1, Root = root }, Secrets(), Store(root));
        var capacity = await provider.GetCapacityAsync(new CapacityQuery(IsolationClass.Docker), CancellationToken.None);
        Assert.Equal(1u, capacity.ComputersMax);
        var first = NewId();
        await provider.CreateComputerAsync(Spec(first, "fake"), IdempotencyKey.Require("cap-" + first.Value), CancellationToken.None);
        var second = NewId();
        var denied = await Assert.ThrowsAsync<ComputeException>(() => provider.CreateComputerAsync(Spec(second, "fake"), IdempotencyKey.Require("cap-" + second.Value), CancellationToken.None));
        Assert.Equal(ComputeErrorCode.ResourceExhausted, denied.Code);
    }

    [Fact]
    public async Task Scenario14_HealthUnavailable()
    {
        var root = Path.Combine(Path.GetTempPath(), "tm-health-" + Guid.NewGuid().ToString("n"));
        var fake = new FakeComputeProvider(new FakeComputeOptions { DockerAvailable = false, Root = root }, Secrets(), Store(root));
        var missing = await Assert.ThrowsAsync<ComputeException>(() => fake.HealthCheckAsync(CancellationToken.None));
        Assert.Equal(ComputeErrorCode.Unavailable, missing.Code);
        var docker = new DockerComputeProvider(new DockerComputeOptions { DockerHost = "tcp://127.0.0.1:1", MaxComputers = 1 }, Secrets(), Store(root + "-d"));
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        var down = await Assert.ThrowsAsync<ComputeException>(() => docker.HealthCheckAsync(deadline.Token));
        Assert.Equal(ComputeErrorCode.Unavailable, down.Code);
        await docker.DisposeAsync();
    }

    [Theory]
    [MemberData(nameof(Kinds))]
    public async Task Scenario15_DiskQuotaRejectsOverflowAndReportsUsage(string kind)
    {
        await using var provider = Open(kind);
        var id = NewId();
        var quota = 128UL * 1024 * 1024;
        var spec = Spec(id, kind) with { Limits = new ResourceLimits(500, 512UL * 1024 * 1024, quota, 256) };
        await provider.CreateComputerAsync(spec, IdempotencyKey.Require("dq-" + id.Value), CancellationToken.None);
        await provider.WaitReady(id);
        await provider.Write(id, "/workspace/quota-ok.txt", "ok");
        var script = "f=open('/workspace/fill','wb')\nchunk=b'x'*(1024*1024)\nleft=160\nwhile left:\n f.write(chunk)\n left-=1\n";
        var big = await provider.Run(id, ["python3", "-c", script], TimeSpan.FromSeconds(90), 200_000, "big-" + id.Value);
        var exit = big.OfType<ExecExited>().LastOrDefault();
        Assert.NotNull(exit);
        Assert.NotEqual(0, exit!.ExitCode);
        Assert.Contains("No space", Text(big), StringComparison.OrdinalIgnoreCase);
        var metrics = await provider.GetMetricsAsync(id, CancellationToken.None);
        Assert.True(metrics.DiskUsedBytes > 0, "disk usage was not reported");
        Assert.True(metrics.DiskUsedBytes <= quota, $"used {metrics.DiskUsedBytes} over quota {quota}");
        await provider.Delete(id);
    }

    [Theory]
    [MemberData(nameof(Kinds))]
    public async Task Scenario16_SecondDisplaySharesFencingAndLease(string kind)
    {
        await using var provider = Open(kind);
        var id = NewId();
        await provider.Create(id);
        await provider.WaitReady(id);
        var displays = await provider.Displays(id);
        Assert.Equal(new[] { 1, 2 }, displays.Select(d => d.Display));
        Assert.False(displays[1].Ready);
        var primary = await provider.GetDesktopSessionAsync(id, new DesktopAccess(DesktopMode.View, 1, TimeSpan.FromMinutes(1), false), CancellationToken.None);
        var second = await provider.GetDesktopSessionAsync(id, new DesktopAccess(DesktopMode.View, 1, TimeSpan.FromMinutes(1), false, 2), CancellationToken.None);
        Assert.Equal(5900, primary.Port);
        Assert.Equal(5901, second.Port);
        Assert.True((await provider.Displays(id))[1].Ready);
        await Assert.ThrowsAsync<ComputeException>(() => provider.GetDesktopSessionAsync(id, new DesktopAccess(DesktopMode.Interactive, 1, TimeSpan.FromMinutes(1), false, 2), CancellationToken.None));
        var interactive = await provider.GetDesktopSessionAsync(id, new DesktopAccess(DesktopMode.Interactive, 2, TimeSpan.FromMinutes(1), true, 2), CancellationToken.None);
        Assert.Equal(6901, interactive.Port);
        Assert.Throws<ComputeException>(() => provider.RequireSession(primary.Token, DateTimeOffset.UtcNow));
        Assert.Throws<ComputeException>(() => provider.RequireSession(second.Token, DateTimeOffset.UtcNow));
        await Assert.ThrowsAsync<ComputeException>(() => provider.GetDesktopSessionAsync(id, new DesktopAccess(DesktopMode.View, 2, TimeSpan.FromMinutes(1), false, 3), CancellationToken.None));
        await provider.RestartComputerAsync(id, IdempotencyKey.Require("display-restart-" + id.Value), CancellationToken.None);
        await provider.WaitReady(id);
        Assert.False((await provider.Displays(id))[1].Ready);
        await provider.Delete(id);
    }

    [Fact]
    public void ComputerDnsDefaultsAndValidation()
    {
        Assert.Equal(new[] { "1.1.1.1", "8.8.8.8" }, new DockerComputeOptions { ComputerDns = "1.1.1.1,8.8.8.8" }.DnsServers());
        Assert.Equal(new[] { "10.0.0.2" }, new DockerComputeOptions { ComputerDns = "10.0.0.2, 10.0.0.2" }.DnsServers());
        foreach (var raw in new[] { "", "1.1.1.1,", "::1", "example.com", "10.0.0.0/8", "127.1" })
            Assert.Throws<ComputeException>(() => new DockerComputeOptions { ComputerDns = raw }.DnsServers());
    }

    [Fact]
    public async Task DockerCreateSetsExplicitDnsWithoutCallingDaemon()
    {
        var root = Path.Combine(Path.GetTempPath(), "tm-dns-" + Guid.NewGuid().ToString("n"));
        await using var provider = new DockerComputeProvider(new DockerComputeOptions { ComputerDns = "10.0.0.2,1.1.1.1" }, Secrets(), Store(root));
        var build = typeof(DockerComputeProvider).GetMethod("BuildCreate", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
        var create = (Docker.DotNet.Models.CreateContainerParameters)build.Invoke(provider,
            new object?[] { Spec(NewId(), "fake"), "dns-test", "workspace", "profile", false, 0UL, null })!;
        Assert.Equal(new[] { "10.0.0.2", "1.1.1.1" }, create.HostConfig.DNS);
        Assert.DoesNotContain(create.HostConfig.DNS, x => x == "127.0.0.11");
        Assert.Contains("COMPUTER_SECOND_DISPLAY=true", create.Env);
    }

    [Fact]
    public async Task FakeCanDisableTheSecondaryDisplay()
    {
        var root = Path.Combine(Path.GetTempPath(), "tm-display-" + Guid.NewGuid().ToString("n"));
        var provider = new FakeComputeProvider(new FakeComputeOptions { Root = root, SecondDisplay = false }, Secrets(), Store(root));
        var id = NewId();
        await provider.CreateComputerAsync(Spec(id, "fake"), IdempotencyKey.Require("create-" + id.Value), CancellationToken.None);
        Assert.Single(await provider.ListDisplaysAsync(id, CancellationToken.None));
        var error = await Assert.ThrowsAsync<ComputeException>(() => provider.GetDesktopSessionAsync(id,
            new DesktopAccess(DesktopMode.View, 1, TimeSpan.FromMinutes(1), false, 2), CancellationToken.None));
        Assert.Equal(ComputeErrorCode.InvalidArgument, error.Code);
        await provider.DeleteComputerAsync(id, new DeleteOptions(false), IdempotencyKey.Require("delete-" + id.Value), CancellationToken.None);
    }

    private static Harness Open(string kind) => new(kind);

    private static ComputerId NewId() => new(Guid.NewGuid().ToString());

    private static CreateComputerSpec Spec(ComputerId id, string kind) => new(
        id, "local", "owner-1",
        kind == "docker" ? Environment.GetEnvironmentVariable("COMPUTE_IMAGE") ?? "teammates-computer:dev" : "teammates-computer:dev",
        IsolationClass.Docker, new ResourceLimits(500, 512UL * 1024 * 1024, 0, 128), "",
        new Dictionary<string, string> { ["name"] = "contract" });

    private static MapSecretResolver Secrets() => new(new Dictionary<string, string> { ["secret://project/registry"] = "RegistryTokenCanary9911" });

    private static DirectorySnapshotStore Store(string root) => new(Path.Combine(root, "snaps"));

    private static string Text(IEnumerable<ExecEvent> events)
    {
        var builder = new StringBuilder();
        foreach (var item in events)
        {
            if (item is ExecStdout stdout) builder.Append(Encoding.UTF8.GetString(stdout.Data));
            if (item is ExecStderr stderr) builder.Append(Encoding.UTF8.GetString(stderr.Data));
        }
        return builder.ToString();
    }

    private sealed class Harness : IComputeProvider, IDesktopSessionAuthority, IAsyncDisposable
    {
        private readonly IComputeProvider _inner;
        private readonly IDesktopSessionAuthority _sessions;
        private readonly string _kind;

        public Harness(string kind)
        {
            _kind = kind;
            var root = Path.Combine(Path.GetTempPath(), "tm-contract-" + Guid.NewGuid().ToString("n"));
            var secrets = Secrets();
            var store = Store(root);
            if (kind == "fake")
            {
                var fake = new FakeComputeProvider(new FakeComputeOptions { Root = root }, secrets, store);
                _inner = fake;
                _sessions = fake;
            }
            else
            {
                var docker = new DockerComputeProvider(new DockerComputeOptions
                {
                    DockerHost = Environment.GetEnvironmentVariable("DOCKER_HOST") ?? "unix:///var/run/docker.sock",
                    ImageRef = Environment.GetEnvironmentVariable("COMPUTE_IMAGE") ?? "teammates-computer:dev",
                    SeccompPath = Environment.GetEnvironmentVariable("SECCOMP_PROFILE") ?? "/workspace/deploy/seccomp-chrome.json",
                    ComputerToken = "contract",
                    MaxComputers = 4
                }, secrets, store);
                _inner = docker;
                _sessions = docker;
            }
        }

        public Task<IReadOnlyList<ComputerDisplay>> Displays(ComputerId id) => ((IComputerDisplays)_inner).ListDisplaysAsync(id, CancellationToken.None);

        public Task<Computer> Create(ComputerId id) => CreateComputerAsync(Spec(id, _kind), IdempotencyKey.Require("c-" + id.Value), CancellationToken.None);

        public Task Delete(ComputerId id) => DeleteComputerAsync(id, new DeleteOptions(false), IdempotencyKey.Require("del-" + Guid.NewGuid().ToString("n")), CancellationToken.None);

        public async Task WaitReady(ComputerId id)
        {
            var deadline = DateTimeOffset.UtcNow.AddSeconds(_kind == "docker" ? 40 : 5);
            Exception? last = null;
            while (DateTimeOffset.UtcNow < deadline)
            {
                try
                {
                    var events = await Run(id, ["python3", "-c", "print('ready')"], TimeSpan.FromSeconds(8), 10_000, "ready-" + Guid.NewGuid().ToString("n"));
                    if (events.OfType<ExecExited>().Any(item => item.ExitCode == 0)) return;
                }
                catch (Exception ex) { last = ex; }
                await Task.Delay(500);
            }
            throw last ?? new TimeoutException("computer exec did not become ready");
        }

        public async Task Write(ComputerId id, string path, string content)
        {
            await Run(id, ["python3", "-c", "import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True, exist_ok=True); p.write_text(sys.argv[2])", path, content], TimeSpan.FromSeconds(15), 100_000, "w-" + Guid.NewGuid().ToString("n"));
        }

        public async Task<string> Read(ComputerId id, string path)
        {
            var events = await Run(id, ["python3", "-c", "import pathlib,sys; print(pathlib.Path(sys.argv[1]).read_text(), end='')", path], TimeSpan.FromSeconds(15), 100_000, "r-" + Guid.NewGuid().ToString("n"));
            return Text(events);
        }

        public async Task<List<ExecEvent>> Run(ComputerId id, string[] argv, TimeSpan timeout, ulong limit, string key)
        {
            var events = new List<ExecEvent>();
            var spec = new ExecSpec(id, argv, "/workspace", new Dictionary<string, string>(), [], "", timeout, limit, false);
            await foreach (var item in ExecAsync(spec, IdempotencyKey.Require(key), CancellationToken.None))
                events.Add(item);
            return events;
        }

        public Task<Computer> CreateComputerAsync(CreateComputerSpec spec, IdempotencyKey key, CancellationToken ct) => _inner.CreateComputerAsync(spec, key, ct);
        public Task<Computer> StartComputerAsync(ComputerId id, IdempotencyKey key, CancellationToken ct) => _inner.StartComputerAsync(id, key, ct);
        public Task<Computer> StopComputerAsync(ComputerId id, StopOptions options, IdempotencyKey key, CancellationToken ct) => _inner.StopComputerAsync(id, options, key, ct);
        public Task<Computer> RestartComputerAsync(ComputerId id, IdempotencyKey key, CancellationToken ct) => _inner.RestartComputerAsync(id, key, ct);
        public Task<Computer> RecreateComputerAsync(ComputerId id, RecreateOptions options, IdempotencyKey key, CancellationToken ct) => _inner.RecreateComputerAsync(id, options, key, ct);
        public Task DeleteComputerAsync(ComputerId id, DeleteOptions options, IdempotencyKey key, CancellationToken ct) => _inner.DeleteComputerAsync(id, options, key, ct);
        public Task<Computer> GetComputerAsync(ComputerId id, CancellationToken ct) => _inner.GetComputerAsync(id, ct);
        public Task<ComputerStatus> GetStatusAsync(ComputerId id, CancellationToken ct) => _inner.GetStatusAsync(id, ct);
        public Task<ComputerMetrics> GetMetricsAsync(ComputerId id, CancellationToken ct) => _inner.GetMetricsAsync(id, ct);
        public IAsyncEnumerable<ExecEvent> ExecAsync(ExecSpec spec, IdempotencyKey key, CancellationToken ct) => _inner.ExecAsync(spec, key, ct);
        public Task<DesktopSession> GetDesktopSessionAsync(ComputerId id, DesktopAccess access, CancellationToken ct) => _inner.GetDesktopSessionAsync(id, access, ct);
        public Task<Snapshot> SnapshotAsync(ComputerId id, SnapshotOptions options, IdempotencyKey key, CancellationToken ct) => _inner.SnapshotAsync(id, options, key, ct);
        public Task<Computer> RestoreAsync(ComputerId id, SnapshotId snapshot, IdempotencyKey key, CancellationToken ct) => _inner.RestoreAsync(id, snapshot, key, ct);
        public Task<Capacity> GetCapacityAsync(CapacityQuery query, CancellationToken ct) => _inner.GetCapacityAsync(query, ct);
        public Task<HealthReport> HealthCheckAsync(CancellationToken ct) => _inner.HealthCheckAsync(ct);
        public IAsyncEnumerable<ComputerStatusEvent> WatchStatusAsync(ComputerId id, CancellationToken ct) => _inner.WatchStatusAsync(id, ct);
        public IAsyncEnumerable<ComputerMetrics> WatchMetricsAsync(ComputerId id, TimeSpan interval, CancellationToken ct) => _inner.WatchMetricsAsync(id, interval, ct);
        public DesktopEndpoint RequireSession(string token, DateTimeOffset now) => _sessions.RequireSession(token, now);

        public async ValueTask DisposeAsync()
        {
            if (_inner is IAsyncDisposable disposable) await disposable.DisposeAsync();
        }
    }
}

[CollectionDefinition("compute-contract", DisableParallelization = true)]
public sealed class ContractCollection;
