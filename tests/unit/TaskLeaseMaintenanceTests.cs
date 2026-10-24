using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Teammates.Api;

namespace Teammates.UnitTests;

public sealed class TaskLeaseMaintenanceTests
{
    [Fact]
    public async Task LeaseSweepsContinueWhileComputerMaintenanceIsBlocked()
    {
        var computerStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var sweptTwice = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        using var host = new HostBuilder().ConfigureServices(services =>
        {
            services.AddSingleton<IHostedService>(new BlockedComputerMaintenance(computerStarted));
            services.AddHostedService(_ => new TaskLeaseMaintenance(async ct =>
            {
                await computerStarted.Task.WaitAsync(ct);
                if (Interlocked.Increment(ref calls) >= 2) sweptTwice.TrySetResult();
            }, NullLogger<TaskLeaseMaintenance>.Instance, TimeSpan.FromMilliseconds(1)));
        }).Build();
        try
        {
            await host.StartAsync();
            await sweptTwice.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.True(calls >= 2);
        }
        finally { await host.StopAsync(); }
    }

    [Fact]
    public async Task FailedSweepDoesNotDisableLaterRecovery()
    {
        var recovered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        using var service = new TaskLeaseMaintenance(_ =>
        {
            if (Interlocked.Increment(ref calls) == 1) throw new InvalidOperationException("temporary database failure");
            recovered.TrySetResult();
            return Task.CompletedTask;
        }, NullLogger<TaskLeaseMaintenance>.Instance, TimeSpan.FromMilliseconds(1));
        try
        {
            await service.StartAsync(default);
            await recovered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.True(calls >= 2);
        }
        finally { await service.StopAsync(default); }
    }

    [Fact]
    public async Task ShutdownCancelsInFlightSweep()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var service = new TaskLeaseMaintenance(async ct =>
        {
            started.TrySetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, ct);
        }, NullLogger<TaskLeaseMaintenance>.Instance);
        await service.StartAsync(default);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await service.StopAsync(default).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(service.ExecuteTask!.IsCompletedSuccessfully);
    }

    private sealed class BlockedComputerMaintenance(TaskCompletionSource started) : BackgroundService
    {
        protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        {
            started.TrySetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, stoppingToken);
        }
    }
}
