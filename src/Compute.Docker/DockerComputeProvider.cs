using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Docker.DotNet;
using Docker.DotNet.Models;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Teammates.Compute;

/// <summary>
/// MVP compute implementation. Talks to the Docker engine through a restricted socket proxy.
/// User computers never receive the socket.
/// </summary>
public sealed class DockerComputeProvider : IComputeProvider, IDesktopSessionAuthority, IComputerDisplays, IComputerDesktopControl, IAsyncDisposable
{
    private const string ManagedLabel = "teammates.managed";
    private readonly DockerComputeOptions _options;
    private readonly IExecSecretResolver _secrets;
    private readonly ISnapshotStore _snapshots;
    private readonly ILogger _logger;
    private readonly DockerClient _client;
    private readonly IdempotencyStore _idempotency = new();
    private readonly OperationGate _gate = new();
    private readonly object _sync = new();
    private readonly Dictionary<string, Row> _rows = new();
    private readonly Dictionary<string, string> _tombstones = new();
    private readonly Dictionary<string, (DesktopSession Session, ComputerId Computer)> _sessions = new();
    private readonly ConcurrentDictionary<string, Task<Computer>> _restores = new();
    private readonly HashSet<string> _ready = new();
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(30) };
    private readonly SemaphoreSlim _isolationGate = new(1, 1);
    private HttpClient? _isolationHttp;
    private int _isolationHealthy;
    private string? _isolationDetail;
    private string? _seccompOpt;
    private readonly LoopDisk _disks;
    private bool? _storageOptSize;

    /// <summary>
    /// Returns true when this id is a shared user computer and a restore has been started.
    /// The API supplies the database row. Contract tests leave it unset.
    /// </summary>
    public Func<ComputerId, CancellationToken, Task<bool>>? MissingComputer { get; set; }

    /// <summary>Runs after a restore is usable, so waiting tasks can be queued again.</summary>
    public Func<ComputerId, Task>? OnComputerRestored { get; set; }

    /// <summary>False when a configured isolation guard could not install TEAMS-ISO.</summary>
    public bool ComputerIsolationHealthy => Volatile.Read(ref _isolationHealthy) == 1;

    public string? ComputerIsolationDetail => _isolationDetail;

    public DockerComputeProvider(DockerComputeOptions options, IExecSecretResolver secrets, ISnapshotStore snapshots, ILogger<DockerComputeProvider>? logger = null)
    {
        _ = options.DnsServers(); // Reject invalid resolver configuration before creating resources.
        _options = options;
        _secrets = secrets;
        _snapshots = snapshots;
        _logger = logger ?? NullLogger<DockerComputeProvider>.Instance;
        var configuration = new DockerClientConfiguration(new Uri(options.DockerHost), null!, TimeSpan.FromMinutes(2), TimeSpan.FromSeconds(15), null);
        _client = configuration.CreateClient(new System.Version(1, 44));
        _isolationHealthy = string.IsNullOrWhiteSpace(options.IsolationSocket) ? 1 : 0;
        _disks = new LoopDisk(_client, options.ImageRef, options.CgroupParent);
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", options.ComputerToken);
        try { Reload(); }
        catch (Exception ex) { _logger.LogWarning("compute inventory not loaded yet: {Message}", ex.Message); }
    }

    public Task EnsureDiskToolsAsync(CancellationToken ct) => _disks.EnsureMkfsAsync(ct);

    public async Task<Computer> CreateComputerAsync(CreateComputerSpec spec, IdempotencyKey key, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(spec.ImageRef)) throw ComputeException.InvalidArgument("image is required");
        if (spec.Isolation is IsolationClass.Kata or IsolationClass.Firecracker)
            throw ComputeException.Unsupported("only docker isolation is offered");
        var hash = Fingerprint.Of("create", spec.Id.Value, spec.OwnerId, spec.ImageRef, spec.Limits.MemoryBytes, spec.Labels);
        if (_idempotency.TryGet<Computer>(key, hash, out var cached)) return cached!;
        using (await _gate.AcquireAsync(spec.Id.Value, key.Value, ct))
        {
            if (_idempotency.TryGet(key, hash, out cached)) return cached!;
            lock (_sync)
            {
                if (_rows.ContainsKey(spec.Id.Value)) throw ComputeException.AlreadyExists("computer already exists");
                if (_rows.Values.Count(row => row.Computer.State is ComputerState.Running or ComputerState.Provisioning) >= _options.MaxComputers)
                    throw ComputeException.ResourceExhausted("no computer capacity");
            }
            var name = ContainerName(spec.Id);
            var loop = spec.Limits.DiskBytes > 0;
            var quota = loop ? DiskQuota.Normalize(spec.Limits.DiskBytes) : 0;
            var workspace = (loop ? "tmimg" : "tmws") + Slug(spec.Id.Value);
            var profile = (loop ? "tmdata" : "tmpr") + Slug(spec.Id.Value);
            string? containerId = null;
            await EnsureComputerIsolationAsync(ct);
            try
            {
                _ = SeccompSecurityOpt();
                var labels = Labels(spec.Id, spec.OwnerId);
                foreach (var pair in spec.Labels) labels[pair.Key] = pair.Value;
                if (loop)
                {
                    labels["teammates.disk_backend"] = "loop";
                    labels["teammates.disk_bytes"] = quota.ToString();
                }
                await _client.Volumes.CreateAsync(new VolumesCreateParameters { Name = workspace, Labels = labels }, ct);
                await _client.Volumes.CreateAsync(new VolumesCreateParameters { Name = profile, Labels = labels }, ct);
                if (loop)
                {
                    await LoadStorageOptAsync(ct);
                    await _disks.MountAsync(workspace, profile, quota, ct);
                }
                var created = await _client.Containers.CreateContainerAsync(BuildCreate(spec, name, workspace, profile, loop, quota, labels), ct);
                containerId = created.ID;
                var started = await _client.Containers.StartContainerAsync(created.ID, new ContainerStartParameters(), ct);
                if (!started) throw ComputeException.Internal("docker did not start the computer");
                var computer = Record(spec.Id, spec.TenantId, spec.OwnerId, spec.ImageRef, ComputerState.Running, created.ID, [workspace, profile], labels, name);
                NoteDisk(computer.Id, loop, quota);
                _logger.LogInformation("computer created {ComputerId} container {Name}", spec.Id.Value, name);
                _idempotency.Remember(key, hash, computer);
                return computer;
            }
            catch (Exception ex)
            {
                if (loop) await _disks.UnmountAsync(workspace, profile, CancellationToken.None);
                await DiscardPartial(containerId, workspace, profile, ct);
                if (ex is ComputeException) throw;
                if (ex is DockerApiException api && api.Message.Contains("No such image", StringComparison.OrdinalIgnoreCase))
                    throw ComputeException.Unavailable("computer image is not present on the docker host");
                throw Map(ex);
            }
        }
    }

    public async Task<Computer> StartComputerAsync(ComputerId id, IdempotencyKey key, CancellationToken ct)
    {
        var hash = Fingerprint.Of("start", id.Value);
        if (_idempotency.TryGet<Computer>(key, hash, out var cached)) return cached!;
        using (await _gate.AcquireAsync(id.Value, key.Value, ct))
        {
            if (_idempotency.TryGet(key, hash, out cached)) return cached!;
            await EnsureComputerIsolationAsync(ct);
            var row = await DemandAsync(id, ct);
            if (row.Computer.State == ComputerState.Deleted) throw ComputeException.FailedPrecondition("computer is deleted");
            try
            {
                await EnsureDiskAsync(row, ct);
                var inspect = await _client.Containers.InspectContainerAsync(row.ContainerId, ct);
                if (inspect.State.Paused)
                    await _client.Containers.UnpauseContainerAsync(row.ContainerId, ct);
                else if (!inspect.State.Running)
                    await _client.Containers.StartContainerAsync(row.ContainerId, new ContainerStartParameters(), ct);
                lock (_sync) { row.Paused = false; row.Hibernated = false; }
                var computer = Update(id, ComputerState.Running);
                _idempotency.Remember(key, hash, computer);
                return computer;
            }
            catch (Exception ex) { await ThrowMapped(id, ex, ct); throw; }
        }
    }

    public async Task<Computer> StopComputerAsync(ComputerId id, StopOptions options, IdempotencyKey key, CancellationToken ct)
    {
        var hash = Fingerprint.Of("stop", id.Value, options.Force, (int)options.Grace.TotalSeconds);
        if (_idempotency.TryGet<Computer>(key, hash, out var cached)) return cached!;
        using (await _gate.AcquireAsync(id.Value, key.Value, ct))
        {
            if (_idempotency.TryGet(key, hash, out cached)) return cached!;
            var row = Require(id);
            if (row.Computer.State == ComputerState.Deleted) throw ComputeException.FailedPrecondition("computer is deleted");
            try
            {
                var inspect = await _client.Containers.InspectContainerAsync(row.ContainerId, ct);
                if (inspect.State.Paused)
                    await _client.Containers.UnpauseContainerAsync(row.ContainerId, ct);
                inspect = await _client.Containers.InspectContainerAsync(row.ContainerId, ct);
                if (inspect.State.Running)
                {
                    var seconds = options.Grace <= TimeSpan.Zero ? 10u : (uint)Math.Clamp((int)options.Grace.TotalSeconds, 1, 120);
                    await _client.Containers.StopContainerAsync(row.ContainerId, new ContainerStopParameters { WaitBeforeKillSeconds = seconds }, ct);
                }
                lock (_sync) { row.Paused = false; row.Hibernated = false; }
                var computer = Update(id, ComputerState.Stopped);
                _idempotency.Remember(key, hash, computer);
                return computer;
            }
            catch (ComputeException) { throw; }
            catch (Exception ex) { throw Map(ex); }
        }
    }

    public async Task<Computer> RestartComputerAsync(ComputerId id, IdempotencyKey key, CancellationToken ct)
    {
        var hash = Fingerprint.Of("restart", id.Value);
        if (_idempotency.TryGet<Computer>(key, hash, out var cached)) return cached!;
        using (await _gate.AcquireAsync(id.Value, key.Value, ct))
        {
            if (_idempotency.TryGet(key, hash, out cached)) return cached!;
            await EnsureComputerIsolationAsync(ct);
            var row = await DemandAsync(id, ct);
            try
            {
                await EnsureDiskAsync(row, ct);
                await _client.Containers.RestartContainerAsync(row.ContainerId, new ContainerRestartParameters { WaitBeforeKillSeconds = 10 }, ct);
                lock (_sync) { row.Paused = false; row.Hibernated = false; }
                var computer = Update(id, ComputerState.Running);
                _idempotency.Remember(key, hash, computer);
                return computer;
            }
            catch (Exception ex) { await ThrowMapped(id, ex, ct); throw; }
        }
    }

    public async Task<Computer> RecreateComputerAsync(ComputerId id, RecreateOptions options, IdempotencyKey key, CancellationToken ct)
    {
        var hash = Fingerprint.Of("recreate", id.Value, options.ImageRef, options.OwnerId);
        if (_idempotency.TryGet<Computer>(key, hash, out var cached)) return cached!;
        var row = TryGet(id);
        var owner = !string.IsNullOrWhiteSpace(row?.Computer.OwnerId) ? row!.Computer.OwnerId : options.OwnerId;
        // A process that never loaded the container still has the database row.
        // The caller passes that owner so recreate does not need the in-memory record.
        if (string.IsNullOrWhiteSpace(owner)) throw ComputeException.NotFound("computer not found");
        // The stored image is the digest from the last create. A rebuild
        // drops that digest, so recreate follows the configured tag.
        var image = string.IsNullOrWhiteSpace(options.ImageRef) ? _options.ImageRef : options.ImageRef;
        if (string.IsNullOrWhiteSpace(image)) image = row?.Computer.ImageRef ?? "";
        if (string.IsNullOrWhiteSpace(image)) throw ComputeException.InvalidArgument("image is required");
        var computer = await RestoreComputerAsync(id, owner, image, replace: true, options.DisplayName, ct);
        _idempotency.Remember(key, hash, computer);
        return computer;
    }

    public bool IsComputerReady(ComputerId id)
    {
        lock (_sync) return _ready.Contains(id.Value);
    }

    public bool IsComputerRestoring(ComputerId id) => _restores.ContainsKey(id.Value);

    /// <summary>
    /// Builds the container for an existing computer id. Volumes are created only
    /// when missing, so a deleted container keeps the workspace and profile.
    /// </summary>
    public Task<Computer> RestoreComputerAsync(ComputerId id, string ownerId, string? imageRef, bool replace, string? displayName, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(ownerId)) throw ComputeException.InvalidArgument("owner is required");
        var task = _restores.GetOrAdd(id.Value, _ => RestoreAndResume(id, ownerId, imageRef, replace, displayName));
        return task.WaitAsync(ct);
    }

    public async Task DeleteComputerAsync(ComputerId id, DeleteOptions options, IdempotencyKey key, CancellationToken ct)
    {
        var hash = Fingerprint.Of("delete", id.Value, options.RetainVolumes);
        if (_idempotency.TryGet<bool>(key, hash, out _)) return;
        using (await _gate.AcquireAsync(id.Value, key.Value, ct))
        {
            if (_idempotency.TryGet<bool>(key, hash, out _)) return;
            Row? row;
            lock (_sync)
            {
                if (_tombstones.ContainsKey(id.Value))
                {
                    _idempotency.Remember(key, hash, true);
                    return;
                }
                if (!_rows.Remove(id.Value, out row)) throw ComputeException.NotFound("computer not found");
                _tombstones[id.Value] = row.Computer.OwnerId;
            }
            try
            {
                await _client.Containers.RemoveContainerAsync(row!.ContainerId, new ContainerRemoveParameters { Force = true }, ct);
                if (!options.RetainVolumes)
                {
                    if (IsLoop(row) && row.Computer.VolumeIds.Count >= 2)
                        await _disks.UnmountAsync(row.Computer.VolumeIds[0], row.Computer.VolumeIds[1], ct);
                    foreach (var volume in row.Computer.VolumeIds)
                    {
                        try { await _client.Volumes.RemoveAsync(volume, true, ct); }
                        catch (DockerApiException) { /* already gone */ }
                    }
                }
            }
            catch (Exception ex) { throw Map(ex); }
            _idempotency.Remember(key, hash, true);
        }
    }

    public Task<Computer> GetComputerAsync(ComputerId id, CancellationToken ct)
    {
        lock (_sync)
        {
            if (_rows.TryGetValue(id.Value, out var row)) return Task.FromResult(row.Computer);
            if (_tombstones.TryGetValue(id.Value, out var owner))
                return Task.FromResult(new Computer(id, "local", owner, "", IsolationClass.Docker, ComputerState.Deleted, "", [], DateTimeOffset.UnixEpoch, DateTimeOffset.UtcNow, new Dictionary<string, string>()));
        }
        throw ComputeException.NotFound("computer not found");
    }

    public async Task<ComputerStatus> GetStatusAsync(ComputerId id, CancellationToken ct)
    {
        var deleted = false;
        lock (_sync) deleted = _tombstones.ContainsKey(id.Value);
        if (deleted)
            return new ComputerStatus(id, ComputerState.Deleted, [], DateTimeOffset.UtcNow);
        var row = await DemandAsync(id, ct);
        var computer = row.Computer;
        var components = new List<ComponentHealth> { new("docker", true, row.ContainerId[..Math.Min(12, row.ContainerId.Length)]) };
        try
        {
            var inspect = await _client.Containers.InspectContainerAsync(row.ContainerId, ct);
            if (inspect.State.Paused)
            {
                components.Add(new ComponentHealth("x", true, "paused"));
                components.Add(new ComponentHealth("chrome", true, "paused"));
                components.Add(new ComponentHealth("vnc", true, "paused"));
                return new ComputerStatus(id, ComputerState.Hibernated, components, DateTimeOffset.UtcNow);
            }
            if (!inspect.State.Running)
            {
                var asleep = false;
                lock (_sync) asleep = row.Hibernated || computer.State == ComputerState.Hibernated;
                components.Add(new ComponentHealth("x", true, asleep ? "hibernated" : "stopped"));
                components.Add(new ComponentHealth("chrome", true, asleep ? "hibernated" : "stopped"));
                components.Add(new ComponentHealth("vnc", true, asleep ? "hibernated" : "stopped"));
                return new ComputerStatus(id, asleep ? ComputerState.Hibernated : ComputerState.Stopped, components, DateTimeOffset.UtcNow);
            }
            var (code, stdout, _) = await Capture(row.ContainerId, ["curl", "-fsS", "http://127.0.0.1:7700/health"], TimeSpan.FromSeconds(4), ct);
            bool Flag(string name) => stdout.Contains($"\"{name}\": true", StringComparison.Ordinal) || stdout.Contains($"\"{name}\":true", StringComparison.Ordinal);
            components.Add(new ComponentHealth("x", code == 0 && Flag("x"), inspect.State.Status));
            components.Add(new ComponentHealth("chrome", code == 0 && Flag("chrome"), ""));
            components.Add(new ComponentHealth("vnc", code == 0 && Flag("vnc"), ""));
            var state = inspect.State.Running ? ComputerState.Running : computer.State == ComputerState.Stopped ? ComputerState.Stopped : ComputerState.Stopped;
            if (inspect.State.Running) state = ComputerState.Running;
            return new ComputerStatus(id, state, components, DateTimeOffset.UtcNow);
        }
        catch (Exception ex)
        {
            components.Add(new ComponentHealth("x", false, ex.GetType().Name));
            return new ComputerStatus(id, computer.State, components, DateTimeOffset.UtcNow);
        }
    }

    public async Task<ComputerMetrics> GetMetricsAsync(ComputerId id, CancellationToken ct)
    {
        var row = await DemandAsync(id, ct);
        var computer = row.Computer;
        if (computer.State is not (ComputerState.Running or ComputerState.Idle))
            throw ComputeException.FailedPrecondition("metrics require a running computer");
        var sample = await ReadStatsAsync(row.ContainerId, ct);
        var cpu = CpuRatio(sample);
        var memory = sample.MemoryStats?.Usage ?? 0;
        ulong disk = 0;
        var paused = false;
        lock (_sync) paused = row.Paused || row.Hibernated || row.Computer.State == ComputerState.Hibernated;
        try
        {
            if (paused) throw new InvalidOperationException("paused");
            disk = await ReadDiskUsedAsync(row, ct);
        }
        catch { /* disk is best-effort */ }
        return new ComputerMetrics(id, cpu, memory, disk, sample.NumProcs, 0, 0, 0, DateTimeOffset.UtcNow);
    }

    public async Task<(ulong? Used, bool Enforced)> TryDiskAsync(ComputerId id, CancellationToken ct)
    {
        Row row;
        try { row = Require(id); }
        catch (ComputeException) { return (null, false); }
        var enforced = IsLoop(row);
        var asleep = false;
        lock (_sync) asleep = row.Paused || row.Hibernated || row.Computer.State is not (ComputerState.Running or ComputerState.Idle);
        if (asleep) return (null, enforced);
        try { return (await ReadDiskUsedAsync(row, ct), enforced); }
        catch { return (null, enforced); }
    }

    public async Task<ulong> ReadMemoryBytesAsync(ComputerId id, CancellationToken ct)
    {
        var row = Require(id);
        lock (_sync)
        {
            if (row.Hibernated) return 0;
            if (!row.Paused && row.Computer.State is ComputerState.Stopped or ComputerState.Deleted) return 0;
        }
        var sample = await ReadStatsAsync(row.ContainerId, ct);
        return sample.MemoryStats?.Usage ?? 0;
    }

    private async Task<ContainerStatsResponse> ReadStatsAsync(string containerId, CancellationToken ct)
    {
        var tcs = new TaskCompletionSource<ContainerStatsResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
        var progress = new Progress<ContainerStatsResponse>(stats => tcs.TrySetResult(stats));
        await _client.Containers.GetContainerStatsAsync(containerId, new ContainerStatsParameters { Stream = false, OneShot = true }, progress, ct);
        return await tcs.Task.WaitAsync(TimeSpan.FromSeconds(10), ct);
    }

    public async Task<int> CountChromeAsync(ComputerId id, CancellationToken ct)
    {
        var row = await DemandAsync(id, ct);
        lock (_sync)
        {
            if (row.Paused || row.Hibernated || row.Computer.State == ComputerState.Hibernated) return 0;
        }
        try
        {
            var (_, stdout, _) = await Capture(row.ContainerId, ["ps", "-C", "chromium", "--no-headers"], TimeSpan.FromSeconds(4), ct);
            if (string.IsNullOrWhiteSpace(stdout)) return 0;
            return stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries).Length;
        }
        catch
        {
            return 0;
        }
    }

    public async IAsyncEnumerable<ExecEvent> ExecAsync(ExecSpec spec, IdempotencyKey key, [EnumeratorCancellation] CancellationToken ct)
    {
        if (spec.Argv.Count == 0) throw ComputeException.InvalidArgument("argv is required");
        if (spec.Stdin) throw ComputeException.Unsupported("exec.stdin is not negotiated");
        var hash = Fingerprint.Of("exec", spec.Id.Value, spec.Argv, spec.Cwd, spec.Env.OrderBy(pair => pair.Key), spec.SecretEnv.Select(binding => binding.EnvName + "=" + binding.SecretRef), spec.MaxOutputBytes, (int)spec.Timeout.TotalSeconds);
        if (_idempotency.TryGet<List<ExecEvent>>(key, hash, out var replay))
        {
            foreach (var item in replay) yield return item;
            yield break;
        }
        var row = await DemandAsync(spec.Id, ct);
        await WakeAsync(row, ct);
        var computer = await GetComputerAsync(spec.Id, ct);
        if (computer.State is not (ComputerState.Running or ComputerState.Idle))
            throw ComputeException.FailedPrecondition("exec requires a running computer");
        var secrets = await _secrets.ResolveAsync(spec.Id, spec.SecretEnv, ct);
        var events = new List<ExecEvent>();
        var sequence = 0UL;
        var startedAt = DateTimeOffset.UtcNow;
        var envMap = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            ["HOME"] = "/data/home/desk",
            ["LANG"] = "C.UTF-8"
        };
        foreach (var pair in spec.Env) envMap[pair.Key] = pair.Value;
        foreach (var pair in secrets) envMap[pair.Key] = pair.Value;
        var env = envMap.Select(pair => pair.Key + "=" + pair.Value).ToList();
        ContainerExecCreateResponse created;
        try
        {
            created = await _client.Exec.ExecCreateContainerAsync(row.ContainerId, new ContainerExecCreateParameters
            {
                AttachStdout = true,
                AttachStderr = true,
                Cmd = spec.Argv.ToList(),
                Env = env,
                WorkingDir = string.IsNullOrWhiteSpace(spec.Cwd) ? "/workspace" : spec.Cwd,
                User = string.IsNullOrWhiteSpace(spec.RunAs) ? "" : spec.RunAs
            }, ct);
        }
        catch (Exception ex) { await ThrowMapped(spec.Id, ex, ct); throw; }
        using var stream = await _client.Exec.StartAndAttachContainerExecAsync(created.ID, false, ct);
        var inspect = await _client.Exec.InspectContainerExecAsync(created.ID, ct);
        events.Add(new ExecStarted(++sequence, (uint)Math.Max(0, inspect.Pid)));
        yield return events[^1];
        var limit = spec.MaxOutputBytes == 0 ? 1_000_000UL : spec.MaxOutputBytes;
        var used = 0UL;
        var truncated = false;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        if (spec.Timeout > TimeSpan.Zero) timeout.CancelAfter(spec.Timeout);
        var buffer = new byte[8192];
        var timedOut = false;
        while (true)
        {
            MultiplexedStream.ReadResult read;
            try
            {
                read = await stream.ReadOutputAsync(buffer, 0, buffer.Length, timeout.Token);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                timedOut = true;
                break;
            }
            if (read.EOF || read.Count <= 0) break;
            var take = read.Count;
            if (used >= limit) { truncated = true; break; }
            if (used + (ulong)take > limit) { take = (int)(limit - used); truncated = true; }
            var slice = OutputRedactor.Redact(buffer.AsSpan(0, take).ToArray(), secrets.Values);
            used += (ulong)take;
            if (read.Target == MultiplexedStream.TargetStream.StandardError)
                events.Add(new ExecStderr(++sequence, slice));
            else
                events.Add(new ExecStdout(++sequence, slice));
            yield return events[^1];
            if (truncated) break;
        }
        if (timedOut)
        {
            await KillExec(row.ContainerId, inspect.Pid, CancellationToken.None);
            events.Add(new ExecError(++sequence, ComputeErrorCode.DeadlineExceeded, "exec timed out", true));
            yield return events[^1];
            _idempotency.Remember(key, hash, events);
            yield break;
        }
        var finished = await _client.Exec.InspectContainerExecAsync(created.ID, ct);
        events.Add(new ExecExited(++sequence, (int)finished.ExitCode, "", DateTimeOffset.UtcNow - startedAt, truncated));
        yield return events[^1];
        _idempotency.Remember(key, hash, events);
    }

    public async Task EnsureAwakeAsync(ComputerId id, CancellationToken ct)
    {
        await WakeAsync(await DemandAsync(id, ct), ct);
    }

    public void NoteViewer(ComputerId id)
    {
        var now = DateTimeOffset.UtcNow;
        lock (_sync)
        {
            if (!_rows.TryGetValue(id.Value, out var row)) return;
            row.LastActivity = now;
            var until = now.AddMinutes(2);
            if (row.ViewerUntil < until) row.ViewerUntil = until;
        }
    }

    public async Task ReleaseViewerAsync(string token, CancellationToken ct)
    {
        ComputerId? id = null;
        var stop = false;
        lock (_sync)
        {
            if (!_sessions.Remove(token, out var held)) return;
            id = held.Computer;
            stop = _rows.TryGetValue(held.Computer.Value, out var row)
                && row.ViewerRunning
                && !_sessions.Values.Any(item => item.Computer.Value == held.Computer.Value && item.Session.Mode != DesktopMode.Interactive && item.Session.ExpiresAt > DateTimeOffset.UtcNow);
        }
        if (!stop || id == null) return;
        try
        {
            await ControlAsync(id.Value, "/desktops/" + Uri.EscapeDataString(id.Value.Value) + "/viewer", "{\"up\":false}", ct);
        }
        catch
        {
            // The view server may already be down.
        }
        lock (_sync)
        {
            if (_rows.TryGetValue(id.Value.Value, out var row)) row.ViewerRunning = false;
        }
    }

    public async Task SuspendIdleAsync(IReadOnlySet<string> busy, TimeSpan idle, CancellationToken ct)
    {
        if (idle <= TimeSpan.Zero && _options.IdlePower != IdlePowerMode.Hibernate) return;
        var now = DateTimeOffset.UtcNow;
        var hibernate = new List<Row>();
        var pause = new List<Row>();
        lock (_sync)
        {
            foreach (var row in _rows.Values)
            {
                if (row.Hibernated || row.Computer.State is ComputerState.Stopped or ComputerState.Deleted) continue;
                var isBusy = busy.Contains(row.Computer.Id.Value);
                if (ComputerPower.ShouldHibernate(_options.IdlePower, now, row.LastActivity, row.ViewerUntil, isBusy, idle, _options.IdleHibernate))
                    hibernate.Add(row);
                else if (_options.IdlePower != IdlePowerMode.Hibernate && !row.Paused && row.Computer.State == ComputerState.Running
                    && ComputerPower.ShouldSuspend(now, row.LastActivity, row.ViewerUntil, isBusy, idle))
                    pause.Add(row);
            }
        }
        foreach (var row in hibernate)
        {
            try { await HibernateAsync(row, ct); }
            catch { /* a racing wake or a container that already exited */ }
        }
        foreach (var row in pause)
        {
            try { await PauseAsync(row, ct); }
            catch { /* a racing wake or a container that already exited */ }
        }
    }

    public async Task<IReadOnlyList<ComputerDisplay>> ListDisplaysAsync(ComputerId id, CancellationToken ct)
    {
        var json = await ControlAsync(id, "/desktops/" + Uri.EscapeDataString(id.Value) + "/displays", "{}", ct);
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.GetProperty("displays").EnumerateArray().Select(x => new ComputerDisplay(
            x.GetProperty("display").GetInt32(), x.GetProperty("width").GetInt32(),
            x.GetProperty("height").GetInt32(), x.GetProperty("ready").GetBoolean())).ToArray();
    }

    public async Task<DesktopSession> GetDesktopSessionAsync(ComputerId id, DesktopAccess access, CancellationToken ct)
    {
        if (access.Display is < 1 or > 2 || (access.Display == 2 && !_options.SecondDisplay))
            throw ComputeException.InvalidArgument("display must be enabled and be 1 or 2");
        var row = await DemandAsync(id, ct);
        await WakeAsync(row, ct);
        var computer = row.Computer;
        if (computer.State is not (ComputerState.Running or ComputerState.Idle))
            throw ComputeException.FailedPrecondition("desktop requires a running computer");
        if (access.Mode == DesktopMode.Interactive && !access.TakeoverLeaseHeld)
            throw ComputeException.FailedPrecondition("interactive desktop requires the takeover lease");
        ulong epoch;
        lock (_sync)
        {
            if (access.FencingEpoch != 0 && access.FencingEpoch < row.Epoch)
                throw ComputeException.FailedPrecondition("stale fencing epoch");
            if (access.FencingEpoch > row.Epoch) row.Epoch = access.FencingEpoch;
            if (row.Epoch == 0) row.Epoch = 1;
            epoch = row.Epoch;
        }
        var mode = access.Mode == DesktopMode.Unspecified ? DesktopMode.View : access.Mode;
        string desktopState;
        if (mode == DesktopMode.Interactive)
            desktopState = await ControlAsync(id, "/desktops/" + Uri.EscapeDataString(id.Value) + "/control",
                JsonSerializer.Serialize(new { holder = "human", epoch, display = access.Display }), ct);
        else
        {
            desktopState = await ControlAsync(id, "/desktops/" + Uri.EscapeDataString(id.Value) + "/viewer", JsonSerializer.Serialize(new { up = true, display = access.Display }), ct);
            lock (_sync) row.ViewerRunning = true;
        }
        var ttl = access.Ttl <= TimeSpan.Zero ? TimeSpan.FromMinutes(2) : access.Ttl;
        lock (_sync) row.ViewerUntil = DateTimeOffset.UtcNow.Add(ttl);
        var token = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
        var host = await HostOf(id, row, ct);
        using var state = JsonDocument.Parse(desktopState);
        var port = state.RootElement.GetProperty(mode == DesktopMode.Interactive ? "rwPort" : "viewPort").GetInt32();
        var session = new DesktopSession("/vnc/websockify?token=" + token, token, mode, epoch, DateTimeOffset.UtcNow.Add(ttl), host, port);
        lock (_sync) _sessions[token] = (session, id);
        return session;
    }

    public DesktopEndpoint RequireSession(string token, DateTimeOffset now)
    {
        lock (_sync)
        {
            if (!_sessions.TryGetValue(token, out var held))
                throw ComputeException.PermissionDenied("desktop token rejected");
            if (now > held.Session.ExpiresAt)
                throw ComputeException.FailedPrecondition("desktop token expired");
            if (_rows.TryGetValue(held.Computer.Value, out var row) && held.Session.FencingEpoch != row.Epoch)
                throw ComputeException.FailedPrecondition("stale fencing epoch");
            return new DesktopEndpoint(held.Computer, held.Session.Host, held.Session.Port, held.Session.Mode, held.Session.FencingEpoch, held.Session.ExpiresAt);
        }
    }

    public async Task<Snapshot> SnapshotAsync(ComputerId id, SnapshotOptions options, IdempotencyKey key, CancellationToken ct)
    {
        var hash = Fingerprint.Of("snapshot", id.Value, options.Label);
        if (_idempotency.TryGet<Snapshot>(key, hash, out var cached)) return cached!;
        using (await _gate.AcquireAsync(id.Value, key.Value, ct))
        {
            if (_idempotency.TryGet(key, hash, out cached)) return cached!;
            var row = Require(id);
            var snapshotId = Guid.NewGuid().ToString("n");
            var paused = false;
            try
            {
                try { await _client.Containers.PauseContainerAsync(row.ContainerId, ct); paused = true; }
                catch (DockerApiException) { /* snapshot still reads the volumes */ }
                ulong size = 0;
                size += await SavePath(row.ContainerId, snapshotId, "workspace", "/data/workspace", ct);
                size += await SavePath(row.ContainerId, snapshotId, "profile", "/data/profiles", ct);
                var snapshot = new Snapshot(new SnapshotId(snapshotId), id, size, DateTimeOffset.UtcNow);
                _idempotency.Remember(key, hash, snapshot);
                _logger.LogInformation("snapshot {SnapshotId} computer {ComputerId} bytes {Bytes}", snapshotId, id.Value, size);
                return snapshot;
            }
            finally
            {
                if (paused)
                {
                    try
                    {
                        await EnsureComputerIsolationAsync(CancellationToken.None);
                        await _client.Containers.UnpauseContainerAsync(row.ContainerId, CancellationToken.None);
                    }
                    catch (Exception ex) { _logger.LogWarning("unpause failed {Message}", ex.Message); }
                }
            }
        }
    }

    public async Task<Computer> RestoreAsync(ComputerId id, SnapshotId snapshot, IdempotencyKey key, CancellationToken ct)
    {
        var hash = Fingerprint.Of("restore", id.Value, snapshot.Value);
        if (_idempotency.TryGet<Computer>(key, hash, out var cached)) return cached!;
        using (await _gate.AcquireAsync(id.Value, key.Value, ct))
        {
            if (_idempotency.TryGet(key, hash, out cached)) return cached!;
            var row = Require(id);
            await EnsureComputerIsolationAsync(ct);
            try
            {
                var inspect = await _client.Containers.InspectContainerAsync(row.ContainerId, ct);
                if (inspect.State.Running)
                    await _client.Containers.StopContainerAsync(row.ContainerId, new ContainerStopParameters { WaitBeforeKillSeconds = 8 }, ct);
                await Extract(row.ContainerId, snapshot.Value, "workspace", "/data", ct);
                await Extract(row.ContainerId, snapshot.Value, "profile", "/data", ct);
                await _client.Containers.StartContainerAsync(row.ContainerId, new ContainerStartParameters(), ct);
                var computer = Update(id, ComputerState.Running);
                _idempotency.Remember(key, hash, computer);
                return computer;
            }
            catch (ComputeException) { throw; }
            catch (Exception ex) { throw Map(ex); }
        }
    }

    public async Task<Capacity> GetCapacityAsync(CapacityQuery query, CancellationToken ct)
    {
        try
        {
            var info = await _client.System.GetSystemInfoAsync(ct);
            int running;
            lock (_sync) running = _rows.Values.Count(row => row.Computer.State == ComputerState.Running);
            var vcpu = (uint)Math.Max(1, info.NCPU) * 1000;
            var memory = (ulong)Math.Max(0, info.MemTotal);
            return new Capacity(info.Name ?? "docker", vcpu, vcpu / 2, memory, memory / 2, 0, 0, (uint)running, (uint)_options.MaxComputers, false);
        }
        catch (Exception ex) { throw Map(ex); }
    }

    public async Task<HealthReport> HealthCheckAsync(CancellationToken ct)
    {
        try
        {
            await _client.System.PingAsync(ct);
            var version = "docker";
            try
            {
                var info = await _client.System.GetSystemInfoAsync(ct);
                version = info.ServerVersion ?? version;
            }
            catch { /* ping succeeded; version is optional */ }
            return new HealthReport(true, version, [new ComponentHealth("docker", true, "pong")]);
        }
        catch (Exception ex)
        {
            throw ComputeException.Unavailable("docker daemon unreachable: " + ex.GetType().Name);
        }
    }

    public async IAsyncEnumerable<ComputerStatusEvent> WatchStatusAsync(ComputerId id, [EnumeratorCancellation] CancellationToken ct)
    {
        ulong sequence = 0;
        string? previous = null;
        while (!ct.IsCancellationRequested)
        {
            var status = await GetStatusAsync(id, ct);
            var stamp = status.State + string.Join(',', status.Components.Select(component => component.Name + component.Healthy));
            if (stamp != previous)
            {
                previous = stamp;
                yield return new ComputerStatusEvent(status, ++sequence);
            }
            try { await Task.Delay(TimeSpan.FromSeconds(2), ct); }
            catch (OperationCanceledException) { yield break; }
        }
    }

    public async IAsyncEnumerable<ComputerMetrics> WatchMetricsAsync(ComputerId id, TimeSpan interval, [EnumeratorCancellation] CancellationToken ct)
    {
        var delay = interval <= TimeSpan.Zero ? TimeSpan.FromSeconds(5) : interval;
        while (!ct.IsCancellationRequested)
        {
            yield return await GetMetricsAsync(id, ct);
            try { await Task.Delay(delay, ct); }
            catch (OperationCanceledException) { yield break; }
        }
    }

    public async Task SetHolderAsync(ComputerId id, string holder, ulong epoch, CancellationToken ct)
    {
        var row = await DemandAsync(id, ct);
        lock (_sync) if (epoch > row.Epoch) row.Epoch = epoch;
        var safeHolder = holder is "human" or "agent" or "fenced" ? holder : "fenced";
        var payload = "{\"holder\":\"" + safeHolder + "\",\"epoch\":" + epoch + "}";
        await ControlAsync(id, "/desktops/" + Uri.EscapeDataString(id.Value) + "/control", payload, ct);
    }

    public Task<string> ControlAsync(ComputerId id, string path, string json, CancellationToken ct) =>
        ControlAsync(id, path, Encoding.UTF8.GetBytes(json), ct);

    public async Task<string> ControlAsync(ComputerId id, string path, ReadOnlyMemory<byte> json, CancellationToken ct)
    {
        var row = await DemandAsync(id, ct);
        await WakeAsync(row, ct);
        var host = await HostOf(id, row, ct);
        var url = "http://" + host + ":7700" + (path.StartsWith('/') ? path : "/" + path);
        var payload = json.ToArray();
        var deadline = DateTimeOffset.UtcNow.AddSeconds(20);
        try
        {
        while (true)
        {
            try
            {
                using var body = new ByteArrayContent(payload);
                body.Headers.ContentType = new MediaTypeHeaderValue("application/json");
                using var response = await _http.PostAsync(url, body, ct);
                var text = await response.Content.ReadAsStringAsync(ct);
                if (response.IsSuccessStatusCode) return text;
                var status = (int)response.StatusCode;
                if (status is 404 or 500 or 503 && DateTimeOffset.UtcNow < deadline)
                {
                    await Task.Delay(300, ct);
                    continue;
                }
                throw ComputeException.FailedPrecondition("computer control rejected the call");
            }
            catch (HttpRequestException) when (DateTimeOffset.UtcNow < deadline)
            {
                await Task.Delay(300, ct);
            }
        }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(payload);
        }
    }

    public ValueTask DisposeAsync()
    {
        _http.Dispose();
        _isolationHttp?.Dispose();
        _isolationGate.Dispose();
        _client.Dispose();
        return ValueTask.CompletedTask;
    }

    private CreateContainerParameters BuildCreate(CreateComputerSpec spec, string name, string workspace, string profile, bool loopDisk = false, ulong quotaBytes = 0, IReadOnlyDictionary<string, string>? labels = null)
    {
        var stamped = labels != null ? new Dictionary<string, string>(labels) : Labels(spec.Id, spec.OwnerId);
        if (labels == null)
            foreach (var pair in spec.Labels) stamped[pair.Key] = pair.Value;
        var security = new List<string>();
        var seccomp = SeccompSecurityOpt();
        if (seccomp != null) security.Add(seccomp);
        security.Add("apparmor=unconfined");
        var host = new HostConfig
        {
            Binds = loopDisk
                ? new List<string> { profile + ":/data" }
                : new List<string> { workspace + ":/data/workspace", profile + ":/data/profiles" },
            Tmpfs = new Dictionary<string, string> { ["/tmp"] = "rw,nosuid,nodev,size=64m" },
            DNS = _options.DnsServers().ToList(),
            ShmSize = 64L * 1024 * 1024,
            SecurityOpt = security,
            ExtraHosts = new List<string>
            {
                "portal.example.edu:127.0.0.1",
                "auth.example.edu:127.0.0.1",
                "evil.example:127.0.0.1",
                "portal.example.edu.evil.test:127.0.0.1"
            },
            Memory = spec.Limits.MemoryBytes > 0 ? (long)spec.Limits.MemoryBytes : _options.MemoryBytes,
            NanoCPUs = spec.Limits.VcpuMillis > 0 ? spec.Limits.VcpuMillis * 1_000_000L : _options.NanoCpus
        };
        host.MemorySwap = host.Memory;
        if (!string.IsNullOrWhiteSpace(_options.CgroupParent)) host.CgroupParent = _options.CgroupParent;
        if (loopDisk && quotaBytes > 0 && StorageOptSize())
            host.StorageOpt = new Dictionary<string, string> { ["size"] = quotaBytes.ToString() };
        var parameters = new CreateContainerParameters
        {
            Image = spec.ImageRef,
            Name = name,
            Hostname = name,
            Env = new List<string>
            {
                "COMPUTER_ID=" + spec.Id.Value,
                "COMPUTER_TOKEN=" + _options.ComputerToken,
                "COMPUTER_NAME=" + (spec.Labels.TryGetValue("name", out var label) ? label : "Teammate"),
                "DISPLAY_NUM=1",
                "COMPUTER_SECOND_DISPLAY=" + (_options.SecondDisplay ? "true" : "false"),
                // Chrome binds DevTools to 127.0.0.1. cdp-proxy publishes :9222.
                "CDP_PORT=9223",
                "VNC_VIEW_PORT=5900",
                "VNC_RW_PORT=6900",
                "DISPLAY_GEOMETRY=" + _options.DisplayGeometry,
                "DISPLAY_DEPTH=" + _options.DisplayDepth,
                "HOME=/data/home/desk"
            },
            Labels = stamped,
            ExposedPorts = new Dictionary<string, EmptyStruct>
            {
                ["7700/tcp"] = default,
                ["9222/tcp"] = default,
                ["5900/tcp"] = default,
                ["6900/tcp"] = default,
                ["6080/tcp"] = default,
                ["8099/tcp"] = default
            },
            HostConfig = host
        };
        if (!string.IsNullOrWhiteSpace(_options.NetworkName))
        {
            host.NetworkMode = _options.NetworkName;
            parameters.NetworkingConfig = new NetworkingConfig
            {
                EndpointsConfig = new Dictionary<string, EndpointSettings>
                {
                    [_options.NetworkName] = new EndpointSettings { Aliases = new List<string> { name } }
                }
            };
        }
        return parameters;
    }

    private bool StorageOptSize() => _storageOptSize == true;

    private async Task LoadStorageOptAsync(CancellationToken ct)
    {
        if (_storageOptSize.HasValue) return;
        try
        {
            var info = await _client.System.GetSystemInfoAsync(ct);
            string? backing = null;
            if (info.DriverStatus != null)
            {
                foreach (var row in info.DriverStatus)
                {
                    if (row == null || row.Length < 2) continue;
                    if (row[0].Contains("Backing", StringComparison.OrdinalIgnoreCase)) backing = row[1];
                }
            }
            _storageOptSize = DiskQuota.UseStorageOpt(info.Driver, backing);
        }
        catch
        {
            _storageOptSize = false;
        }
    }

    private async Task EnsureDiskAsync(Row row, CancellationToken ct)
    {
        if (!IsLoop(row) || row.Computer.VolumeIds.Count < 2) return;
        await _disks.MountAsync(row.Computer.VolumeIds[0], row.Computer.VolumeIds[1], DiskQuotaOf(row), ct);
    }

    private static bool IsLoop(Row row) =>
        row.LoopDisk || (row.Computer.Labels.TryGetValue("teammates.disk_backend", out var backend) && backend == "loop");

    private static ulong DiskQuotaOf(Row row)
    {
        if (row.DiskQuotaBytes > 0) return row.DiskQuotaBytes;
        return row.Computer.Labels.TryGetValue("teammates.disk_bytes", out var raw) && ulong.TryParse(raw, out var parsed)
            ? DiskQuota.Normalize(parsed)
            : DiskQuota.DefaultBytes;
    }

    private void NoteDisk(ComputerId id, bool loop, ulong quota)
    {
        if (!loop) return;
        lock (_sync)
        {
            if (!_rows.TryGetValue(id.Value, out var row)) return;
            row.LoopDisk = true;
            row.DiskQuotaBytes = quota;
        }
    }

    private async Task<ulong> ReadDiskUsedAsync(Row row, CancellationToken ct)
    {
        const string script = "src=$(findmnt -n -o SOURCE /data 2>/dev/null || true); case \"$src\" in /dev/loop*) df -B1 /data | awk 'NR==2{print $3}';; *) du -sb /data/workspace /data/home /data/profiles 2>/dev/null | awk '{s+=$1} END{print s+0}';; esac";
        var (_, stdout, _) = await Capture(row.ContainerId, ["sh", "-c", script], TimeSpan.FromSeconds(8), ct);
        var token = stdout.Split(new[] { '\t', ' ', '\n' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
        return ulong.TryParse(token, out var parsed) ? parsed : 0;
    }

    private async Task PauseAsync(Row row, CancellationToken ct)
    {
        lock (_sync)
        {
            if (row.Paused || row.Hibernated || row.Computer.State != ComputerState.Running) return;
        }
        await _client.Containers.PauseContainerAsync(row.ContainerId, ct);
        lock (_sync)
        {
            row.Paused = true;
            row.ViewerRunning = false;
            row.Computer = row.Computer with { State = ComputerState.Hibernated, UpdatedAt = DateTimeOffset.UtcNow };
        }
        if (_options.IdlePower == IdlePowerMode.Reclaim)
            await ReclaimAsync(row.ContainerId, ct);
    }

    private async Task HibernateAsync(Row row, CancellationToken ct)
    {
        // Mark hibernated before the stop. DemandAsync treats a stopped container
        // that is still Running as a crash and would recreate it.
        lock (_sync)
        {
            row.Paused = false;
            row.Hibernated = true;
            row.ViewerRunning = false;
            row.Computer = row.Computer with { State = ComputerState.Hibernated, UpdatedAt = DateTimeOffset.UtcNow };
        }
        var inspect = await _client.Containers.InspectContainerAsync(row.ContainerId, ct);
        if (inspect.State.Paused)
        {
            await RestoreMemoryHighAsync(row.ContainerId, ct);
            await _client.Containers.UnpauseContainerAsync(row.ContainerId, ct);
        }
        if (inspect.State.Running || inspect.State.Paused)
            await _client.Containers.StopContainerAsync(row.ContainerId, new ContainerStopParameters { WaitBeforeKillSeconds = 8 }, ct);
    }

    private async Task ReclaimAsync(string containerId, CancellationToken ct)
    {
        var dir = CgroupDir(containerId);
        if (dir == null) return;
        var reclaim = Path.Combine(dir, "memory.reclaim");
        var high = Path.Combine(dir, "memory.high");
        var stat = Path.Combine(dir, "memory.stat");
        if (!File.Exists(reclaim)) return;
        var fileBytes = 0L;
        if (File.Exists(stat))
        {
            foreach (var line in await File.ReadAllLinesAsync(stat, ct))
            {
                var parts = line.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length == 2 && parts[0] == "file" && long.TryParse(parts[1], out var parsed))
                    fileBytes = parsed;
            }
        }
        if (fileBytes > 0)
            await WriteCgroupAsync(reclaim, fileBytes.ToString(), TimeSpan.FromSeconds(2), ct);
        if (!File.Exists(high)) return;
        try
        {
            await WriteCgroupAsync(high, (32L * 1024 * 1024).ToString(), TimeSpan.FromSeconds(1), ct);
            await WriteCgroupAsync(reclaim, (256L * 1024 * 1024).ToString(), TimeSpan.FromSeconds(2), ct);
        }
        finally
        {
            await RestoreMemoryHighAsync(containerId, ct);
        }
    }

    private async Task RestoreMemoryHighAsync(string containerId, CancellationToken ct)
    {
        var dir = CgroupDir(containerId);
        if (dir == null) return;
        var high = Path.Combine(dir, "memory.high");
        if (File.Exists(high))
            await WriteCgroupAsync(high, "max", TimeSpan.FromSeconds(1), ct);
    }

    private string? CgroupDir(string containerId)
    {
        var root = string.IsNullOrWhiteSpace(_options.CgroupRoot) ? "/sys/fs/cgroup" : _options.CgroupRoot;
        var candidates = new List<string>();
        if (!string.IsNullOrWhiteSpace(_options.CgroupParent))
        {
            var parent = _options.CgroupParent.Trim('/');
            candidates.Add(Path.Combine(root, parent, containerId));
            candidates.Add(Path.Combine(root, parent, "docker-" + containerId + ".scope"));
        }
        candidates.Add(Path.Combine(root, "system.slice", "docker-" + containerId + ".scope"));
        candidates.Add(Path.Combine(root, "docker", containerId));
        return candidates.FirstOrDefault(Directory.Exists);
    }

    private static async Task WriteCgroupAsync(string path, string text, TimeSpan budget, CancellationToken ct)
    {
        try
        {
            using var proc = Process.Start(new ProcessStartInfo
            {
                FileName = "/bin/sh",
                ArgumentList = { "-c", "printf %s \"$1\" > \"$2\"", "sh", text, path },
                RedirectStandardError = true,
                UseShellExecute = false
            });
            if (proc == null) return;
            try
            {
                await proc.WaitForExitAsync(ct).WaitAsync(budget, ct);
            }
            catch (TimeoutException)
            {
                try { proc.Kill(entireProcessTree: true); } catch { /* already gone */ }
            }
        }
        catch
        {
            // The cgroup file is not writable from this process. Hibernate is the path that frees RAM.
        }
    }

    /// <summary>
    /// The engine API treats <c>seccomp=</c> as JSON. The Docker CLI reads the file
    /// and inlines it; a host path is decoded as JSON and rejected.
    /// </summary>
    private string? SeccompSecurityOpt()
    {
        if (_seccompOpt != null) return _seccompOpt.Length == 0 ? null : _seccompOpt;
        if (string.IsNullOrWhiteSpace(_options.SeccompPath))
        {
            _seccompOpt = "";
            return null;
        }
        if (!File.Exists(_options.SeccompPath))
            throw ComputeException.InvalidArgument("seccomp profile is not readable at " + _options.SeccompPath);
        using var document = JsonDocument.Parse(File.ReadAllText(_options.SeccompPath));
        _seccompOpt = "seccomp=" + JsonSerializer.Serialize(document.RootElement);
        return _seccompOpt;
    }

    private async Task DiscardPartial(string? containerId, string workspace, string profile, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(containerId))
        {
            try { await _client.Containers.RemoveContainerAsync(containerId, new ContainerRemoveParameters { Force = true }, ct); }
            catch { /* the create may have failed before an id existed */ }
        }
        try { await _client.Volumes.RemoveAsync(workspace, force: false, ct); } catch { /* volume may not exist */ }
        try { await _client.Volumes.RemoveAsync(profile, force: false, ct); } catch { /* volume may not exist */ }
    }

    private Computer Record(ComputerId id, string tenant, string owner, string image, ComputerState state, string containerId, IReadOnlyList<string> volumes, IReadOnlyDictionary<string, string> labels, string name, ulong epoch = 1)
    {
        var now = DateTimeOffset.UtcNow;
        var computer = new Computer(id, string.IsNullOrWhiteSpace(tenant) ? "local" : tenant, owner, image, IsolationClass.Docker, state, containerId, volumes, now, now, labels);
        lock (_sync)
        {
            _tombstones.Remove(id.Value);
            var epochValue = _rows.TryGetValue(id.Value, out var existing) ? existing.Epoch : epoch;
            _rows[id.Value] = new Row { Computer = computer, ContainerId = containerId, Name = name, Epoch = epochValue };
        }
        return computer;
    }

    private Computer Update(ComputerId id, ComputerState state)
    {
        lock (_sync)
        {
            var row = _rows[id.Value];
            row.Computer = row.Computer with { State = state, UpdatedAt = DateTimeOffset.UtcNow };
            return row.Computer;
        }
    }

    private Row? TryGet(ComputerId id)
    {
        lock (_sync) return _rows.TryGetValue(id.Value, out var row) ? row : null;
    }

    private Row Require(ComputerId id)
    {
        lock (_sync)
        {
            if (_rows.TryGetValue(id.Value, out var row)) return row;
        }
        throw ComputeException.NotFound("computer not found");
    }

    private async Task<Row> DemandAsync(ComputerId id, CancellationToken ct)
    {
        if (IsComputerRestoring(id) && !IsComputerReady(id))
        {
            await SignalMissing(id, ct);
            throw ComputeException.Recovering();
        }
        var deleted = false;
        Row? row;
        lock (_sync)
        {
            deleted = _tombstones.ContainsKey(id.Value);
            _rows.TryGetValue(id.Value, out row);
        }
        if (deleted) throw ComputeException.NotFound("computer not found");
        if (row == null)
        {
            await SignalMissing(id, ct);
            throw ComputeException.NotFound("computer not found");
        }
        try
        {
            var inspect = await _client.Containers.InspectContainerAsync(row.ContainerId, ct);
            bool hibernated;
            ComputerState remembered;
            lock (_sync)
            {
                hibernated = row.Hibernated || row.Computer.State == ComputerState.Hibernated;
                remembered = row.Computer.State;
            }
            var crashed = !hibernated && !inspect.State.Running && !inspect.State.Paused
                && remembered is ComputerState.Running or ComputerState.Idle or ComputerState.Provisioning;
            if (!crashed) return row;
        }
        catch (DockerApiException ex) when ((int)ex.StatusCode == 404)
        {
        }
        catch (Exception ex)
        {
            await ThrowMapped(id, ex, ct);
            throw;
        }
        // A stopped or deleted container must not be recreated until the firewall rules are back.
        await EnsureComputerIsolationAsync(ct);
        Forget(id);
        await SignalMissing(id, ct);
        throw ComputeException.NotFound("computer not found");
    }

    private async Task SignalMissing(ComputerId id, CancellationToken ct)
    {
        lock (_sync)
        {
            if (_tombstones.ContainsKey(id.Value)) return;
        }
        if (MissingComputer == null) return;
        if (await MissingComputer(id, ct)) throw ComputeException.Recovering();
    }

    private async Task ThrowMapped(ComputerId id, Exception ex, CancellationToken ct)
    {
        if (ex is ComputeException compute)
        {
            if (compute.Code == ComputeErrorCode.NotFound)
            {
                Forget(id);
                await SignalMissing(id, ct);
            }
            throw compute;
        }
        var mapped = Map(ex);
        if (mapped.Code == ComputeErrorCode.NotFound)
        {
            Forget(id);
            await SignalMissing(id, ct);
        }
        throw mapped;
    }

    private async Task<string> HostOf(ComputerId id, Row row, CancellationToken ct)
    {
        try { return await ReachableHost(row, ct); }
        catch (Exception ex)
        {
            await ThrowMapped(id, ex, ct);
            throw;
        }
    }

    private async Task<Computer> RestoreAndResume(ComputerId id, string ownerId, string? imageRef, bool replace, string? displayName)
    {
        try
        {
            var computer = await RestoreCore(id, ownerId, imageRef, replace, displayName, CancellationToken.None);
            if (OnComputerRestored != null)
            {
                try { await OnComputerRestored(id); }
                catch (Exception ex) { _logger.LogWarning("resume after computer restore failed {Message}", ex.Message); }
            }
            return computer;
        }
        finally
        {
            _restores.TryRemove(id.Value, out _);
        }
    }

    private async Task<IDisposable> AcquireRestore(ComputerId id, CancellationToken ct)
    {
        for (var attempt = 0; ; attempt++)
        {
            try { return await _gate.AcquireAsync(id.Value, "restore-" + id.Value, ct); }
            catch (ComputeException ex) when (ex.Code == ComputeErrorCode.Conflict && attempt < 25)
            {
                await Task.Delay(100, ct);
            }
        }
    }

    private async Task<Computer> RestoreCore(ComputerId id, string ownerId, string? imageRef, bool replace, string? displayName, CancellationToken ct)
    {
        using (await AcquireRestore(id, ct))
        {
            lock (_sync)
            {
                if (_tombstones.ContainsKey(id.Value)) throw ComputeException.FailedPrecondition("computer is deleted");
            }
            await EnsureComputerIsolationAsync(ct);
            var row = TryGet(id);
            var name = row?.Name ?? ContainerName(id);
            var loop = (row != null && IsLoop(row)) || await VolumeExists("tmimg" + Slug(id.Value), ct);
            var workspace = loop ? VolumeName(row, "tmimg", id) : VolumeName(row, "tmws", id);
            var profile = loop ? VolumeName(row, "tmdata", id) : VolumeName(row, "tmpr", id);
            var quota = loop ? (row == null ? DiskQuota.DefaultBytes : DiskQuotaOf(row)) : 0UL;
            var epoch = row?.Epoch ?? 1UL;
            var labels = new Dictionary<string, string>();
            if (row != null)
            {
                foreach (var pair in row.Computer.Labels)
                    if (!pair.Key.StartsWith("teammates.", StringComparison.Ordinal)) labels[pair.Key] = pair.Value;
            }
            foreach (var pair in Labels(id, ownerId)) labels[pair.Key] = pair.Value;
            if (loop)
            {
                labels["teammates.disk_backend"] = "loop";
                labels["teammates.disk_bytes"] = quota.ToString();
            }
            if (!string.IsNullOrWhiteSpace(displayName)) labels["name"] = displayName;
            var image = string.IsNullOrWhiteSpace(imageRef) ? _options.ImageRef : imageRef;
            if (string.IsNullOrWhiteSpace(image)) image = row?.Computer.ImageRef ?? "";
            if (string.IsNullOrWhiteSpace(image)) throw ComputeException.InvalidArgument("image is required");
            if (!replace)
            {
                try
                {
                    var existing = await _client.Containers.InspectContainerAsync(name, ct);
                    if (existing.State.Running || existing.State.Paused)
                    {
                        var adopted = Record(id, row?.Computer.TenantId ?? "local", ownerId, image, existing.State.Paused ? ComputerState.Hibernated : ComputerState.Running, existing.ID, [workspace, profile], labels, name, epoch);
                        lock (_sync)
                        {
                            if (_rows.TryGetValue(id.Value, out var adoptedRow))
                            {
                                adoptedRow.Paused = existing.State.Paused;
                                adoptedRow.Hibernated = false;
                                if (loop)
                                {
                                    adoptedRow.LoopDisk = true;
                                    adoptedRow.DiskQuotaBytes = quota;
                                }
                            }
                        }
                        MarkReady(id);
                        _logger.LogInformation("computer still present {ComputerId} container {Name}", id.Value, name);
                        return adopted;
                    }
                }
                catch (DockerApiException ex) when ((int)ex.StatusCode == 404)
                {
                }
            }
            _logger.LogInformation("computer restore started {ComputerId} container {Name}", id.Value, name);
            await RemoveNamed(name, row?.ContainerId, ct);
            Forget(id);
            await EnsureVolume(workspace, id, ownerId, ct);
            await EnsureVolume(profile, id, ownerId, ct);
            if (loop)
            {
                await LoadStorageOptAsync(ct);
                await _disks.MountAsync(workspace, profile, quota, ct);
            }
            var spec = new CreateComputerSpec(id, row?.Computer.TenantId ?? "local", ownerId, image, IsolationClass.Docker, new ResourceLimits((uint)(_options.NanoCpus / 1_000_000), (ulong)_options.MemoryBytes, quota, 256), "", labels);
            var created = await _client.Containers.CreateContainerAsync(BuildCreate(spec, name, workspace, profile, loop, quota, labels), ct);
            var started = await _client.Containers.StartContainerAsync(created.ID, new ContainerStartParameters(), ct);
            if (!started) throw ComputeException.Internal("docker did not start the computer");
            var computer = Record(id, spec.TenantId, ownerId, image, ComputerState.Running, created.ID, [workspace, profile], labels, name, epoch);
            NoteDisk(id, loop, quota);
            await WaitUntilUsable(created.ID, ct);
            MarkReady(id);
            _logger.LogInformation("computer restored {ComputerId} container {Name}", id.Value, name);
            return computer;
        }
    }

    private async Task WaitUntilUsable(string containerId, CancellationToken ct)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(45);
        Exception? last = null;
        while (DateTimeOffset.UtcNow < deadline)
        {
            try
            {
                var (code, _, _) = await Capture(containerId, ["python3", "-c", "import os; assert os.path.isdir('/workspace'); print('ready')"], TimeSpan.FromSeconds(4), ct);
                if (code == 0) return;
            }
            catch (Exception ex) { last = ex; }
            try { await Task.Delay(500, ct); }
            catch (OperationCanceledException) { break; }
        }
        _logger.LogWarning("computer restore did not become usable {Message}", last?.Message);
        throw ComputeException.Recovering();
    }

    private async Task<bool> VolumeExists(string name, CancellationToken ct)
    {
        try
        {
            await _client.Volumes.InspectAsync(name, ct);
            return true;
        }
        catch (DockerApiException ex) when ((int)ex.StatusCode == 404)
        {
            return false;
        }
    }

    private async Task EnsureVolume(string name, ComputerId id, string owner, CancellationToken ct)
    {
        try
        {
            await _client.Volumes.CreateAsync(new VolumesCreateParameters { Name = name, Labels = Labels(id, owner) }, ct);
        }
        catch (DockerApiException ex) when ((int)ex.StatusCode == 409 || ex.Message.Contains("already exists", StringComparison.OrdinalIgnoreCase))
        {
        }
    }

    private async Task RemoveNamed(string name, string? containerId, CancellationToken ct)
    {
        foreach (var target in new[] { containerId, name })
        {
            if (string.IsNullOrWhiteSpace(target)) continue;
            try
            {
                await _client.Containers.RemoveContainerAsync(target, new ContainerRemoveParameters { Force = true, RemoveVolumes = false }, ct);
            }
            catch (DockerApiException ex) when ((int)ex.StatusCode == 404)
            {
            }
        }
    }

    private static string VolumeName(Row? row, string prefix, ComputerId id)
    {
        var match = row?.Computer.VolumeIds.FirstOrDefault(volume => volume.StartsWith(prefix, StringComparison.Ordinal));
        return string.IsNullOrWhiteSpace(match) ? prefix + Slug(id.Value) : match;
    }

    private void MarkReady(ComputerId id)
    {
        lock (_sync) _ready.Add(id.Value);
    }

    private void Forget(ComputerId id)
    {
        lock (_sync)
        {
            _rows.Remove(id.Value);
            _ready.Remove(id.Value);
        }
    }

    private void Reload()
    {
        var list = _client.Containers.ListContainersAsync(new ContainersListParameters
        {
            All = true,
            Filters = new Dictionary<string, IDictionary<string, bool>>
            {
                ["label"] = new Dictionary<string, bool> { [ManagedLabel + "=1"] = true }
            }
        }).GetAwaiter().GetResult();
        foreach (var item in list)
        {
            if (item.Labels == null || !item.Labels.TryGetValue("teammates.computer_id", out var id) || string.IsNullOrWhiteSpace(id))
                continue;
            item.Labels.TryGetValue("teammates.owner_id", out var owner);
            var labels = new Dictionary<string, string>(item.Labels);
            // The quota image is not bind-mounted, so Docker's mount list only has the data volume.
            var volumes = labels.TryGetValue("teammates.disk_backend", out var diskBackend) && diskBackend == "loop"
                ? new List<string> { "tmimg" + Slug(id), "tmdata" + Slug(id) }
                : (item.Mounts?.Select(mount => mount.Name).Where(name => !string.IsNullOrWhiteSpace(name)).Cast<string>().ToList() ?? []);
            var paused = string.Equals(item.State, "paused", StringComparison.OrdinalIgnoreCase);
            var exited = item.State is "exited" or "created" or "dead";
            var state = item.State == "running" ? ComputerState.Running : paused || exited ? ComputerState.Hibernated : ComputerState.Stopped;
            var name = item.Names?.Select(value => value.TrimStart('/')).FirstOrDefault(value => value.StartsWith("tm", StringComparison.Ordinal)) ?? ContainerName(new ComputerId(id));
            Record(new ComputerId(id), "local", owner ?? "", item.Image, state, item.ID, volumes, labels, name);
            if (state == ComputerState.Running || paused) MarkReady(new ComputerId(id));
            lock (_sync)
            {
                if (_rows.TryGetValue(id, out var loaded))
                {
                    loaded.Paused = paused;
                    loaded.Hibernated = exited;
                    loaded.LoopDisk = labels.TryGetValue("teammates.disk_backend", out var backend) && backend == "loop";
                    if (labels.TryGetValue("teammates.disk_bytes", out var raw) && ulong.TryParse(raw, out var quota))
                        loaded.DiskQuotaBytes = quota;
                }
            }
        }
    }

    private async Task<(int Code, string Stdout, string Stderr)> Capture(string containerId, IList<string> argv, TimeSpan timeout, CancellationToken ct)
    {
        var created = await _client.Exec.ExecCreateContainerAsync(containerId, new ContainerExecCreateParameters
        {
            AttachStdout = true,
            AttachStderr = true,
            Cmd = argv
        }, ct);
        using var stream = await _client.Exec.StartAndAttachContainerExecAsync(created.ID, false, ct);
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(timeout);
        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        var buffer = new byte[4096];
        while (true)
        {
            var read = await stream.ReadOutputAsync(buffer, 0, buffer.Length, timeoutCts.Token);
            if (read.EOF || read.Count <= 0) break;
            var text = Encoding.UTF8.GetString(buffer, 0, read.Count);
            if (read.Target == MultiplexedStream.TargetStream.StandardError) stderr.Append(text);
            else stdout.Append(text);
        }
        var info = await _client.Exec.InspectContainerExecAsync(created.ID, ct);
        return ((int)info.ExitCode, stdout.ToString(), stderr.ToString());
    }

    private async Task KillExec(string containerId, long pid, CancellationToken ct)
    {
        if (pid <= 0) return;
        try
        {
            var created = await _client.Exec.ExecCreateContainerAsync(containerId, new ContainerExecCreateParameters
            {
                Cmd = new List<string> { "kill", "-9", pid.ToString() }
            }, ct);
            await _client.Exec.StartContainerExecAsync(created.ID, ct);
        }
        catch { /* the timed-out process may already have exited */ }
    }

    private async Task<ulong> SavePath(string containerId, string snapshotId, string name, string path, CancellationToken ct)
    {
        var archive = await _client.Containers.GetArchiveFromContainerAsync(containerId, new GetArchiveFromContainerParameters { Path = path }, false, ct);
        await using var copy = new MemoryStream();
        await archive.Stream.CopyToAsync(copy, ct);
        copy.Position = 0;
        var length = (ulong)copy.Length;
        await _snapshots.SaveAsync(snapshotId, name + ".tar", copy, ct);
        return length;
    }

    private async Task Extract(string containerId, string snapshotId, string name, string destination, CancellationToken ct)
    {
        await using var stream = await _snapshots.OpenAsync(snapshotId, name + ".tar", ct);
        await _client.Containers.ExtractArchiveToContainerAsync(containerId, new ContainerPathStatParameters { Path = destination, AllowOverwriteDirWithFile = true }, stream, ct);
    }

    private async Task<string> ReachableHost(Row row, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(_options.NetworkName)) return row.Name;
        var inspect = await _client.Containers.InspectContainerAsync(row.ContainerId, ct);
        if (!string.IsNullOrWhiteSpace(inspect.NetworkSettings?.IPAddress)) return inspect.NetworkSettings.IPAddress;
        var address = inspect.NetworkSettings?.Networks?.Values.Select(endpoint => endpoint.IPAddress).FirstOrDefault(value => !string.IsNullOrWhiteSpace(value));
        if (!string.IsNullOrWhiteSpace(address)) return address;
        throw ComputeException.Unavailable("computer has no reachable address");
    }

    private static Dictionary<string, string> Labels(ComputerId id, string owner) => new()
    {
        [ManagedLabel] = "1",
        ["teammates.computer_id"] = id.Value,
        ["teammates.owner_id"] = owner,
        ["teammates.role"] = "user-computer"
    };

    public static string ContainerName(ComputerId id) => "tm" + Slug(id.Value);

    private static string Slug(string value)
    {
        var chars = value.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray();
        var slug = new string(chars);
        if (slug.Length == 0) slug = "computer";
        return slug.Length > 48 ? slug[..48] : slug;
    }

    private static double CpuRatio(ContainerStatsResponse sample)
    {
        var cpu = sample.CPUStats?.CPUUsage?.TotalUsage ?? 0;
        var pre = sample.PreCPUStats?.CPUUsage?.TotalUsage ?? 0;
        var system = sample.CPUStats?.SystemUsage ?? 0;
        var preSystem = sample.PreCPUStats?.SystemUsage ?? 0;
        if (system <= preSystem || cpu <= pre) return 0;
        var online = sample.CPUStats?.OnlineCPUs ?? 1;
        return Math.Max(0, (double)(cpu - pre) / (system - preSystem) * online);
    }

    private static ComputeException Map(Exception exception)
    {
        if (exception is ComputeException compute) return compute;
        if (exception is DockerApiException api)
        {
            var status = (int)api.StatusCode;
            if (status == 404) return ComputeException.NotFound(api.Message);
            if (status == 409) return ComputeException.Conflict(api.Message);
            return ComputeException.Internal(api.StatusCode + " " + api.Message);
        }
        if (exception is HttpRequestException or System.Net.Sockets.SocketException or TaskCanceledException)
            return ComputeException.Unavailable("docker daemon unreachable");
        return ComputeException.Internal(exception.GetType().Name);
    }

    /// <summary>
    /// Asks the host guard to install TEAMS-ISO if Docker cleared it.
    /// A missing socket skips the check. A guard that cannot install the rules
    /// refuses the start and leaves the computer stopped.
    /// </summary>
    public async Task EnsureComputerIsolationAsync(CancellationToken ct, int attempts = 3)
    {
        if (string.IsNullOrWhiteSpace(_options.IsolationSocket)) return;
        if (attempts < 1) attempts = 1;
        await _isolationGate.WaitAsync(ct);
        try
        {
            Exception? last = null;
            for (var attempt = 1; attempt <= attempts; attempt++)
            {
                try
                {
                    await SendEnsureAsync(ct);
                    var recovered = Volatile.Read(ref _isolationHealthy) == 0;
                    Volatile.Write(ref _isolationHealthy, 1);
                    _isolationDetail = null;
                    if (recovered) _logger.LogInformation("computer isolation rules are installed");
                    return;
                }
                catch (Exception ex) when (ex is not OperationCanceledException && attempt < attempts)
                {
                    last = ex;
                    await Task.Delay(TimeSpan.FromMilliseconds(200), ct);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    last = ex;
                }
            }
            Volatile.Write(ref _isolationHealthy, 0);
            _isolationDetail = "Computer isolation rules are missing and could not be reinstalled.";
            _logger.LogError("computer isolation alert: {Detail}", last?.Message ?? _isolationDetail);
            throw ComputeException.IsolationMissing();
        }
        finally
        {
            _isolationGate.Release();
        }
    }

    private async Task SendEnsureAsync(CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "http://127.0.0.1/ensure")
        {
            Version = HttpVersion.Version11,
            VersionPolicy = HttpVersionPolicy.RequestVersionExact,
            Content = new ByteArrayContent(Array.Empty<byte>()),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _options.IsolationToken ?? "");
        using var response = await IsolationHttp().SendAsync(request, ct);
        var body = await response.Content.ReadAsStringAsync(ct);
        var installed = body.Contains("\"ok\":true", StringComparison.Ordinal) || body.Contains("\"ok\": true", StringComparison.Ordinal);
        if (response.StatusCode != HttpStatusCode.OK || !installed)
            throw new InvalidOperationException($"isolation guard returned {(int)response.StatusCode}");
    }

    private HttpClient IsolationHttp()
    {
        if (_isolationHttp != null) return _isolationHttp;
        var handler = new SocketsHttpHandler
        {
            ConnectCallback = async (_, token) =>
            {
                var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
                try
                {
                    await socket.ConnectAsync(new UnixDomainSocketEndPoint(_options.IsolationSocket!), token);
                    return new NetworkStream(socket, ownsSocket: true);
                }
                catch
                {
                    socket.Dispose();
                    throw;
                }
            }
        };
        _isolationHttp = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(8) };
        return _isolationHttp;
    }

    private async Task WakeAsync(Row row, CancellationToken ct)
    {
        lock (_sync) row.LastActivity = DateTimeOffset.UtcNow;
        var inspect = await _client.Containers.InspectContainerAsync(row.ContainerId, ct);
        if (inspect.State.Running && !inspect.State.Paused)
        {
            lock (_sync) { row.Paused = false; row.Hibernated = false; }
            return;
        }
        await EnsureComputerIsolationAsync(ct);
        var started = DateTimeOffset.UtcNow;
        if (inspect.State.Paused)
        {
            await RestoreMemoryHighAsync(row.ContainerId, ct);
            try { await _client.Containers.UnpauseContainerAsync(row.ContainerId, ct); }
            catch (DockerApiException ex) when (ex.Message.Contains("not paused", StringComparison.OrdinalIgnoreCase)) { }
        }
        else
        {
            if (DiskQuota.MountOnResume(inspect.State.Paused))
                await EnsureDiskAsync(row, ct);
            await _client.Containers.StartContainerAsync(row.ContainerId, new ContainerStartParameters(), ct);
            var deadline = DateTimeOffset.UtcNow.Add(_options.ResumeTarget <= TimeSpan.Zero ? TimeSpan.FromSeconds(15) : _options.ResumeTarget);
            while (DateTimeOffset.UtcNow < deadline && !ct.IsCancellationRequested)
            {
                try
                {
                    var (code, _, _) = await Capture(row.ContainerId, ["curl", "-fsS", "http://127.0.0.1:7700/health"], TimeSpan.FromSeconds(2), ct);
                    if (code == 0) break;
                }
                catch { /* the process is still coming up */ }
                await Task.Delay(300, ct);
            }
            _logger.LogInformation("computer resumed {ComputerId} in {Milliseconds} ms", row.Computer.Id.Value, (DateTimeOffset.UtcNow - started).TotalMilliseconds);
        }
        lock (_sync)
        {
            row.Paused = false;
            row.Hibernated = false;
            if (row.Computer.State is ComputerState.Hibernated or ComputerState.Stopped)
                row.Computer = row.Computer with { State = ComputerState.Running, UpdatedAt = DateTimeOffset.UtcNow };
        }
    }

    private sealed class Row
    {
        public required Computer Computer { get; set; }
        public required string ContainerId { get; set; }
        public required string Name { get; set; }
        public ulong Epoch { get; set; } = 1;
        public DateTimeOffset LastActivity { get; set; } = DateTimeOffset.UtcNow;
        public DateTimeOffset ViewerUntil { get; set; }
        public bool Paused { get; set; }
        public bool Hibernated { get; set; }
        public bool LoopDisk { get; set; }
        public ulong DiskQuotaBytes { get; set; }
        public bool ViewerRunning { get; set; }
    }
}
