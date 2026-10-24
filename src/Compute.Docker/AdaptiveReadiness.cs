using System.Diagnostics;

namespace Teammates.Compute;

public static class AdaptiveReadiness
{
    public static TimeSpan Interval(int attempt) => TimeSpan.FromMilliseconds(Math.Min(250, 50 * Math.Pow(2, Math.Clamp(attempt, 0, 3))));

    // Probe cancellation includes the deadline, including a stalled HTTP response.
    public static async Task WaitAsync(Func<CancellationToken, Task<bool>> probe, TimeSpan deadline, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(deadline);
        var clock = Stopwatch.GetTimestamp();
        try
        {
            for (var attempt = 0; ; attempt++)
            {
                timeout.Token.ThrowIfCancellationRequested();
                if (await probe(timeout.Token))
                {
                    timeout.Token.ThrowIfCancellationRequested();
                    return;
                }
                var remaining = deadline - Stopwatch.GetElapsedTime(clock);
                if (remaining <= TimeSpan.Zero) throw new OperationCanceledException(timeout.Token);
                await Task.Delay(Interval(attempt) < remaining ? Interval(attempt) : remaining, timeout.Token);
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw ComputeException.Recovering(); }
    }
}
