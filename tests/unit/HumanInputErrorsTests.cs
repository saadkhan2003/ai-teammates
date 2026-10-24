using Teammates.Api;
using Teammates.Compute;

namespace Teammates.UnitTests;

public sealed class HumanInputErrorsTests
{
    [Fact]
    public void Computer_refusal_or_conflict_means_control_was_lost()
    {
        Assert.True(HumanInputErrors.LostControl(ComputeException.FailedPrecondition(ComputeException.ControlRefusedMessage)));
        Assert.True(HumanInputErrors.LostControl(ComputeException.Conflict("computer control conflict")));
    }

    [Fact]
    public void Other_computer_failures_stay_errors()
    {
        Assert.False(HumanInputErrors.LostControl(ComputeException.FailedPrecondition("computer control rejected the call")));
        Assert.False(HumanInputErrors.LostControl(ComputeException.Unavailable("down")));
        Assert.False(HumanInputErrors.LostControl(ComputeException.IsolationMissing()));
    }

    [Fact]
    public void Human_input_route_maps_lost_control_to_409()
    {
        var source = File.ReadAllText(Path.Combine(MigrationManifestTests.Root(), "apps/api/Routes.cs"));
        var route = source.Split("/computer/human-input\"", 2)[1].Split("app.Map", 2)[0];
        Assert.Contains("catch (ComputeException ex) when (HumanInputErrors.LostControl(ex))", route);
        Assert.Contains("statusCode: 409", route);
        var provider = File.ReadAllText(Path.Combine(MigrationManifestTests.Root(), "src/Compute.Docker/DockerComputeProvider.cs"));
        Assert.Equal(2, provider.Split("== 403) throw ComputeException.FailedPrecondition(ComputeException.ControlRefusedMessage)").Length - 1);
    }
}
