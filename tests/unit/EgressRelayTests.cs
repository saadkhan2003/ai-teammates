using Teammates.Api;
using Microsoft.Extensions.Configuration;

namespace Teammates.UnitTests;

public sealed class EgressRelayTests
{
    [Fact]
    public void AttachCredentialComparisonIsConstantTimeAndRejectsEmptyValues()
    {
        Assert.True(EgressRelay.TokenMatches("fake-device-token", "fake-device-token"));
        Assert.False(EgressRelay.TokenMatches("fake-device-token", "fake-device-token-x"));
        Assert.False(EgressRelay.TokenMatches("", ""));
    }

    [Theory]
    [InlineData("501", 500)]
    [InlineData("25", 25)]
    public void PolicyLimitIsBoundedByOurConfiguredLimit(string configured, int expected)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["NETWORK_POLICY_MAX_ENTRIES"] = configured }).Build();
        Assert.Equal(expected, NetworkPolicyRoutes.MaxEntries(config));
    }
}
