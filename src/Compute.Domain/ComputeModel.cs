namespace Teammates.Compute;

public readonly record struct ComputerId(string Value)
{
    public override string ToString() => Value;
    public static ComputerId Parse(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 80)
            throw ComputeException.InvalidArgument("computer id is required");
        return new ComputerId(value.Trim());
    }
}

public readonly record struct SnapshotId(string Value)
{
    public override string ToString() => Value;
}

public readonly record struct IdempotencyKey(string Value)
{
    public static IdempotencyKey Require(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 200)
            throw ComputeException.InvalidArgument("idempotency key is required");
        return new IdempotencyKey(value.Trim());
    }
}

public enum IsolationClass { Unspecified, Docker, Kata, Firecracker }

public enum ComputerState
{
    Absent,
    Provisioning,
    Running,
    Idle,
    Stopping,
    Stopped,
    Hibernated,
    Recreating,
    Restoring,
    Failed,
    Deleting,
    Deleted
}

public enum ComputeErrorCode
{
    NotFound,
    AlreadyExists,
    InvalidArgument,
    FailedPrecondition,
    Conflict,
    IdempotencyConflict,
    ResourceExhausted,
    PermissionDenied,
    Unavailable,
    DeadlineExceeded,
    Unsupported,
    Internal
}

public enum DesktopMode { Unspecified, View, Interactive }

public sealed class ComputeException : Exception
{
    public ComputeException(ComputeErrorCode code, string message) : base(message) => Code = code;
    public ComputeErrorCode Code { get; }
    public const string RecoveringMessage = "computer_recovering";
    public const string IsolationMissingMessage = "computer_isolation_missing";

    public bool Retryable => Code is ComputeErrorCode.Conflict or ComputeErrorCode.ResourceExhausted or ComputeErrorCode.Unavailable;

    public bool IsRecovering => Code == ComputeErrorCode.Unavailable && Message == RecoveringMessage;

    public bool IsIsolationMissing => Code == ComputeErrorCode.FailedPrecondition && Message == IsolationMissingMessage;

    public static ComputeException Recovering() => new(ComputeErrorCode.Unavailable, RecoveringMessage);

    public static ComputeException IsolationMissing() => new(ComputeErrorCode.FailedPrecondition, IsolationMissingMessage);

    public static ComputeException NotFound(string message) => new(ComputeErrorCode.NotFound, message);
    public static ComputeException AlreadyExists(string message) => new(ComputeErrorCode.AlreadyExists, message);
    public static ComputeException InvalidArgument(string message) => new(ComputeErrorCode.InvalidArgument, message);
    public static ComputeException FailedPrecondition(string message) => new(ComputeErrorCode.FailedPrecondition, message);
    public static ComputeException Conflict(string message) => new(ComputeErrorCode.Conflict, message);
    public static ComputeException IdempotencyConflict(string message) => new(ComputeErrorCode.IdempotencyConflict, message);
    public static ComputeException ResourceExhausted(string message) => new(ComputeErrorCode.ResourceExhausted, message);
    public static ComputeException PermissionDenied(string message) => new(ComputeErrorCode.PermissionDenied, message);
    public static ComputeException Unavailable(string message) => new(ComputeErrorCode.Unavailable, message);
    public static ComputeException DeadlineExceeded(string message) => new(ComputeErrorCode.DeadlineExceeded, message);
    public static ComputeException Unsupported(string message) => new(ComputeErrorCode.Unsupported, message);
    public static ComputeException Internal(string message) => new(ComputeErrorCode.Internal, message);
}

public sealed record ResourceLimits(uint VcpuMillis, ulong MemoryBytes, ulong DiskBytes, uint MaxPids);

public sealed record Computer(
    ComputerId Id,
    string TenantId,
    string OwnerId,
    string ImageRef,
    IsolationClass Isolation,
    ComputerState State,
    string HostId,
    IReadOnlyList<string> VolumeIds,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    IReadOnlyDictionary<string, string> Labels);

public sealed record CreateComputerSpec(
    ComputerId Id,
    string TenantId,
    string OwnerId,
    string ImageRef,
    IsolationClass Isolation,
    ResourceLimits Limits,
    string NetworkPolicyId,
    IReadOnlyDictionary<string, string> Labels);

public sealed record StopOptions(bool Force, TimeSpan Grace);
public sealed record DeleteOptions(bool RetainVolumes);
public sealed record RecreateOptions(string? ImageRef, string? OwnerId = null, string? DisplayName = null);

public sealed record ComponentHealth(string Name, bool Healthy, string Detail);
public sealed record ComputerStatus(ComputerId Id, ComputerState State, IReadOnlyList<ComponentHealth> Components, DateTimeOffset ObservedAt);
public sealed record ComputerStatusEvent(ComputerStatus Status, ulong Sequence);

