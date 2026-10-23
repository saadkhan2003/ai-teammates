using Teammates.Api;

namespace Teammates.UnitTests;

public class DevicesTests
{
    [Theory]
    [InlineData("off", false)]
    [InlineData(null, false)]
    [InlineData("unknown", false)]
    [InlineData("always", true)]
    [InlineData("ask", true)]
    public void ExecutionGateFailsClosed(string? execution, bool expected) => Assert.Equal(expected, DeviceCredentials.MayExecute(execution));

    [Theory]
    [InlineData("owner", true)]
    [InlineData("admin", false)]
    [InlineData("member", false)]
    [InlineData(null, false)]
    public void ManagementIsOwnerOnly(string? role, bool expected) => Assert.Equal(expected, DeviceCredentials.OwnerOnly(role));

    [Fact]
    public void TokensAreRandomAndOnlyHashesAreStored()
    {
        var first = DeviceCredentials.Create();
        var second = DeviceCredentials.Create();
        Assert.Equal(64, first.Length);
        Assert.NotEqual(first, second);
        Assert.NotEqual(first, DeviceCredentials.Hash(first));
        Assert.Equal(DeviceCredentials.Hash(first), DeviceCredentials.Hash(first));
        Assert.NotEqual(DeviceCredentials.Hash(first), DeviceCredentials.Hash(second));
    }

    [Theory]
    [InlineData("ask", true)]
    [InlineData("always", true)]
    [InlineData("off", true)]
    [InlineData("ON", false)]
    [InlineData(null, false)]
    public void PermissionsRejectUnknownModes(string? mode, bool expected) => Assert.Equal(expected, DeviceCredentials.ValidExecution(mode));

    [Fact]
    public void PairingAttemptsAreLimited()
    {
        var limiter = new LoginRateLimiter();
        var now = DateTimeOffset.UtcNow;
        for (var i = 0; i < LoginRateLimiter.MaxAttempts; i++) limiter.NoteAttempt("device-pair", now);
        Assert.True(limiter.IsBlocked("device-pair", now));
        Assert.False(limiter.IsBlocked("other", now));
        Assert.False(limiter.IsBlocked("device-pair", now.AddMinutes(11)));
    }
}
