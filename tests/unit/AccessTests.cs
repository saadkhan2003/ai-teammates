using Teammates.Api;

namespace Teammates.UnitTests;

public class AccessTests
{
    [Theory]
    [InlineData("owner", true)]
    [InlineData("admin", true)]
    [InlineData("member", false)]
    [InlineData("", false)]
    public void StaffIsOwnerOrAdmin(string role, bool staff)
    {
        Assert.Equal(staff, Access.IsStaff(role));
    }

    [Theory]
    [InlineData("owner", "admin", true)]
    [InlineData("owner", "member", true)]
    [InlineData("owner", "owner", false)]
    [InlineData("admin", "member", true)]
    [InlineData("admin", "admin", false)]
    [InlineData("member", "member", false)]
    public void GrantRules(string actor, string target, bool allowed)
    {
        Assert.Equal(allowed, Access.CanGrant(actor, target));
    }

    [Fact]
    public void AdminCannotChangeAnotherAdmin()
    {
        Assert.False(Access.CanChangeStatus("admin", "admin"));
        Assert.False(Access.CanChangeStatus("admin", "owner"));
        Assert.True(Access.CanChangeStatus("admin", "member"));
        Assert.True(Access.CanChangeStatus("owner", "admin"));
    }
}
