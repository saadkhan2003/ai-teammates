using Teammates.Api;

namespace Teammates.UnitTests;

public class AccessTests
{
    [Theory]
    [InlineData("owner", true)]
    [InlineData("admin", true)]
    [InlineData("member", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void StaffIsOwnerOrAdmin(string? role, bool staff)
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

    [Theory]
    [InlineData("owner", true)]
    [InlineData("admin", true)]
    [InlineData("support", true)]
    [InlineData("readonly", true)]
    [InlineData("member", false)]
    public void ConsoleEntryIncludesSupportAndReadonly(string role, bool allowed)
    {
        Assert.Equal(allowed, Access.CanEnterAdmin(role));
    }

    [Theory]
    [InlineData("readonly", "read", true)]
    [InlineData("readonly", "note", false)]
    [InlineData("readonly", "suspend", false)]
    [InlineData("readonly", "delete", false)]
    [InlineData("support", "note", true)]
    [InlineData("support", "ticket", true)]
    [InlineData("support", "announce", true)]
    [InlineData("support", "suspend", false)]
    [InlineData("support", "refund", false)]
    [InlineData("support", "impersonate", false)]
    [InlineData("admin", "suspend", true)]
    [InlineData("admin", "grant", true)]
    [InlineData("admin", "impersonate", true)]
    [InlineData("admin", "kill", true)]
    [InlineData("admin", "refund", false)]
    [InlineData("admin", "delete", false)]
    [InlineData("admin", "maintenance", false)]
    [InlineData("admin", "secret", false)]
    [InlineData("admin", "gdpr", false)]
    [InlineData("owner", "delete", true)]
    [InlineData("owner", "refund", true)]
    [InlineData("owner", "maintenance", true)]
    [InlineData("owner", "secret", true)]
    [InlineData("owner", "gdpr", true)]
    [InlineData("member", "read", false)]
    public void ConsoleActionsFollowTheRole(string role, string action, bool allowed)
    {
        Assert.Equal(allowed, Access.Allows(role, action));
    }

    [Fact]
    public void OwnersAndAdminsNeedTotpBeforeWrites()
    {
        Assert.True(Access.BlocksUntilTotp("owner", "suspend", false));
        Assert.False(Access.BlocksUntilTotp("owner", "suspend", true));
        Assert.False(Access.BlocksUntilTotp("owner", "totp", false));
        Assert.False(Access.BlocksUntilTotp("owner", "read", false));
        Assert.False(Access.BlocksUntilTotp("support", "note", false));
        Assert.False(Access.BlocksUntilTotp("readonly", "read", false));
    }

    [Fact]
    public void PlanCapsStopAtFiftyGigabytesAndEightGigabytes()
    {
        Assert.True(AdminLimits.PlanOk(2000, 1250, AdminLimits.MaxStorageMb, AdminLimits.MaxRamMb, AdminLimits.MaxCpuMillis));
        Assert.False(AdminLimits.StorageOk(AdminLimits.MaxStorageMb + 1));
        Assert.False(AdminLimits.RamOk(AdminLimits.MaxRamMb + 1));
        Assert.False(AdminLimits.CpuOk(AdminLimits.MaxCpuMillis + 1));
        Assert.False(AdminLimits.PlanOk(2000, 1250, 51201, 4096, 2000));
    }

    [Fact]
    public void RefundCannotExceedTheInvoice()
    {
        Assert.True(AdminLimits.RefundFits(2000, 500, 1500));
        Assert.False(AdminLimits.RefundFits(2000, 500, 1501));
        Assert.False(AdminLimits.RefundFits(2000, 0, 0));
    }

    [Fact]
    public void EmptyAllowlistPermitsAndACidrFilters()
    {
        Assert.True(AdminNet.Allows("203.0.113.4", []));
        Assert.True(AdminNet.Allows("10.1.2.3", ["10.0.0.0/8"]));
        Assert.False(AdminNet.Allows("11.0.0.1", ["10.0.0.0/8"]));
        Assert.False(AdminNet.Allows("not-an-ip", ["10.0.0.0/8"]));
        Assert.True(AdminNet.ValidCidr("192.168.1.20/32"));
        Assert.False(AdminNet.ValidCidr("10.0.0.0/99"));
    }

    [Fact]
    public void TotpMatchesTheRfcVector()
    {
        var secret = System.Text.Encoding.ASCII.GetBytes("12345678901234567890");
        Assert.Equal(287082, AdminTotp.Code(secret, 1));
        var encoded = AdminTotp.EncodeBase32(secret);
        Assert.True(AdminTotp.Verify(encoded, "287082", DateTimeOffset.FromUnixTimeSeconds(59), 0));
        Assert.False(AdminTotp.Verify(encoded, "000000", DateTimeOffset.FromUnixTimeSeconds(59), 0));
    }

    [Fact]
    public void ModelContractNamesTheSpeedBranch()
    {
        Assert.Equal("speed-v1", AdminConsole.ModelMergeBranch);
        Assert.Equal(12, AdminConsole.ModelSafetyFeatures);
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