public sealed record ComputerMetrics(
    ComputerId Id,
    double CpuRatio,
    ulong MemoryUsedBytes,
    ulong DiskUsedBytes,
    uint Pids,
    ulong NetRxBytes,
    ulong NetTxBytes,
    uint BrowserTabs,
    DateTimeOffset ObservedAt);

public sealed record SecretEnvBinding(string EnvName, string SecretRef, string GrantId);

public sealed record ExecSpec(
    ComputerId Id,
    IReadOnlyList<string> Argv,
    string Cwd,
    IReadOnlyDictionary<string, string> Env,
    IReadOnlyList<SecretEnvBinding> SecretEnv,
    string RunAs,
    TimeSpan Timeout,
    ulong MaxOutputBytes,
    bool Stdin);

public abstract record ExecEvent(ulong Sequence);
public sealed record ExecStarted(ulong Sequence, uint Pid) : ExecEvent(Sequence);
public sealed record ExecStdout(ulong Sequence, byte[] Data) : ExecEvent(Sequence);
public sealed record ExecStderr(ulong Sequence, byte[] Data) : ExecEvent(Sequence);
public sealed record ExecExited(ulong Sequence, int ExitCode, string Signal, TimeSpan Duration, bool OutputTruncated) : ExecEvent(Sequence);
public sealed record ExecError(ulong Sequence, ComputeErrorCode Code, string Message, bool Retryable) : ExecEvent(Sequence);

public sealed record DesktopAccess(DesktopMode Mode, ulong FencingEpoch, TimeSpan Ttl, bool TakeoverLeaseHeld, int Display = 1);
public sealed record DesktopSession(string Url, string Token, DesktopMode Mode, ulong FencingEpoch, DateTimeOffset ExpiresAt, string Host, int Port);
public sealed record DesktopEndpoint(ComputerId ComputerId, string Host, int Port, DesktopMode Mode, ulong FencingEpoch, DateTimeOffset ExpiresAt);

public sealed record SnapshotOptions(string Label);
public sealed record Snapshot(SnapshotId Id, ComputerId ComputerId, ulong SizeBytes, DateTimeOffset CreatedAt);

public sealed record CapacityQuery(IsolationClass Isolation);
public sealed record Capacity(
    string HostId,
    uint VcpuMillisTotal,
    uint VcpuMillisAllocatable,
    ulong MemoryBytesTotal,
    ulong MemoryBytesAllocatable,
    ulong DiskBytesTotal,
    ulong DiskBytesAllocatable,
    uint ComputersRunning,
    uint ComputersMax,
    bool Draining);

public sealed record HealthReport(bool Healthy, string HostVersion, IReadOnlyList<ComponentHealth> Components);

public interface IExecSecretResolver
{
    Task<IReadOnlyDictionary<string, string>> ResolveAsync(ComputerId computerId, IReadOnlyList<SecretEnvBinding> bindings, CancellationToken ct);
}

public interface ISnapshotStore
{
    Task SaveAsync(string snapshotId, string name, Stream content, CancellationToken ct);
    Task<Stream> OpenAsync(string snapshotId, string name, CancellationToken ct);
}

public interface IComputeProvider
{
    Task<Computer> CreateComputerAsync(CreateComputerSpec spec, IdempotencyKey key, CancellationToken ct);
    Task<Computer> StartComputerAsync(ComputerId id, IdempotencyKey key, CancellationToken ct);
    Task<Computer> StopComputerAsync(ComputerId id, StopOptions options, IdempotencyKey key, CancellationToken ct);
    Task<Computer> RestartComputerAsync(ComputerId id, IdempotencyKey key, CancellationToken ct);
    Task<Computer> RecreateComputerAsync(ComputerId id, RecreateOptions options, IdempotencyKey key, CancellationToken ct);
    Task DeleteComputerAsync(ComputerId id, DeleteOptions options, IdempotencyKey key, CancellationToken ct);
    Task<Computer> GetComputerAsync(ComputerId id, CancellationToken ct);
    Task<ComputerStatus> GetStatusAsync(ComputerId id, CancellationToken ct);
    Task<ComputerMetrics> GetMetricsAsync(ComputerId id, CancellationToken ct);
    IAsyncEnumerable<ExecEvent> ExecAsync(ExecSpec spec, IdempotencyKey key, CancellationToken ct);
    Task<DesktopSession> GetDesktopSessionAsync(ComputerId id, DesktopAccess access, CancellationToken ct);
    Task<Snapshot> SnapshotAsync(ComputerId id, SnapshotOptions options, IdempotencyKey key, CancellationToken ct);
    Task<Computer> RestoreAsync(ComputerId id, SnapshotId snapshot, IdempotencyKey key, CancellationToken ct);
    Task<Capacity> GetCapacityAsync(CapacityQuery query, CancellationToken ct);
    Task<HealthReport> HealthCheckAsync(CancellationToken ct);
    IAsyncEnumerable<ComputerStatusEvent> WatchStatusAsync(ComputerId id, CancellationToken ct);
    IAsyncEnumerable<ComputerMetrics> WatchMetricsAsync(ComputerId id, TimeSpan interval, CancellationToken ct);
}

