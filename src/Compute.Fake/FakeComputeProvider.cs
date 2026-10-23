using System.Collections.Concurrent;
using System.Diagnostics;
using System.Formats.Tar;
using System.Runtime.CompilerServices;
using System.Text;

namespace Teammates.Compute;

public sealed class FakeComputeOptions
{
    public int MaxComputers { get; init; } = 8;
    public string? AllowedOwner { get; init; }
    public bool SecondDisplay { get; init; } = true;
    public bool DockerAvailable { get; set; } = true;
    public string Root { get; init; } = Path.Combine(Path.GetTempPath(), "teammates-fake-" + Guid.NewGuid().ToString("n"));
}

/// <summary>
/// In-memory computers with a real local process for Exec. Used by caller tests and the contract suite.
/// </summary>
public sealed class FakeComputeProvider : IComputeProvider, IDesktopSessionAuthority, IComputerDisplays, IComputerDesktopControl
{
    private readonly FakeComputeOptions _options;
    private readonly IExecSecretResolver _secrets;
    private readonly ISnapshotStore _snapshots;
    private readonly IdempotencyStore _idempotency = new();
    private readonly OperationGate _gate = new();
    private readonly object _sync = new();
    private readonly Dictionary<string, Mutable> _computers = new();
    private readonly Dictionary<string, string> _tombstones = new();
    private readonly Dictionary<string, DesktopSession> _sessions = new();
    private readonly HashSet<string> _secondDisplays = new();
    private readonly ConcurrentDictionary<string, byte> _execOnce = new();

    public FakeComputeProvider(FakeComputeOptions options, IExecSecretResolver secrets, ISnapshotStore snapshots)
    {
        _options = options;
        _secrets = secrets;
        _snapshots = snapshots;
        Directory.CreateDirectory(options.Root);
    }

    public async Task<Computer> CreateComputerAsync(CreateComputerSpec spec, IdempotencyKey key, CancellationToken ct)
    {
        ValidateSpec(spec);
        var hash = Fingerprint.Of("create", spec.Id.Value, spec.OwnerId, spec.ImageRef, spec.Isolation, spec.Limits, spec.Labels);
        if (_idempotency.TryGet<Computer>(key, hash, out var cached)) return cached;
        using (await _gate.AcquireAsync(spec.Id.Value, key.Value, ct))
        {
            if (_idempotency.TryGet(key, hash, out cached)) return cached;
            lock (_sync)
            {
                if (_computers.ContainsKey(spec.Id.Value))
                    throw ComputeException.AlreadyExists("computer already exists");
                if (_computers.Values.Count(c => c.Computer.State is ComputerState.Running or ComputerState.Provisioning) >= _options.MaxComputers)
                    throw ComputeException.ResourceExhausted("no computer capacity");
            }
            var workspace = Workspace(spec.Id);
            var profile = Profile(spec.Id);
            Directory.CreateDirectory(workspace);
            Directory.CreateDirectory(profile);
            var now = DateTimeOffset.UtcNow;
            var computer = new Computer(spec.Id, spec.TenantId, spec.OwnerId, spec.ImageRef, spec.Isolation, ComputerState.Running, "fake", [workspace, profile], now, now, spec.Labels);
            var row = new Mutable(computer, 1, "agent") { DiskQuotaBytes = spec.Limits.DiskBytes };
            if (spec.Limits.DiskBytes > 0) WriteQuotaHook(spec.Id, spec.Limits.DiskBytes);
            lock (_sync)
            {
                _tombstones.Remove(spec.Id.Value);
                _computers[spec.Id.Value] = row;
            }
            _idempotency.Remember(key, hash, computer);
            return computer;
        }
    }

    public async Task<Computer> StartComputerAsync(ComputerId id, IdempotencyKey key, CancellationToken ct)
    {
        var hash = Fingerprint.Of("start", id.Value);
        if (_idempotency.TryGet<Computer>(key, hash, out var cached)) return cached;
        using (await _gate.AcquireAsync(id.Value, key.Value, ct))
        {
            if (_idempotency.TryGet(key, hash, out cached)) return cached;
            var computer = Mutate(id, current => current with { State = ComputerState.Running, UpdatedAt = DateTimeOffset.UtcNow }, static s => s is ComputerState.Stopped or ComputerState.Hibernated or ComputerState.Running or ComputerState.Idle);
            _idempotency.Remember(key, hash, computer);
            return computer;
        }
    }

