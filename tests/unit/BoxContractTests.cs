using Teammates.Api;

namespace Teammates.UnitTests;

public class BoxContractTests
{
    [Theory]
    [InlineData(1)] [InlineData(2)] [InlineData(3)] [InlineData(4)]
    [InlineData(5)] [InlineData(6)] [InlineData(7)] [InlineData(8)]
    public void PerDisplayPortsMatchContract(int display)
    {
        Assert.Equal(5900 + display, BoxContract.PortFor("vnc", display));
        Assert.Equal(14000 + display, BoxContract.PortFor("exec", display));
        Assert.Equal(13600 + display, BoxContract.PortFor("pty", display));
        Assert.Equal(9222 + display, BoxContract.PortFor("cdp", display));
        Assert.Equal(9400 + display, BoxContract.PortFor("externalView", display));
    }

    [Theory]
    [InlineData(0)] [InlineData(9)]
    public void InvalidDisplayIsRejected(int display) =>
        Assert.Throws<ArgumentOutOfRangeException>(() => BoxContract.PortFor("vnc", display));
}