public interface IDesktopSessionAuthority
{
    DesktopEndpoint RequireSession(string token, DateTimeOffset now);
}

public sealed record ComputerDisplay(int Display, int Width, int Height, bool Ready);

public interface IComputerDisplays
{
    Task<IReadOnlyList<ComputerDisplay>> ListDisplaysAsync(ComputerId id, CancellationToken ct);
}

public interface IComputerDesktopControl
{
    Task SetHolderAsync(ComputerId id, string holder, ulong epoch, CancellationToken ct);
    Task<string> ControlAsync(ComputerId id, string path, string json, CancellationToken ct);
    Task<string> ControlAsync(ComputerId id, string path, ReadOnlyMemory<byte> json, CancellationToken ct);
}

public static class OutputRedactor
{
    private static readonly System.Text.RegularExpressions.Regex[] Patterns =
    [
        new(@"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----", System.Text.RegularExpressions.RegexOptions.Compiled),
        new(@"sk-or-[A-Za-z0-9_\-]{10,}", System.Text.RegularExpressions.RegexOptions.Compiled),
        new(@"sk-[A-Za-z0-9_\-]{10,}", System.Text.RegularExpressions.RegexOptions.Compiled),
        new(@"ghp_[A-Za-z0-9]{10,}", System.Text.RegularExpressions.RegexOptions.Compiled),
        new(@"github_pat_[A-Za-z0-9_]{10,}", System.Text.RegularExpressions.RegexOptions.Compiled),
        new(@"glpat-[A-Za-z0-9_\-]{10,}", System.Text.RegularExpressions.RegexOptions.Compiled),
        new(@"xox[baprs]-[A-Za-z0-9\-]{10,}", System.Text.RegularExpressions.RegexOptions.Compiled),
        new(@"\b\d{5}-\d{7}-\d\b", System.Text.RegularExpressions.RegexOptions.Compiled),
        new(@"(?i)\b(?:national\s*id|cnic|ssn|nino)\b[:\s#]*[A-Z0-9-]{5,24}", System.Text.RegularExpressions.RegexOptions.Compiled),
        new(@"\b(?!000|666|9\d{2})\d{3}-\d{2}-(?!0000)\d{4}\b", System.Text.RegularExpressions.RegexOptions.Compiled),
        new(@"(?i)\bpassport\b[:\s#]*[A-Z0-9]{6,12}\b", System.Text.RegularExpressions.RegexOptions.Compiled),
    ];

    private static readonly System.Text.RegularExpressions.Regex CardCandidate = new(@"\b(?:\d[ -]?){12,18}\d\b", System.Text.RegularExpressions.RegexOptions.Compiled);
    private static readonly System.Text.RegularExpressions.Regex IbanCandidate = new(@"\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b", System.Text.RegularExpressions.RegexOptions.Compiled);
    private static readonly System.Text.RegularExpressions.Regex UuidToken = new(@"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", System.Text.RegularExpressions.RegexOptions.Compiled);

    public static string Redact(string? text, IEnumerable<string>? secrets = null)
    {
        if (string.IsNullOrEmpty(text)) return text ?? "";
        var output = text;
        foreach (var pattern in Patterns) output = pattern.Replace(output, "[REDACTED]");
        output = CardCandidate.Replace(output, match => InsideUuid(output, match.Index, match.Length) || !Luhn(Digits(match.Value)) ? match.Value : "[REDACTED]");
        output = IbanCandidate.Replace(output, match => Iban(match.Value) ? "[REDACTED]" : match.Value);
        if (secrets != null)
        {
            foreach (var secret in secrets)
            {
                if (!string.IsNullOrEmpty(secret) && secret.Length >= 6)
                    output = output.Replace(secret, "[REDACTED]", StringComparison.Ordinal);
            }
        }
        return output;
    }

    public static bool Luhn(string digits)
    {
        if (digits.Length is < 13 or > 19) return false;
        var sum = 0;
        var alt = false;
        for (var i = digits.Length - 1; i >= 0; i--)
        {
            var n = digits[i] - '0';
            if (n is < 0 or > 9) return false;
            if (alt)
            {
                n *= 2;
                if (n > 9) n -= 9;
            }
            sum += n;
            alt = !alt;
        }
        return sum % 10 == 0;
    }

