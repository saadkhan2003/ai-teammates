using Google.Protobuf;
using Google.Protobuf.WellKnownTypes;
using Teammates.Compute;
using Proto = Platform.Contracts.Compute.V1;

namespace Teammates.UnitTests;

public class ProtoMappingTests
{
    [Fact]
    public void DomainTypesRoundTripThroughComputeV1()
    {
        var created = DateTimeOffset.Parse("2026-10-21T12:00:00Z");
        var computer = new Computer(
            new ComputerId("bot-1"), "local", "owner-1", "teammates-computer:dev",
            IsolationClass.Docker, ComputerState.Running, "host-a",
            ["tmwsbot1", "tmprbot1"], created, created.AddMinutes(1),
            new Dictionary<string, string> { ["name"] = "Inbox" });
        var proto = ToProto(computer);
        var back = FromProto(proto.ToByteArray());
        Assert.Equal(computer.Id.Value, back.Id.Value);
        Assert.Equal(computer.TenantId, back.TenantId);
        Assert.Equal(computer.OwnerId, back.OwnerId);
        Assert.Equal(computer.ImageRef, back.ImageRef);
        Assert.Equal(computer.Isolation, back.Isolation);
        Assert.Equal(computer.State, back.State);
        Assert.Equal(computer.HostId, back.HostId);
        Assert.Equal(computer.VolumeIds, back.VolumeIds);
        Assert.Equal(computer.Labels["name"], back.Labels["name"]);
        Assert.Equal(computer.CreatedAt.ToUnixTimeSeconds(), back.CreatedAt.ToUnixTimeSeconds());

        var exec = new ExecSpec(
            computer.Id, ["python3", "-c", "print(1)"], "/workspace",
            new Dictionary<string, string> { ["LANG"] = "C" },
            [new SecretEnvBinding("REGISTRY_TOKEN", "secret://project/registry", "grant")],
            "desk", TimeSpan.FromSeconds(15), 4096, false);
        var execBack = FromProto(ToProto(exec));
        Assert.Equal(exec.Argv, execBack.Argv);
        Assert.Equal(exec.Cwd, execBack.Cwd);
        Assert.Equal("C", execBack.Env["LANG"]);
        Assert.Equal("secret://project/registry", execBack.SecretEnv[0].SecretRef);
        Assert.Equal(exec.Timeout, execBack.Timeout);
        Assert.False(execBack.Stdin);

        var session = new Proto.DesktopSession
        {
            Url = "/vnc/websockify?token=abc",
            Token = "abc",
            Access = Proto.DesktopAccess.View,
            FencingEpoch = 3,
            ExpiresAt = Timestamp.FromDateTimeOffset(created.AddMinutes(5))
        };
        var parsedSession = Proto.DesktopSession.Parser.ParseFrom(session.ToByteArray());
        Assert.Equal("abc", parsedSession.Token);
        Assert.Equal(Proto.DesktopAccess.View, parsedSession.Access);

        var snapshot = new Proto.SnapshotInfo
        {
            SnapshotId = "snap",
            ComputerId = "bot-1",
            SizeBytes = 42,
            CreatedAt = Timestamp.FromDateTimeOffset(created)
        };
        Assert.Equal("snap", Proto.SnapshotInfo.Parser.ParseFrom(snapshot.ToByteArray()).SnapshotId);

        var capacity = new Proto.Capacity
        {
            HostId = "docker",
            VcpuMillisTotal = 4000,
            ComputersRunning = 1,
            ComputersMax = 4
        };
        Assert.Equal(4u, Proto.Capacity.Parser.ParseFrom(capacity.ToByteArray()).ComputersMax);

        var health = new Proto.HealthCheckResponse
        {
            Healthy = true,
            HostVersion = "29",
            Components = { new Proto.ComponentHealth { Name = "docker", Healthy = true, Detail = "pong" } }
        };
        Assert.True(Proto.HealthCheckResponse.Parser.ParseFrom(health.ToByteArray()).Healthy);

        var error = new Proto.ComputeError
        {
            Code = Proto.ComputeErrorCode.IdempotencyConflict,
            Message = "reused",
            Retryable = false
        };
        Assert.Equal(Proto.ComputeErrorCode.IdempotencyConflict, Proto.ComputeError.Parser.ParseFrom(error.ToByteArray()).Code);
        Assert.Equal(12, System.Enum.GetValues<Proto.ComputeErrorCode>().Count(code => code != Proto.ComputeErrorCode.Unspecified));
        Assert.Equal(11, System.Enum.GetValues<Proto.ComputerState>().Count(state => state != Proto.ComputerState.Unspecified));
    }

