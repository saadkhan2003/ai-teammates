namespace Teammates.Compute;

/// <summary>Disposable, unassigned templates. All allocations and refills share one capacity gate.</summary>
public sealed class WarmTemplatePool(int size, int max, Func<int> assigned,
    Func<CancellationToken, Task<string>> create, Func<string, CancellationToken, Task> destroy)
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly SemaphoreSlim refill = new(0, 1);
    private readonly List<string> members = [];
    public int Count => Volatile.Read(ref count);
    private int count;

    public async Task<T> AllocateAsync<T>(bool existing, Func<bool, Task<T>> allocate, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            if (!existing && assigned() >= max) throw ComputeException.ResourceExhausted("no computer capacity");
            var claimed = !existing && members.Count > 0;
            if (claimed) await RemoveAsync(members[0], ct);
            // A template is destroyed before the caller binds fresh, owner-specific volumes.
            return await allocate(claimed);
        }
        finally { gate.Release(); if (refill.CurrentCount == 0) { try { refill.Release(); } catch (SemaphoreFullException) { } } }
    }

    public async Task RefillAsync(CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            while (members.Count < Math.Max(0, size) && assigned() + members.Count < max)
            {
                members.Add(await create(ct));
                Volatile.Write(ref count, members.Count);
            }
        }
        finally { gate.Release(); }
    }

    public async Task RunAsync(Action<Exception> failed, CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                try { await RefillAsync(ct); }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
                catch (Exception ex) { failed(ex); }
                await refill.WaitAsync(TimeSpan.FromSeconds(2), ct);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        finally { await ReapAsync(CancellationToken.None); }
    }

    public async Task ReapAsync(CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try { foreach (var id in members.ToArray()) await RemoveAsync(id, ct); }
        finally { gate.Release(); }
    }

    private async Task RemoveAsync(string id, CancellationToken ct)
    {
        await destroy(id, ct);
        members.Remove(id);
        Volatile.Write(ref count, members.Count);
    }
}
