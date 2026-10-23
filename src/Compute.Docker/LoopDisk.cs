using System.Text;
using Docker.DotNet;
using Docker.DotNet.Models;

namespace Teammates.Compute;

/// <summary>
/// Sized ext4 image on a Docker volume, attached with a host loop device.
/// The container bind-mounts the mounted filesystem and does not need extra capabilities.
/// <c>storage-opt size</c> does not apply to volumes, and on overlayfs it does not cap the rootfs either.
/// </summary>
public static class DiskFormat
{
    public const string MissingMessage = "mkfs.ext4 is missing from the computer image; install e2fsprogs";

    public static string Script(ulong bytes)
    {
        var size = DiskQuota.Normalize(bytes);
        var script = new StringBuilder();
        script.AppendLine("set -eu");
        script.AppendLine("img=/quota/quota.img");
        script.AppendLine("mkdir -p /quota");
        script.AppendLine("if [ -s \"$img\" ]; then exit 0; fi");
        script.Append("truncate -s ").Append(size).AppendLine(" \"$img\"");
        script.Append("if [ ").Append(size).AppendLine(" -ge 1073741824 ]; then");
        script.AppendLine("  /usr/sbin/mkfs.ext4 -F -q -m 0 -i 262144 \"$img\"");
        script.AppendLine("else");
        script.AppendLine("  /usr/sbin/mkfs.ext4 -F -q -m 0 \"$img\"");
        script.AppendLine("fi");
        return script.ToString();
    }
}

sealed class LoopDisk
{
    private readonly DockerClient _client;
    private readonly string _image;
    private readonly string? _cgroupParent;
    private int _mkfsOk;

    public LoopDisk(DockerClient client, string image, string? cgroupParent)
    {
        _client = client;
        _image = image;
        _cgroupParent = cgroupParent;
    }

    public async Task EnsureMkfsAsync(CancellationToken ct)
    {
        if (Volatile.Read(ref _mkfsOk) == 1) return;
        if (string.IsNullOrWhiteSpace(_image))
            throw ComputeException.Internal(DiskFormat.MissingMessage);
        var logs = await Run(
            ["/bin/sh", "-c"],
            ["test -x /usr/sbin/mkfs.ext4"],
            null,
            ct);
        if (logs.StatusCode != 0)
            throw ComputeException.Internal(DiskFormat.MissingMessage + ": " + Trim(logs.Text));
        Volatile.Write(ref _mkfsOk, 1);
    }

    public async Task MountAsync(string imageVolume, string dataVolume, ulong bytes, CancellationToken ct)
    {
        await EnsureMkfsAsync(ct);
        await FormatAsync(imageVolume, bytes, ct);
        var imagePath = await Mountpoint(imageVolume, ct);
        var dataPath = await Mountpoint(dataVolume, ct);
        var script = new StringBuilder();
        script.AppendLine("set -eu");
        script.Append("img=").Append(Quote(imagePath + "/quota.img")).AppendLine();
        script.Append("dest=").Append(Quote(dataPath)).AppendLine();
        script.AppendLine("if findmnt -n \"$dest\" >/dev/null 2>&1; then exit 0; fi");
        script.AppendLine("mkdir -p \"$dest\"");
        script.AppendLine("if [ ! -s \"$img\" ]; then echo 'quota image was not formatted'; exit 1; fi");
        script.AppendLine("loop=$(losetup -j \"$img\" | head -n 1 | cut -d: -f1)");
        script.AppendLine("if [ -z \"$loop\" ]; then loop=$(losetup -f --show \"$img\"); fi");
        script.AppendLine("mount \"$loop\" \"$dest\"");
        await RunOnHost(script.ToString(), ct);
    }

    private async Task FormatAsync(string imageVolume, ulong bytes, CancellationToken ct)
    {
        var ran = await Run(
            ["/bin/sh", "-c"],
            [DiskFormat.Script(bytes)],
            [imageVolume + ":/quota"],
            ct);
        if (ran.StatusCode == 0) return;
        var text = Trim(ran.Text);
        if (text.Contains("not found", StringComparison.Ordinal))
            throw ComputeException.Internal(DiskFormat.MissingMessage + ": " + text);
        throw ComputeException.Internal("disk setup failed: " + text);
    }

