using Teammates.Compute;

namespace Teammates.Compute.ContractTests;

public class SpeedLifecycleTests
{
    [Fact]
    public async Task PoolClaimDestroysTemplateRefillsAndNeverReusesReleasedComputer()
    {
        var assigned = 0; var serial = 0; var destroyed = new List<string>(); var created = new List<string>();
        var pool = new WarmTemplatePool(1, 3, () => assigned, _ => { var id = "template-" + ++serial; created.Add(id); return Task.FromResult(id); }, (id, _) => { destroyed.Add(id); return Task.CompletedTask; });
        await pool.RefillAsync(CancellationToken.None);
        Assert.Equal(1, pool.Count);
        await pool.AllocateAsync(false, claimed => { Assert.True(claimed); Assert.Contains("template-1", destroyed); assigned++; return Task.FromResult("owner-a"); }, CancellationToken.None);
        Assert.Equal(0, pool.Count);
        await pool.RefillAsync(CancellationToken.None);
        Assert.Equal(1, pool.Count);
        assigned--; // Caller destroys the released computer; it is never returned to this pool.
        await pool.AllocateAsync(false, claimed => { Assert.True(claimed); assigned++; return Task.FromResult("owner-b"); }, CancellationToken.None);
        Assert.Equal(new[] { "template-1", "template-2" }, destroyed);
        Assert.Equal(new[] { "template-1", "template-2" }, created);
        await pool.RefillAsync(CancellationToken.None);
        await pool.ReapAsync(CancellationToken.None);
        Assert.Equal(0, pool.Count); Assert.Equal(3, destroyed.Count);
    }

    [Fact]
    public async Task PoolCountsAgainstCapacityAndConcurrentAllocationsCannotOverbook()
    {
        var assigned = 0; var serial = 0;
        var pool = new WarmTemplatePool(2, 2, () => assigned, _ => Task.FromResult("t" + ++serial), (_, _) => Task.CompletedTask);
        await pool.RefillAsync(CancellationToken.None);
        Assert.Equal(2, pool.Count);
        var operations = Enumerable.Range(0, 3).Select(_ => Task.Run(async () =>
        {
            try { await pool.AllocateAsync(false, async claimed => { Assert.True(claimed); await Task.Delay(10); assigned++; return true; }, CancellationToken.None); return true; }
            catch (ComputeException ex) { Assert.Equal(ComputeErrorCode.ResourceExhausted, ex.Code); return false; }
        })).ToArray();
        var result = await Task.WhenAll(operations);
        Assert.Equal(2, result.Count(x => x)); Assert.Equal(0, pool.Count); Assert.Equal(2, assigned);
        await pool.RefillAsync(CancellationToken.None); Assert.Equal(0, pool.Count);
    }

    [Fact]
    public async Task FailedClaimCannotLeakOrReuseTemplateAndFailureRefillsLater()
    {
        var created = 0; var destroyed = new List<string>();
        var pool = new WarmTemplatePool(1, 2, () => 0, _ => Task.FromResult("t" + ++created), (id, _) => { destroyed.Add(id); return Task.CompletedTask; });
        await pool.RefillAsync(CancellationToken.None);
        await Assert.ThrowsAsync<IOException>(() => pool.AllocateAsync<string>(false, _ => throw new IOException("fresh create failed"), CancellationToken.None));
        Assert.Equal(0, pool.Count); Assert.Equal("t1", Assert.Single(destroyed));
        await pool.RefillAsync(CancellationToken.None); Assert.Equal(2, created);
        await pool.ReapAsync(CancellationToken.None);
    }

    [Fact]
    public async Task FailedDestroyRetainsCapacityAndDoesNotBindOwnerData()
    {
        var pool = new WarmTemplatePool(1, 1, () => 0, _ => Task.FromResult("template"), (_, _) => throw new IOException("daemon unavailable"));
        await pool.RefillAsync(CancellationToken.None);
        var bound = false;
        await Assert.ThrowsAsync<IOException>(() => pool.AllocateAsync(false, _ => { bound = true; return Task.FromResult(true); }, CancellationToken.None));
        Assert.False(bound); Assert.Equal(1, pool.Count);
    }

    [Fact]
    public async Task ExistingComputerDoesNotConsumePoolAndDefaultZeroCreatesNoTemplates()
    {
        var created = 0;
        var pool = new WarmTemplatePool(0, 1, () => 1, _ => { created++; return Task.FromResult("t"); }, (_, _) => Task.CompletedTask);
        await pool.RefillAsync(CancellationToken.None); Assert.Equal(0, created);
        await pool.AllocateAsync(true, claimed => { Assert.False(claimed); return Task.FromResult(true); }, CancellationToken.None);
        var error = await Assert.ThrowsAsync<ComputeException>(() => pool.AllocateAsync(false, _ => Task.FromResult(true), CancellationToken.None));
        Assert.Equal(ComputeErrorCode.ResourceExhausted, error.Code);
    }

    [Fact]
    public async Task BackgroundRefillAndShutdownReapAreAutomatic()
    {
        var created = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var destroyed = new List<string>();
        var pool = new WarmTemplatePool(1, 2, () => 0, _ => { created.TrySetResult(); return Task.FromResult("template"); }, (id, _) => { destroyed.Add(id); return Task.CompletedTask; });
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        var run = pool.RunAsync(_ => Assert.Fail("unexpected refill failure"), cancel.Token);
        await created.Task.WaitAsync(cancel.Token);
        cancel.Cancel(); await run;
        Assert.Equal("template", Assert.Single(destroyed)); Assert.Equal(0, pool.Count);
    }
}
