using Teammates.Api;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;

namespace Teammates.UnitTests;

public sealed class AccountSecurityTests
{
    [Fact]
    public async Task AccountRoutesBuildTheirRealEndpointDataSources()
    {
        var builder = WebApplication.CreateBuilder();
        await using var app = builder.Build();
        AccountRoutes.Map(app, null!);

        // Accessing Endpoints forces minimal API RequestDelegateFactory to inspect every
        // mapped signature, including body inference rules, without starting dependencies.
        var endpoints = ((IEndpointRouteBuilder)app).DataSources.SelectMany(source => source.Endpoints).ToArray();
        Assert.Contains(endpoints, endpoint => endpoint is RouteEndpoint route && route.RoutePattern.RawText == "/api/account");
        Assert.Contains(endpoints, endpoint => endpoint is RouteEndpoint route && route.RoutePattern.RawText == "/api/support/tickets/{id:guid}");
    }

    [Fact]
    public void TotpMatchesRfc6238TruncatedSha1Vector()
    {
        var secret = System.Text.Encoding.ASCII.GetBytes("12345678901234567890");
        Assert.Equal("287082", Totp.Code(secret, 59));
        Assert.True(Totp.Verify(secret, "287082", DateTimeOffset.FromUnixTimeSeconds(59)));
        Assert.False(Totp.Verify(secret, "287083", DateTimeOffset.FromUnixTimeSeconds(59)));
    }

    [Fact]
    public void SessionRevocationIsOwnerScopedAndProtectsCurrentSession()
    {
        var owner = Guid.NewGuid(); var other = Guid.NewGuid();
        Assert.True(AccountSecurityPolicy.CanRevokeSession(owner, owner, current: false));
        Assert.False(AccountSecurityPolicy.CanRevokeSession(owner, owner, current: true));
        Assert.False(AccountSecurityPolicy.CanRevokeSession(other, owner, current: false));
    }

    [Fact]
    public void TicketVisibilityAndAdministrationAreOwnerAndRoleScoped()
    {
        var owner = Guid.NewGuid(); var other = Guid.NewGuid();
        Assert.True(AccountSecurityPolicy.CanReadTicket(owner, owner, staff: false));
        Assert.False(AccountSecurityPolicy.CanReadTicket(owner, other, staff: false));
        Assert.True(AccountSecurityPolicy.CanReadTicket(owner, other, staff: true));
        Assert.True(AccountSecurityPolicy.CanManageSupport("admin"));
        Assert.False(AccountSecurityPolicy.CanManageSupport("member"));
    }

    [Fact]
    public void AccountDeletionRequiresTypedConfirmation()
    {
        Assert.True(AccountSecurityPolicy.HasDeleteConfirmation("DELETE MY ACCOUNT"));
        Assert.False(AccountSecurityPolicy.HasDeleteConfirmation("delete my account"));
        Assert.False(AccountSecurityPolicy.HasDeleteConfirmation(""));
    }

    [Fact]
    public void TotpSecretCanUseTheExistingAuthenticatedEncryptionHelper()
    {
        var key = System.Security.Cryptography.RandomNumberGenerator.GetBytes(32);
        var user = Guid.NewGuid(); var secret = Totp.NewSecret();
        var (cipher, nonce) = KeyEncryption.Encrypt(key, user, user, "TOTP", KeyEncryption.KeyVersion, secret);
        Assert.Equal(secret, KeyEncryption.Decrypt(key, user, user, "TOTP", KeyEncryption.KeyVersion, cipher, nonce));
    }
}
