using Teammates.Api;

namespace Teammates.UnitTests;

public class NetworkPolicyTests
{
    [Fact]
    public void ModesAndExactWildcardPortAndCidrMatching()
    {
        var policy = new NetworkPolicy(NetworkPolicyMode.TeamOnly,
            ["example.com", "*.allowed.test", "192.0.2.0/24", "service.test:8443"]);
        Assert.True(policy.Allows("example.com", 443));
        Assert.True(policy.Allows("www.allowed.test", 443));
        Assert.False(policy.Allows("evilexample.com", 443));
        Assert.False(policy.Allows("allowed.test", 443));
        Assert.True(policy.Allows("192.0.2.7", 443));
        Assert.True(policy.Allows("service.test", 8443));
        Assert.False(policy.Allows("service.test", 443));
        Assert.True(new NetworkPolicy(NetworkPolicyMode.AllowAll).Allows("anything.test", 9));
        Assert.True(new NetworkPolicy(NetworkPolicyMode.DefaultsWithTeam).Allows("example.com", 443));
        Assert.True(new NetworkPolicy(NetworkPolicyMode.DefaultsWithTeam, ["*.allowed.test"]).Allows("www.allowed.test", 443));
    }

    [Fact]
    public void LockedPolicyDoesNotAllowGroupOverridesAndBoundsEntries()
    {
        var locked = new NetworkPolicy(NetworkPolicyMode.TeamOnly, ["example.com"], locked: true);
        Assert.False(locked.WithGroupEntries(["other.test"]).Allows("other.test", 443));
        Assert.True(locked.WithGroupEntries(["other.test"]).Allows("example.com", 443));
        Assert.Throws<ArgumentException>(() => new NetworkPolicy(NetworkPolicyMode.TeamOnly, Enumerable.Repeat("x.test", 501)));
    }
}