    private static Proto.Computer ToProto(Computer computer)
    {
        var message = new Proto.Computer
        {
            ComputerId = computer.Id.Value,
            TenantId = computer.TenantId,
            UserId = computer.OwnerId,
            ImageRef = computer.ImageRef,
            IsolationClass = computer.Isolation switch
            {
                IsolationClass.Kata => Proto.IsolationClass.Kata,
                IsolationClass.Firecracker => Proto.IsolationClass.Firecracker,
                _ => Proto.IsolationClass.Docker
            },
            State = MapState(computer.State),
            HostId = computer.HostId,
            CreatedAt = Timestamp.FromDateTimeOffset(computer.CreatedAt),
            UpdatedAt = Timestamp.FromDateTimeOffset(computer.UpdatedAt)
        };
        message.VolumeIds.Add(computer.VolumeIds);
        message.Labels.Add(new Dictionary<string, string>(computer.Labels));
        return message;
    }

    private static Computer FromProto(byte[] bytes)
    {
        var message = Proto.Computer.Parser.ParseFrom(bytes);
        return new Computer(
            new ComputerId(message.ComputerId), message.TenantId, message.UserId, message.ImageRef,
            message.IsolationClass switch
            {
                Proto.IsolationClass.Kata => IsolationClass.Kata,
                Proto.IsolationClass.Firecracker => IsolationClass.Firecracker,
                _ => IsolationClass.Docker
            },
            MapState(message.State), message.HostId, message.VolumeIds.ToArray(),
            message.CreatedAt.ToDateTimeOffset(), message.UpdatedAt.ToDateTimeOffset(),
            message.Labels.ToDictionary());
    }

    private static Proto.ExecRequest ToProto(ExecSpec spec)
    {
        var request = new Proto.ExecRequest
        {
            ComputerId = spec.Id.Value,
            Cwd = spec.Cwd,
            RunAs = spec.RunAs,
            Timeout = Duration.FromTimeSpan(spec.Timeout),
            MaxOutputBytes = spec.MaxOutputBytes,
            Stdin = spec.Stdin
        };
        request.Argv.Add(spec.Argv);
        request.Env.Add(new Dictionary<string, string>(spec.Env));
        request.SecretEnv.Add(spec.SecretEnv.Select(binding => new Proto.SecretEnvBinding
        {
            EnvName = binding.EnvName,
            SecretRef = binding.SecretRef,
            GrantId = binding.GrantId
        }));
        return request;
    }

    private static ExecSpec FromProto(Proto.ExecRequest request) => new(
        new ComputerId(request.ComputerId),
        request.Argv.ToArray(),
        request.Cwd,
        request.Env.ToDictionary(),
        request.SecretEnv.Select(binding => new SecretEnvBinding(binding.EnvName, binding.SecretRef, binding.GrantId)).ToArray(),
        request.RunAs,
        request.Timeout.ToTimeSpan(),
        request.MaxOutputBytes,
        request.Stdin);

    private static Proto.ComputerState MapState(ComputerState state) => state switch
    {
        ComputerState.Provisioning => Proto.ComputerState.Provisioning,
        ComputerState.Running => Proto.ComputerState.Running,
        ComputerState.Idle => Proto.ComputerState.Idle,
        ComputerState.Stopping => Proto.ComputerState.Stopping,
        ComputerState.Stopped => Proto.ComputerState.Stopped,
        ComputerState.Hibernated => Proto.ComputerState.Hibernated,
        ComputerState.Recreating => Proto.ComputerState.Recreating,
        ComputerState.Restoring => Proto.ComputerState.Restoring,
        ComputerState.Failed => Proto.ComputerState.Failed,
        ComputerState.Deleting => Proto.ComputerState.Deleting,
        ComputerState.Deleted => Proto.ComputerState.Deleted,
        _ => Proto.ComputerState.Unspecified
    };

    private static ComputerState MapState(Proto.ComputerState state) => state switch
    {
        Proto.ComputerState.Provisioning => ComputerState.Provisioning,
        Proto.ComputerState.Running => ComputerState.Running,
        Proto.ComputerState.Idle => ComputerState.Idle,
        Proto.ComputerState.Stopping => ComputerState.Stopping,
        Proto.ComputerState.Stopped => ComputerState.Stopped,
        Proto.ComputerState.Hibernated => ComputerState.Hibernated,
        Proto.ComputerState.Recreating => ComputerState.Recreating,
        Proto.ComputerState.Restoring => ComputerState.Restoring,
        Proto.ComputerState.Failed => ComputerState.Failed,
        Proto.ComputerState.Deleting => ComputerState.Deleting,
        Proto.ComputerState.Deleted => ComputerState.Deleted,
        _ => ComputerState.Provisioning
    };
}