    public async Task<Computer> StopComputerAsync(ComputerId id, StopOptions options, IdempotencyKey key, CancellationToken ct)
    {
        var hash = Fingerprint.Of("stop", id.Value, options.Force);
        if (_idempotency.TryGet<Computer>(key, hash, out var cached)) return cached;
        using (await _gate.AcquireAsync(id.Value, key.Value, ct))
        {
            if (_idempotency.TryGet(key, hash, out cached)) return cached;
            if (options.Grace > TimeSpan.Zero) await Task.Delay(TimeSpan.FromMilliseconds(Math.Min(options.Grace.TotalMilliseconds, 1500)), ct);
            var computer = Mutate(id, current => current with { State = ComputerState.Stopped, UpdatedAt = DateTimeOffset.UtcNow }, static s => s is not ComputerState.Deleted and not ComputerState.Deleting);
            lock (_sync) _secondDisplays.Remove(id.Value);
            _idempotency.Remember(key, hash, computer);
            return computer;
        }
    }

    public async Task<Computer> RestartComputerAsync(ComputerId id, IdempotencyKey key, CancellationToken ct)
    {
        var hash = Fingerprint.Of("restart", id.Value);
        if (_idempotency.TryGet<Computer>(key, hash, out var cached)) return cached;
        using (await _gate.AcquireAsync(id.Value, key.Value, ct))
        {
            if (_idempotency.TryGet(key, hash, out cached)) return cached;
            var computer = Mutate(id, current => current with { State = ComputerState.Running, UpdatedAt = DateTimeOffset.UtcNow }, static s => s is not ComputerState.Deleted and not ComputerState.Deleting);
            lock (_sync) _secondDisplays.Remove(id.Value);
            _idempotency.Remember(key, hash, computer);
            return computer;
        }
    }

    public async Task<Computer> RecreateComputerAsync(ComputerId id, RecreateOptions options, IdempotencyKey key, CancellationToken ct)
    {
        var hash = Fingerprint.Of("recreate", id.Value, options.ImageRef);
        if (_idempotency.TryGet<Computer>(key, hash, out var cached)) return cached;
        using (await _gate.AcquireAsync(id.Value, key.Value, ct))
        {
            if (_idempotency.TryGet(key, hash, out cached)) return cached;
            var image = string.IsNullOrWhiteSpace(options.ImageRef) ? null : options.ImageRef;
            var computer = Mutate(id, current => current with { State = ComputerState.Running, ImageRef = image ?? current.ImageRef, UpdatedAt = DateTimeOffset.UtcNow, HostId = "fake-new" }, static s => s is not ComputerState.Deleted and not ComputerState.Deleting);
            lock (_sync) _secondDisplays.Remove(id.Value);
            _idempotency.Remember(key, hash, computer);
            return computer;
        }
    }

    public async Task DeleteComputerAsync(ComputerId id, DeleteOptions options, IdempotencyKey key, CancellationToken ct)
    {
        var hash = Fingerprint.Of("delete", id.Value, options.RetainVolumes);
        if (_idempotency.TryGet<bool>(key, hash, out _)) return;
        using (await _gate.AcquireAsync(id.Value, key.Value, ct))
        {
            if (_idempotency.TryGet<bool>(key, hash, out _)) return;
            lock (_sync)
            {
                if (_tombstones.ContainsKey(id.Value))
                {
                    _idempotency.Remember(key, hash, true);
                    return;
                }
                if (!_computers.Remove(id.Value, out var existing))
                    throw ComputeException.NotFound("computer not found");
                _tombstones[id.Value] = existing.Computer.OwnerId;
                _secondDisplays.Remove(id.Value);
            }
            if (!options.RetainVolumes)
            {
                TryDelete(Home(id));
            }
            _idempotency.Remember(key, hash, true);
        }
    }

    public Task<Computer> GetComputerAsync(ComputerId id, CancellationToken ct)
    {
        lock (_sync)
        {
            if (_computers.TryGetValue(id.Value, out var row)) return Task.FromResult(row.Computer);
            if (_tombstones.ContainsKey(id.Value))
                return Task.FromResult(new Computer(id, "local", _tombstones[id.Value], "", IsolationClass.Docker, ComputerState.Deleted, "fake", [], DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, new Dictionary<string, string>()));
        }
        throw ComputeException.NotFound("computer not found");
    }

