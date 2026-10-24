using Teammates.Api;
using Teammates.Compute;

namespace Teammates.UnitTests;

public class ResourceBudgetTests
{
    [Fact]
    public void Suspends_only_when_idle_and_unwatched()
    {
        var now = DateTimeOffset.Parse("2026-10-22T12:00:00Z");
        var idle = TimeSpan.FromMinutes(10);

        Assert.False(ComputerPower.ShouldSuspend(now, now.AddMinutes(-30), now.AddMinutes(-1), busy: true, idle));
        Assert.False(ComputerPower.ShouldSuspend(now, now.AddMinutes(-30), now.AddMinutes(1), busy: false, idle));
        Assert.False(ComputerPower.ShouldSuspend(now, now.AddMinutes(-5), now.AddMinutes(-1), busy: false, idle));
        Assert.False(ComputerPower.ShouldSuspend(now, now.AddMinutes(-30), now.AddMinutes(-1), busy: false, TimeSpan.Zero));
        Assert.True(ComputerPower.ShouldSuspend(now, now.AddMinutes(-10), now, busy: false, idle));
        Assert.True(ComputerPower.ShouldSuspend(now, now.AddMinutes(-11), DateTimeOffset.MinValue, busy: false, idle));
    }

    [Fact]
    public void Hibernate_is_the_default_and_reclaim_waits_for_the_longer_window()
    {
        var now = DateTimeOffset.Parse("2026-10-22T12:00:00Z");
        var suspend = TimeSpan.FromMinutes(10);
        var later = TimeSpan.FromMinutes(30);
        Assert.Equal(IdlePowerMode.Hibernate, ComputerPower.ParseMode(null));
        Assert.Equal(IdlePowerMode.Hibernate, ComputerPower.ParseMode("nope"));
        Assert.Equal(IdlePowerMode.Reclaim, ComputerPower.ParseMode("reclaim"));
        Assert.Equal(IdlePowerMode.Pause, ComputerPower.ParseMode("pause"));
        Assert.True(ComputerPower.ShouldHibernate(IdlePowerMode.Hibernate, now, now.AddMinutes(-10), DateTimeOffset.MinValue, false, suspend, later));
        Assert.False(ComputerPower.ShouldHibernate(IdlePowerMode.Reclaim, now, now.AddMinutes(-10), DateTimeOffset.MinValue, false, suspend, later));
        Assert.True(ComputerPower.ShouldHibernate(IdlePowerMode.Reclaim, now, now.AddMinutes(-30), DateTimeOffset.MinValue, false, suspend, later));
        Assert.False(ComputerPower.ShouldHibernate(IdlePowerMode.Pause, now, now.AddMinutes(-60), DateTimeOffset.MinValue, false, suspend, later));
        Assert.False(DiskQuota.UseStorageOpt("overlayfs", "ext4"));
        Assert.False(DiskQuota.UseStorageOpt("overlay2", "ext4"));
        Assert.True(DiskQuota.UseStorageOpt("overlay2", "xfs"));
        Assert.False(DiskQuota.MountOnResume(true));
        Assert.True(DiskQuota.MountOnResume(false));
        Assert.Equal(128UL * 1024 * 1024, DiskQuota.Normalize(128UL * 1024 * 1024));
        Assert.Equal(DiskQuota.MinimumBytes, DiskQuota.Normalize(1024));
    }

    [Fact]
    public void Picks_two_computers_on_a_4gb_host_and_more_than_three_on_8gb()
    {
        Assert.Equal(2, HostBudget.MaxComputers(4L * 1024 * 1024 * 1024, null));
        Assert.Equal(2, HostBudget.MaxComputers(4L * 1000 * 1000 * 1000, ""));
        Assert.Equal(2, HostBudget.MaxComputers(5L * 1024 * 1024 * 1024, " "));
        Assert.Equal(5, HostBudget.MaxComputers(8L * 1024 * 1024 * 1024, null));
        Assert.Equal(4, HostBudget.MaxComputers(6L * 1024 * 1024 * 1024, null));
        Assert.Equal(10, HostBudget.MaxComputers(16L * 1024 * 1024 * 1024, null));
        Assert.Equal(42, HostBudget.MaxComputers(64L * 1024 * 1024 * 1024, null));
        Assert.Equal(64, HostBudget.MaxComputers(512L * 1024 * 1024 * 1024, null));
        Assert.True(HostBudget.MaxComputers(8L * 1024 * 1024 * 1024, null) > 3);
        Assert.Equal(2, HostBudget.MaxComputers(16L * 1024 * 1024 * 1024, "2"));
        Assert.Equal(4, HostBudget.MaxComputers(4L * 1024 * 1024 * 1024, "4"));
    }

    [Fact]
    public async Task Pulse_unblocks_a_waiter()
    {
        var signal = new TaskSignal();
        var waiting = signal.WaitHandle();
        Assert.False(waiting.IsCompleted);

        signal.Pulse();
        await waiting.WaitAsync(TimeSpan.FromSeconds(2));

        Assert.True(waiting.IsCompletedSuccessfully);
        Assert.False(signal.WaitHandle().IsCompleted);
    }
}