    public async Task UnmountAsync(string imageVolume, string dataVolume, CancellationToken ct)
    {
        string imagePath;
        string dataPath;
        try
        {
            imagePath = await Mountpoint(imageVolume, ct);
            dataPath = await Mountpoint(dataVolume, ct);
        }
        catch (DockerApiException)
        {
            return;
        }
        var script = new StringBuilder();
        script.AppendLine("set -eu");
        script.Append("img=").Append(Quote(imagePath + "/quota.img")).AppendLine();
        script.Append("dest=").Append(Quote(dataPath)).AppendLine();
        script.AppendLine("if findmnt -n \"$dest\" >/dev/null 2>&1; then umount \"$dest\" || umount -l \"$dest\"; fi");
        script.AppendLine("loop=$(losetup -j \"$img\" | head -n 1 | cut -d: -f1 || true)");
        script.AppendLine("if [ -n \"${loop:-}\" ]; then losetup -d \"$loop\" || true; fi");
        try { await RunOnHost(script.ToString(), ct); }
        catch { /* the volume may already be gone */ }
    }

    private async Task<string> Mountpoint(string name, CancellationToken ct)
    {
        var volume = await _client.Volumes.InspectAsync(name, ct);
        if (string.IsNullOrWhiteSpace(volume.Mountpoint))
            throw ComputeException.Internal("docker volume has no mountpoint");
        return volume.Mountpoint;
    }

    private Task RunOnHost(string script, CancellationToken ct) =>
        RunChecked(
            ["/usr/bin/nsenter"],
            ["-t", "1", "-m", "-r", "--", "sh", "-c", script],
            null,
            privileged: true,
            pidHost: true,
            ct);

    private async Task<(long StatusCode, string Text)> Run(IList<string> entrypoint, IList<string> cmd, IList<string>? binds, CancellationToken ct)
    {
        var created = await _client.Containers.CreateContainerAsync(new CreateContainerParameters
        {
            Image = _image,
            Entrypoint = entrypoint,
            Cmd = cmd,
            Tty = true,
            HostConfig = Host(binds, privileged: false, pidHost: false)
        }, ct);
        return await Finish(created.ID, ct);
    }

    private async Task RunChecked(IList<string> entrypoint, IList<string> cmd, IList<string>? binds, bool privileged, bool pidHost, CancellationToken ct)
    {
        var created = await _client.Containers.CreateContainerAsync(new CreateContainerParameters
        {
            Image = _image,
            Entrypoint = entrypoint,
            Cmd = cmd,
            Tty = true,
            HostConfig = Host(binds, privileged, pidHost)
        }, ct);
        var ran = await Finish(created.ID, ct);
        if (ran.StatusCode != 0)
            throw ComputeException.Internal("disk setup failed: " + Trim(ran.Text));
    }

    private HostConfig Host(IList<string>? binds, bool privileged, bool pidHost)
    {
        var host = new HostConfig
        {
            Privileged = privileged,
            PidMode = pidHost ? "host" : null,
            NetworkMode = "none",
            Memory = 128L * 1024 * 1024,
            NanoCPUs = 200_000_000,
            CgroupParent = string.IsNullOrWhiteSpace(_cgroupParent) ? null : _cgroupParent
        };
        if (binds is { Count: > 0 }) host.Binds = binds.ToList();
        return host;
    }

    private async Task<(long StatusCode, string Text)> Finish(string id, CancellationToken ct)
    {
        try
        {
            var started = await _client.Containers.StartContainerAsync(id, new ContainerStartParameters(), ct);
            if (!started && !await IsRunning(id, ct))
                throw ComputeException.Internal("disk helper did not start");
            var wait = await _client.Containers.WaitContainerAsync(id, ct);
            var logs = await ReadLogs(id, ct);
            return (wait.StatusCode, logs);
        }
        finally
        {
            try { await _client.Containers.RemoveContainerAsync(id, new ContainerRemoveParameters { Force = true }, CancellationToken.None); }
            catch { /* already removed */ }
        }
    }

    private async Task<bool> IsRunning(string id, CancellationToken ct)
    {
        var inspect = await _client.Containers.InspectContainerAsync(id, ct);
        return inspect.State.Running || inspect.State.Status == "exited";
    }

    private async Task<string> ReadLogs(string id, CancellationToken ct)
    {
        using var stream = await _client.Containers.GetContainerLogsAsync(id, true, new ContainerLogsParameters
        {
            ShowStdout = true,
            ShowStderr = true
        }, ct);
        var buffer = new byte[4096];
        var text = new StringBuilder();
        while (true)
        {
            var read = await stream.ReadOutputAsync(buffer, 0, buffer.Length, ct);
            if (read.EOF || read.Count <= 0) break;
            text.Append(Encoding.UTF8.GetString(buffer, 0, read.Count));
        }
        return text.ToString();
    }

    private static string Quote(string path) => "'" + path.Replace("'", "") + "'";

    private static string Trim(string logs)
    {
        var text = logs.Trim();
        return text.Length <= 400 ? text : text[^400..];
    }
}