    public Task<ComputerStatus> GetStatusAsync(ComputerId id, CancellationToken ct)
    {
        var computer = GetComputerAsync(id, ct).Result;
        var x = Directory.Exists(Workspace(id));
        return Task.FromResult(new ComputerStatus(id, computer.State, [
            new("x", computer.State == ComputerState.Running && x, ""),
            new("chrome", computer.State == ComputerState.Running, ""),
            new("vnc", computer.State == ComputerState.Running, ""),
            new("agent", true, "fake")
        ], DateTimeOffset.UtcNow));
    }

    public Task<ComputerMetrics> GetMetricsAsync(ComputerId id, CancellationToken ct)
    {
        var computer = GetComputerAsync(id, ct).Result;
        if (computer.State is not (ComputerState.Running or ComputerState.Idle))
            throw ComputeException.FailedPrecondition("metrics require a running computer");
        var disk = DirSize(Workspace(id)) + DirSize(Profile(id));
        return Task.FromResult(new ComputerMetrics(id, 0.01, 32_000_000, (ulong)Math.Max(0, disk), 3, 0, 0, 0, DateTimeOffset.UtcNow));
    }

    public async IAsyncEnumerable<ExecEvent> ExecAsync(ExecSpec spec, IdempotencyKey key, [EnumeratorCancellation] CancellationToken ct)
    {
        if (spec.Argv.Count == 0) throw ComputeException.InvalidArgument("argv is required");
        if (spec.Stdin) throw ComputeException.Unsupported("exec.stdin is not negotiated in MVP");
        var hash = Fingerprint.Of("exec", spec.Id.Value, spec.Argv, spec.Cwd, spec.Env, spec.SecretEnv.Select(b => b.SecretRef + "|" + b.EnvName), spec.Timeout.TotalMilliseconds, spec.MaxOutputBytes);
        if (_idempotency.TryGet<List<ExecEvent>>(key, hash, out var replay))
        {
            foreach (var item in replay) yield return item;
            yield break;
        }
        var computer = await GetComputerAsync(spec.Id, ct);
        if (computer.State is not (ComputerState.Running or ComputerState.Idle))
            throw ComputeException.FailedPrecondition("exec requires a running computer");
        var secrets = await _secrets.ResolveAsync(spec.Id, spec.SecretEnv, ct);
        var events = new List<ExecEvent>();
        var seq = 0UL;
        void Add(ExecEvent item) => events.Add(item);
        var start = DateTimeOffset.UtcNow;
        var psi = new ProcessStartInfo
        {
            FileName = Rewrite(spec.Id, spec.Argv[0]),
            WorkingDirectory = Rewrite(spec.Id, string.IsNullOrWhiteSpace(spec.Cwd) ? "/workspace" : spec.Cwd),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        foreach (var arg in spec.Argv.Skip(1)) psi.ArgumentList.Add(Rewrite(spec.Id, arg));
        psi.Environment.Clear();
        psi.Environment["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
        psi.Environment["HOME"] = Home(spec.Id);
        psi.Environment["LANG"] = "C.UTF-8";
        foreach (var pair in spec.Env) psi.Environment[pair.Key] = pair.Value;
        foreach (var pair in secrets) psi.Environment[pair.Key] = pair.Value;
        ulong quota = 0;
        lock (_sync)
        {
            if (_computers.TryGetValue(spec.Id.Value, out var held)) quota = held.DiskQuotaBytes;
        }
        if (quota > 0)
        {
            psi.Environment["PYTHONPATH"] = QuotaHookDir(spec.Id);
            psi.Environment["TEAMMATES_DISK_QUOTA"] = quota.ToString();
            psi.Environment["TEAMMATES_DISK_ROOTS"] = Workspace(spec.Id) + ":" + Profile(spec.Id);
        }
        Directory.CreateDirectory(psi.WorkingDirectory);
        using var process = new Process { StartInfo = psi };
        process.Start();
        Add(new ExecStarted(++seq, (uint)process.Id));
        yield return events[^1];
        var limit = spec.MaxOutputBytes == 0 ? 1_000_000UL : spec.MaxOutputBytes;
        var used = 0UL;
        var truncated = false;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        if (spec.Timeout > TimeSpan.Zero) timeout.CancelAfter(spec.Timeout);
        var stdout = ReadStream(process.StandardOutput.BaseStream, secrets, limit, () => used, n => used = n, () => truncated = true, timeout.Token);
        var stderr = ReadStream(process.StandardError.BaseStream, secrets, limit, () => used, n => used = n, () => truncated = true, timeout.Token);
        var outputs = await Task.WhenAll(stdout, stderr);
        foreach (var chunk in outputs[0])
        {
            Add(new ExecStdout(++seq, chunk));
            yield return events[^1];
        }
        foreach (var chunk in outputs[1])
        {
            Add(new ExecStderr(++seq, chunk));
            yield return events[^1];
        }
        var timedOut = false;
        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            timedOut = true;
        }
        if (timedOut)
        {
            try { process.Kill(entireProcessTree: true); } catch { /* already gone */ }
            Add(new ExecError(++seq, ComputeErrorCode.DeadlineExceeded, "exec timed out", true));
            yield return events[^1];
            _idempotency.Remember(key, hash, events);
            yield break;
        }
        Add(new ExecExited(++seq, process.ExitCode, "", DateTimeOffset.UtcNow - start, truncated));
        yield return events[^1];
        _idempotency.Remember(key, hash, events);
        _execOnce.TryAdd(key.Value, 1);
    }

    public async Task<IReadOnlyList<ComputerDisplay>> ListDisplaysAsync(ComputerId id, CancellationToken ct)
    {
        _ = await GetComputerAsync(id, ct);
        lock (_sync)
            return _options.SecondDisplay
                ? new[] { new ComputerDisplay(1, 1024, 768, true), new ComputerDisplay(2, 1024, 768, _secondDisplays.Contains(id.Value)) }
                : new[] { new ComputerDisplay(1, 1024, 768, true) };
    }

    public Task<DesktopSession> GetDesktopSessionAsync(ComputerId id, DesktopAccess access, CancellationToken ct)
    {
        if (access.Display is < 1 or > 2 || (access.Display == 2 && !_options.SecondDisplay))
            throw ComputeException.InvalidArgument("display must be enabled and be 1 or 2");
        var computer = GetComputerAsync(id, ct).Result;
        if (computer.State is not (ComputerState.Running or ComputerState.Idle))
            throw ComputeException.FailedPrecondition("desktop requires a running computer");
        if (access.Mode == DesktopMode.Interactive && !access.TakeoverLeaseHeld)
            throw ComputeException.FailedPrecondition("interactive desktop requires the takeover lease");
        ulong epoch;
        lock (_sync)
        {
            var row = _computers[id.Value];
            if (access.FencingEpoch != 0 && access.FencingEpoch < row.Epoch)
                throw ComputeException.FailedPrecondition("stale fencing epoch");
            if (access.FencingEpoch > row.Epoch) row.Epoch = access.FencingEpoch;
            epoch = row.Epoch == 0 ? 1 : row.Epoch;
            row.Epoch = epoch;
            if (access.Mode == DesktopMode.Interactive) row.Holder = "human";
        }
        var ttl = access.Ttl <= TimeSpan.Zero ? TimeSpan.FromMinutes(2) : access.Ttl;
        var token = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
        var session = new DesktopSession("/vnc/websockify?token=" + token, token, access.Mode == DesktopMode.Unspecified ? DesktopMode.View : access.Mode, epoch, DateTimeOffset.UtcNow.Add(ttl), "fake", (access.Mode == DesktopMode.Interactive ? 6900 : 5900) + access.Display - 1);
        lock (_sync)
        {
            _sessions[token] = session with { };
            if (access.Display == 2) _secondDisplays.Add(id.Value);
        }
        _sessionsHold(id, session);
        return Task.FromResult(session);
    }

    private void _sessionsHold(ComputerId id, DesktopSession session)
    {
        lock (_sync) _sessionOwners[session.Token] = id;
    }

    private readonly Dictionary<string, ComputerId> _sessionOwners = new();

    public DesktopEndpoint RequireSession(string token, DateTimeOffset now)
    {
        lock (_sync)
        {
            if (!_sessions.TryGetValue(token, out var session) || !_sessionOwners.TryGetValue(token, out var id))
                throw ComputeException.PermissionDenied("desktop token rejected");
            if (now > session.ExpiresAt)
                throw ComputeException.FailedPrecondition("desktop token expired");
            var row = _computers.GetValueOrDefault(id.Value);
            if (row != null && session.FencingEpoch != row.Epoch)
                throw ComputeException.FailedPrecondition("stale fencing epoch");
            return new DesktopEndpoint(id, session.Host, session.Port, session.Mode, session.FencingEpoch, session.ExpiresAt);
        }
    }

    public async Task<Snapshot> SnapshotAsync(ComputerId id, SnapshotOptions options, IdempotencyKey key, CancellationToken ct)
    {
        var hash = Fingerprint.Of("snapshot", id.Value, options.Label);
        if (_idempotency.TryGet<Snapshot>(key, hash, out var cached)) return cached;
        using (await _gate.AcquireAsync(id.Value, key.Value, ct))
        {
            if (_idempotency.TryGet(key, hash, out cached)) return cached;
            _ = await GetComputerAsync(id, ct);
            var snapshotId = Guid.NewGuid().ToString("n");
            ulong size = 0;
            size += await TarSave(id, snapshotId, "workspace", Workspace(id), ct);
            size += await TarSave(id, snapshotId, "profile", Profile(id), ct);
            var snapshot = new Snapshot(new SnapshotId(snapshotId), id, size, DateTimeOffset.UtcNow);
            _idempotency.Remember(key, hash, snapshot);
            return snapshot;
        }
    }

    public async Task<Computer> RestoreAsync(ComputerId id, SnapshotId snapshot, IdempotencyKey key, CancellationToken ct)
    {
        var hash = Fingerprint.Of("restore", id.Value, snapshot.Value);
        if (_idempotency.TryGet<Computer>(key, hash, out var cached)) return cached;
        using (await _gate.AcquireAsync(id.Value, key.Value, ct))
        {
            if (_idempotency.TryGet(key, hash, out cached)) return cached;
            Mutate(id, current => current with { State = ComputerState.Restoring }, static _ => true);
            await TarLoad(snapshot.Value, "workspace", Workspace(id), ct);
            await TarLoad(snapshot.Value, "profile", Profile(id), ct);
            var computer = Mutate(id, current => current with { State = ComputerState.Running, UpdatedAt = DateTimeOffset.UtcNow }, static _ => true);
            _idempotency.Remember(key, hash, computer);
            return computer;
        }
    }

    public Task<Capacity> GetCapacityAsync(CapacityQuery query, CancellationToken ct)
    {
        if (!_options.DockerAvailable) throw ComputeException.Unavailable("compute runtime unavailable");
        int running;
        lock (_sync) running = _computers.Values.Count(c => c.Computer.State == ComputerState.Running);
        return Task.FromResult(new Capacity("fake", 4000, 3000, 8L << 30, 6L << 30, 40L << 30, 20L << 30, (uint)running, (uint)_options.MaxComputers, false));
    }

    public Task<HealthReport> HealthCheckAsync(CancellationToken ct)
    {
        if (!_options.DockerAvailable)
            throw ComputeException.Unavailable("docker daemon unreachable");
        return Task.FromResult(new HealthReport(true, "fake", [new ComponentHealth("runtime", true, "fake")]));
    }

    public async IAsyncEnumerable<ComputerStatusEvent> WatchStatusAsync(ComputerId id, [EnumeratorCancellation] CancellationToken ct)
    {
        ulong sequence = 0;
        ComputerState? previous = null;
        while (!ct.IsCancellationRequested)
        {
            var status = await GetStatusAsync(id, ct);
            if (previous != status.State)
            {
                previous = status.State;
                yield return new ComputerStatusEvent(status, ++sequence);
            }
            try { await Task.Delay(150, ct); }
            catch (OperationCanceledException) { yield break; }
        }
    }

    public async IAsyncEnumerable<ComputerMetrics> WatchMetricsAsync(ComputerId id, TimeSpan interval, [EnumeratorCancellation] CancellationToken ct)
    {
        var delay = interval <= TimeSpan.Zero ? TimeSpan.FromSeconds(1) : interval;
        while (!ct.IsCancellationRequested)
        {
            yield return await GetMetricsAsync(id, ct);
            try { await Task.Delay(delay, ct); }
            catch (OperationCanceledException) { yield break; }
        }
    }

    public Task SetHolderAsync(ComputerId id, string holder, ulong epoch, CancellationToken ct)
    {
        lock (_sync)
        {
            if (!_computers.TryGetValue(id.Value, out var row)) throw ComputeException.NotFound("computer not found");
            row.Holder = holder;
            if (epoch > row.Epoch) row.Epoch = epoch;
        }
        return Task.CompletedTask;
    }

    public Task<string> ControlAsync(ComputerId id, string path, string json, CancellationToken ct)
    {
        _ = GetComputerAsync(id, ct).Result;
        return Task.FromResult("{\"ok\":true}");
    }

    public Task<string> ControlAsync(ComputerId id, string path, ReadOnlyMemory<byte> json, CancellationToken ct) =>
        ControlAsync(id, path, Encoding.UTF8.GetString(json.Span), ct);

    private void ValidateSpec(CreateComputerSpec spec)
    {
        if (string.IsNullOrWhiteSpace(spec.ImageRef)) throw ComputeException.InvalidArgument("image is required");
        if (spec.Isolation is IsolationClass.Kata or IsolationClass.Firecracker)
            throw ComputeException.Unsupported("only docker isolation is offered in MVP");
        if (!string.IsNullOrEmpty(_options.AllowedOwner) && spec.OwnerId != _options.AllowedOwner)
            throw ComputeException.PermissionDenied("caller cannot provision this owner");
    }

    private Computer Mutate(ComputerId id, Func<Computer, Computer> change, Func<ComputerState, bool> allowed)
    {
        lock (_sync)
        {
            if (_tombstones.ContainsKey(id.Value) && !_computers.ContainsKey(id.Value))
                throw ComputeException.FailedPrecondition("computer is deleted");
            if (!_computers.TryGetValue(id.Value, out var row))
                throw ComputeException.NotFound("computer not found");
            if (!allowed(row.Computer.State))
                throw ComputeException.FailedPrecondition($"cannot operate from state {row.Computer.State}");
            row.Computer = change(row.Computer);
            return row.Computer;
        }
    }

    private string QuotaHookDir(ComputerId id) => Path.Combine(Home(id), "quota-hook");

    private void WriteQuotaHook(ComputerId id, ulong bytes)
    {
        var dir = QuotaHookDir(id);
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "sitecustomize.py"), """
            import os
            import builtins

            _QUOTA = int(os.environ.get("TEAMMATES_DISK_QUOTA") or "0")
            _ROOTS = [item for item in os.environ.get("TEAMMATES_DISK_ROOTS", "").split(":") if item]
            _open = builtins.open


            def _used():
                total = 0
                for root in _ROOTS:
                    if not os.path.isdir(root):
                        continue
                    for dirpath, _, files in os.walk(root):
                        for name in files:
                            try:
                                total += os.path.getsize(os.path.join(dirpath, name))
                            except OSError:
                                pass
                return total


            class _QuotaFile:
                def __init__(self, raw):
                    self._raw = raw

                def write(self, data):
                    payload = data.encode() if isinstance(data, str) else data
                    if _QUOTA and _used() + len(payload) > _QUOTA:
                        raise OSError(28, "No space left on device")
                    return self._raw.write(data)

                def __enter__(self):
                    return self

                def __exit__(self, exc_type, exc, tb):
                    self.close()

                def close(self):
                    return self._raw.close()

                def __getattr__(self, name):
                    return getattr(self._raw, name)


            def _open_quota(file, mode="r", *args, **kwargs):
                raw = _open(file, mode, *args, **kwargs)
                if any(flag in mode for flag in ("w", "a", "x", "+")):
                    return _QuotaFile(raw)
                return raw


            builtins.open = _open_quota
            """);
        _ = bytes;
    }

    private string Home(ComputerId id) => Path.Combine(_options.Root, Sanitize(id.Value));
    private string Workspace(ComputerId id) => Path.Combine(Home(id), "workspace");
    private string Profile(ComputerId id) => Path.Combine(Home(id), "profile");

    private string Rewrite(ComputerId id, string value)
    {
        if (string.IsNullOrEmpty(value)) return value;
        return value
            .Replace("/data/workspace", Workspace(id), StringComparison.Ordinal)
            .Replace("/data/profiles", Profile(id), StringComparison.Ordinal)
            .Replace("/data/profile", Profile(id), StringComparison.Ordinal)
            .Replace("/workspace", Workspace(id), StringComparison.Ordinal);
    }

    private async Task<ulong> TarSave(ComputerId id, string snapshotId, string name, string directory, CancellationToken ct)
    {
        Directory.CreateDirectory(directory);
        var tar = Path.Combine(Home(id), name + ".tar");
        if (File.Exists(tar)) File.Delete(tar);
        TarFile.CreateFromDirectory(directory, tar, includeBaseDirectory: false);
        await using var stream = File.OpenRead(tar);
        var length = (ulong)stream.Length;
        await _snapshots.SaveAsync(snapshotId, name + ".tar", stream, ct);
        return length;
    }

    private async Task TarLoad(string snapshotId, string name, string directory, CancellationToken ct)
    {
        if (Directory.Exists(directory)) Directory.Delete(directory, true);
        Directory.CreateDirectory(directory);
        await using var stream = await _snapshots.OpenAsync(snapshotId, name + ".tar", ct);
        var tar = Path.Combine(directory, ".restore.tar");
        await using (var file = File.Create(tar)) await stream.CopyToAsync(file, ct);
        TarFile.ExtractToDirectory(tar, directory, overwriteFiles: true);
        File.Delete(tar);
    }

    private static async Task<List<byte[]>> ReadStream(Stream stream, IReadOnlyDictionary<string, string> secrets, ulong limit, Func<ulong> used, Action<ulong> setUsed, Action truncate, CancellationToken ct)
    {
        var chunks = new List<byte[]>();
        var buffer = new byte[4096];
        while (true)
        {
            int read;
            try { read = await stream.ReadAsync(buffer, ct); }
            catch (OperationCanceledException) { break; }
            if (read <= 0) break;
            var take = read;
            var current = used();
            if (current >= limit) { truncate(); break; }
            if (current + (ulong)take > limit)
            {
                take = (int)(limit - current);
                truncate();
            }
            var slice = buffer.AsSpan(0, take).ToArray();
            chunks.Add(OutputRedactor.Redact(slice, secrets.Values));
            setUsed(current + (ulong)take);
            if (take < read) break;
        }
        return chunks;
    }

    private static long DirSize(string path)
    {
        if (!Directory.Exists(path)) return 0;
        return new DirectoryInfo(path).EnumerateFiles("*", SearchOption.AllDirectories).Sum(file => file.Length);
    }

    private static void TryDelete(string path)
    {
        try { if (Directory.Exists(path)) Directory.Delete(path, true); } catch { /* best effort */ }
    }

    private static string Sanitize(string value)
    {
        var chars = value.Select(ch => char.IsLetterOrDigit(ch) ? ch : '-').ToArray();
        return new string(chars);
    }

    private sealed class Mutable(Computer computer, ulong epoch, string holder)
    {
        public Computer Computer { get; set; } = computer;
        public ulong Epoch { get; set; } = epoch;
        public string Holder { get; set; } = holder;
        public ulong DiskQuotaBytes { get; set; }
    }
}

