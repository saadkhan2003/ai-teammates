using System.Diagnostics;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Docker.DotNet.Models;
using Teammates.Api;
using Teammates.Compute;

namespace Teammates.UnitTests;

public class SpeedComputeTests
{
    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => Now;
    }
    private static PrewarmRequest Request(Guid? owner = null, ComputerId? computer = null) => new(owner ?? Guid.NewGuid(), Guid.NewGuid(), computer ?? new ComputerId(Guid.NewGuid().ToString()));

    [Fact]
    public void PrewarmThrottlesPerBotAndCoalescesSharedComputer()
    {
        var clock = new Clock(); var queue = new PrewarmQueue(clock); var request = Request();
        Assert.Equal(PrewarmAdmission.Accepted, queue.TrySchedule(request));
        Assert.Equal(PrewarmAdmission.Duplicate, queue.TrySchedule(request));
        Assert.Equal(PrewarmAdmission.Duplicate, queue.TrySchedule(Request(request.Owner, request.Computer)));
        clock.Now += TimeSpan.FromSeconds(31);
        // A wake that is still in flight remains coalesced beyond the throttle window.
        Assert.Equal(PrewarmAdmission.Duplicate, queue.TrySchedule(request));
    }

    [Fact]
    public async Task PrewarmAllowsNewAttemptAfterThirtySecondsAndCleansFailedWork()
    {
        var clock = new Clock(); var queue = new PrewarmQueue(clock); var request = Request();
        Assert.Equal(PrewarmAdmission.Accepted, queue.TrySchedule(request));
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        var attempts = 0;
        var failed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var runner = queue.RunAsync((_, _) => { Interlocked.Increment(ref attempts); throw new IOException("test failure"); }, _ => failed.TrySetResult(), cancel.Token);
        await failed.Task.WaitAsync(cancel.Token);
        cancel.Cancel(); await runner;
        Assert.Equal(PrewarmAdmission.Duplicate, queue.TrySchedule(request));
        clock.Now += TimeSpan.FromSeconds(30);
        Assert.Equal(PrewarmAdmission.Accepted, queue.TrySchedule(request));
        Assert.True(attempts >= 1);
    }

    [Fact]
    public void PrewarmHasPerOwnerLimitAndBoundedQueue()
    {
        var clock = new Clock(); var queue = new PrewarmQueue(clock); var owner = Guid.NewGuid();
        for (var i = 0; i < 12; i++) Assert.Equal(PrewarmAdmission.Accepted, queue.TrySchedule(Request(owner)));
        Assert.Equal(PrewarmAdmission.RateLimited, queue.TrySchedule(Request(owner)));
        clock.Now += TimeSpan.FromMinutes(1);
        Assert.Equal(PrewarmAdmission.Accepted, queue.TrySchedule(Request(owner)));
        var bounded = new PrewarmQueue();
        for (var i = 0; i < 128; i++) Assert.Equal(PrewarmAdmission.Accepted, bounded.TrySchedule(Request()));
        Assert.Equal(PrewarmAdmission.Busy, bounded.TrySchedule(Request()));
    }

    [Fact]
    public void PrewarmRejectsAnonymousOtherOwnerZeroQuotaAndPolicyAskOrDeny()
    {
        var owner = Guid.NewGuid(); var policy = new UserPolicy();
        Assert.Equal(401, ComputerPrewarmService.Authorize(null, owner, 1, policy, []));
        Assert.Equal(403, ComputerPrewarmService.Authorize(Guid.NewGuid(), owner, 1, policy, []));
        Assert.Equal(403, ComputerPrewarmService.Authorize(owner, null, 1, policy, []));
        Assert.Equal(403, ComputerPrewarmService.Authorize(owner, owner, 0, policy, []));
        Assert.Equal(202, ComputerPrewarmService.Authorize(owner, owner, 1, policy, []));
        foreach (var mode in new[] { PolicyEngine.Ask, PolicyEngine.Deny })
        {
            policy.Classes[ActionClasses.Write] = mode;
            Assert.Equal(403, ComputerPrewarmService.Authorize(owner, owner, 1, policy, []));
        }
        Assert.Equal(403, ComputerPrewarmService.Authorize(owner, owner, 1, new UserPolicy(), [new DenyRule("no-wake", "computer.prewarm", false)]));
    }

    [Fact]
    public void WarmTemplatePreservesIsolationButHasNoOwnerMountsOrCredential()
    {
        var provider = (DockerComputeProvider)RuntimeHelpers.GetUninitializedObject(typeof(DockerComputeProvider));
        typeof(DockerComputeProvider).GetField("_options", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(provider,
            new DockerComputeOptions { Stack = "speed-contract", NetworkName = "speed-contract-computers" });
        var request = (CreateContainerParameters)typeof(DockerComputeProvider).GetMethod("BuildWarmTemplate", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(provider, ["pool-test"] )!;
        Assert.Equal("speed-contract", request.Labels["teammates.stack"]);
        Assert.Equal("1", request.Labels["teammates.managed"]);
        Assert.Equal("template", request.Labels["teammates.warm_pool"]);
        Assert.False(request.Labels.ContainsKey("teammates.owner_id"));
        Assert.False(request.Labels.ContainsKey("teammates.computer_id"));
        Assert.Empty(request.Env); Assert.Empty(request.HostConfig.Binds); Assert.Empty(request.HostConfig.CapAdd);
        Assert.True(request.HostConfig.ReadonlyRootfs);
        Assert.Contains("ALL", request.HostConfig.CapDrop);
        Assert.Contains("no-new-privileges:true", request.HostConfig.SecurityOpt);
        Assert.Equal("speed-contract-computers", request.HostConfig.NetworkMode);
        Assert.Empty(request.HostConfig.PortBindings ?? new Dictionary<string, IList<PortBinding>>());
        Assert.Contains("exec sleep infinity", request.Entrypoint);
        Assert.Equal(["NONE"], request.Healthcheck.Test);
    }

    [Theory]
    [InlineData(0, 50)] [InlineData(1, 100)] [InlineData(2, 200)] [InlineData(3, 250)] [InlineData(100, 250)]
    public void ReadinessIntervalsAreBounded(int attempt, int expected) => Assert.Equal(expected, AdaptiveReadiness.Interval(attempt).TotalMilliseconds);

    [Fact]
    public async Task ReadinessReturnsImmediatelyWhenHealthyAndHonorsDeadlineAndCancellation()
    {
        var calls = 0;
        await AdaptiveReadiness.WaitAsync(_ => { calls++; return Task.FromResult(true); }, TimeSpan.FromSeconds(1), CancellationToken.None);
        Assert.Equal(1, calls);
        var clock = Stopwatch.StartNew();
        var error = await Assert.ThrowsAsync<ComputeException>(() => AdaptiveReadiness.WaitAsync(async ct => { await Task.Delay(Timeout.Infinite, ct); return false; }, TimeSpan.FromMilliseconds(40), CancellationToken.None));
        Assert.True(error.IsRecovering); Assert.True(clock.Elapsed < TimeSpan.FromSeconds(1));
        using var cancel = new CancellationTokenSource(); cancel.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => AdaptiveReadiness.WaitAsync(async ct => { await Task.Delay(100, ct); return false; }, TimeSpan.FromSeconds(5), cancel.Token));
    }

    [Fact]
    public async Task AdaptiveProbeObservesReadyWithinNextInterval()
    {
        var calls = new List<long>(); var clock = Stopwatch.StartNew();
        await AdaptiveReadiness.WaitAsync(_ => { calls.Add(clock.ElapsedMilliseconds); return Task.FromResult(calls.Count == 4); }, TimeSpan.FromSeconds(3), CancellationToken.None);
        Assert.Equal(4, calls.Count);
        Assert.InRange(calls[1] - calls[0], 35, 350);
        Assert.InRange(calls[2] - calls[1], 80, 400);
        Assert.InRange(calls[3] - calls[2], 170, 500);
    }

    [Fact]
    public void SpeedDashboardUsesTheComputeStageNames()
    {
        Assert.Contains(SpeedTelemetry.Targets, x => x.Key == "wake_paused_ms" && x.P95 == 2000);
        Assert.Contains(SpeedTelemetry.Targets, x => x.Key == "warm_pool_ready_ms" && x.P95 == 5000);
        Assert.Contains("webSocketDebuggerUrl", ComputerReadiness.ProbeScript);
    }
}
