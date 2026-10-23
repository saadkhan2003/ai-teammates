namespace Teammates.Api;

/// <summary>
/// Wakes a worker that is waiting for a task. Pulse completes the current wait
/// so the lease call does not have to poll.
/// </summary>
public sealed class TaskSignal
{
    private readonly object _gate = new();
    private TaskCompletionSource<bool> _current = New();

    public Task WaitHandle()
    {
        lock (_gate) return _current.Task;
    }

    public void Pulse()
    {
        TaskCompletionSource<bool> previous;
        lock (_gate)
        {
            previous = _current;
            _current = New();
        }
        previous.TrySetResult(true);
    }

    private static TaskCompletionSource<bool> New() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);
}