public sealed class DirectorySnapshotStore(string root) : ISnapshotStore
{
    public async Task SaveAsync(string snapshotId, string name, Stream content, CancellationToken ct)
    {
        var dir = Path.Combine(root, snapshotId);
        Directory.CreateDirectory(dir);
        await using var file = File.Create(Path.Combine(dir, name));
        await content.CopyToAsync(file, ct);
    }

    public Task<Stream> OpenAsync(string snapshotId, string name, CancellationToken ct)
    {
        var path = Path.Combine(root, snapshotId, name);
        if (!File.Exists(path)) throw ComputeException.NotFound("snapshot not found");
        Stream stream = File.OpenRead(path);
        return Task.FromResult(stream);
    }
}

public sealed class MapSecretResolver(IReadOnlyDictionary<string, string> values) : IExecSecretResolver
{
    public Task<IReadOnlyDictionary<string, string>> ResolveAsync(ComputerId computerId, IReadOnlyList<SecretEnvBinding> bindings, CancellationToken ct)
    {
        var resolved = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var binding in bindings)
        {
            if (string.IsNullOrWhiteSpace(binding.EnvName))
                throw ComputeException.InvalidArgument("secret env name is required");
            if (!values.TryGetValue(binding.SecretRef, out var value))
                throw ComputeException.PermissionDenied("secret ref is not granted");
            resolved[binding.EnvName] = value;
        }
        return Task.FromResult<IReadOnlyDictionary<string, string>>(resolved);
    }
}