    public static bool Iban(string value)
    {
        var compact = new string(value.Where(char.IsLetterOrDigit).ToArray()).ToUpperInvariant();
        if (compact.Length is < 15 or > 34) return false;
        if (!char.IsLetter(compact[0]) || !char.IsLetter(compact[1]) || !char.IsDigit(compact[2]) || !char.IsDigit(compact[3])) return false;
        var rearranged = compact[4..] + compact[..4];
        var remainder = 0;
        foreach (var ch in rearranged)
        {
            if (char.IsDigit(ch))
            {
                remainder = (remainder * 10 + (ch - '0')) % 97;
                continue;
            }
            if (!char.IsLetter(ch)) return false;
            var expanded = (ch - 'A' + 10).ToString();
            foreach (var digit in expanded)
                remainder = (remainder * 10 + (digit - '0')) % 97;
        }
        return remainder == 1;
    }

    private static bool InsideUuid(string text, int index, int length)
    {
        var start = index;
        while (start > 0 && IsUuidChar(text[start - 1])) start--;
        var end = index + length;
        while (end < text.Length && IsUuidChar(text[end])) end++;
        return end - start == 36 && UuidToken.IsMatch(text.Substring(start, 36));
    }

    private static bool IsUuidChar(char ch) => ch == '-' || char.IsAsciiHexDigit(ch);

    private static string Digits(string value)
    {
        var chars = new char[value.Length];
        var n = 0;
        foreach (var ch in value)
        {
            if (char.IsDigit(ch)) chars[n++] = ch;
        }
        return new string(chars, 0, n);
    }

    public static byte[] Redact(byte[] data, IEnumerable<string>? secrets = null)
    {
        var text = System.Text.Encoding.UTF8.GetString(data);
        return System.Text.Encoding.UTF8.GetBytes(Redact(text, secrets));
    }
}

public sealed class IdempotencyStore
{
    private readonly object _gate = new();
    private readonly Dictionary<string, Slot> _slots = new();
    private readonly TimeSpan _ttl;

    public IdempotencyStore(TimeSpan? ttl = null) => _ttl = ttl ?? TimeSpan.FromHours(24);

    public bool TryGet<T>(IdempotencyKey key, string hash, out T value)
    {
        lock (_gate)
        {
            Prune();
            if (_slots.TryGetValue(key.Value, out var slot))
            {
                if (!string.Equals(slot.Hash, hash, StringComparison.Ordinal))
                    throw ComputeException.IdempotencyConflict("idempotency key was reused with different arguments");
                if (slot.Value is T typed)
                {
                    value = typed;
                    return true;
                }
            }
        }
        value = default!;
        return false;
    }

    public void Remember(IdempotencyKey key, string hash, object value)
    {
        lock (_gate)
        {
            Prune();
            if (_slots.TryGetValue(key.Value, out var existing) && !string.Equals(existing.Hash, hash, StringComparison.Ordinal))
                throw ComputeException.IdempotencyConflict("idempotency key was reused with different arguments");
            _slots[key.Value] = new Slot(hash, value, DateTimeOffset.UtcNow);
        }
    }

    private void Prune()
    {
        var cutoff = DateTimeOffset.UtcNow - _ttl;
        foreach (var key in _slots.Where(pair => pair.Value.At < cutoff).Select(pair => pair.Key).ToList())
            _slots.Remove(key);
    }

    private sealed record Slot(string Hash, object Value, DateTimeOffset At);
}

public sealed class OperationGate
{
    private readonly object _sync = new();
    private readonly Dictionary<string, Hold> _holds = new();

    public async Task<IDisposable> AcquireAsync(string computerId, string operationKey, CancellationToken ct)
    {
        while (true)
        {
            Task? wait = null;
            lock (_sync)
            {
                if (!_holds.TryGetValue(computerId, out var hold))
                {
                    hold = new Hold(operationKey, new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously));
                    _holds[computerId] = hold;
                    return new Release(() => ReleaseHold(computerId, hold));
                }
                if (hold.Key == operationKey) wait = hold.Done.Task;
                else throw ComputeException.Conflict("another lifecycle operation is in progress");
            }
            await wait!.WaitAsync(ct);
        }
    }

    private void ReleaseHold(string computerId, Hold hold)
    {
        lock (_sync)
        {
            if (_holds.TryGetValue(computerId, out var current) && ReferenceEquals(current, hold))
                _holds.Remove(computerId);
        }
        hold.Done.TrySetResult();
    }

    private sealed record Hold(string Key, TaskCompletionSource Done);

    private sealed class Release(Action release) : IDisposable
    {
        private int _once;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _once, 1) == 0) release();
        }
    }
}

public static class Fingerprint
{
    public static string Of(params object?[] parts)
    {
        var json = System.Text.Json.JsonSerializer.Serialize(parts);
        var hash = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(json));
        return Convert.ToHexString(hash);
    }
}
