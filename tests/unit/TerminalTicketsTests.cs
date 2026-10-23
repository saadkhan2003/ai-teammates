using Teammates.Api;

namespace Teammates.UnitTests;

public sealed class TerminalTicketsTests
{
    private static readonly byte[] Secret = Enumerable.Range(0, 32).Select(value => (byte)value).ToArray();

    [Fact]
    public void IssuesSignedTicketBoundToUserBotWindowAndRole()
    {
        var now = DateTimeOffset.FromUnixTimeSeconds(1_800_000_000);
        var token = TerminalTickets.Create(Secret, "computer-1", "user-1", "bot-1", 2, "user", now);
        var claims = TerminalTickets.Verify(token, Secret, now);

        Assert.Equal("computer-1", claims.Computer);
        Assert.Equal("user-1", claims.User);
        Assert.Equal("bot-1", claims.Bot);
        Assert.Equal(2, claims.Window);
        Assert.Equal("user", claims.Role);
        Assert.Equal(now.ToUnixTimeSeconds() + 60, claims.Expires);
        Assert.Equal(32, DecodeBase64Url(claims.Nonce).Length);
    }

    [Fact]
    public void RejectsTamperingExpiryAndInvalidWindow()
    {
        var now = DateTimeOffset.FromUnixTimeSeconds(1_800_000_000);
        var token = TerminalTickets.Create(Secret, "computer-1", "user-1", "bot-1", 1, "user", now);
        Assert.Throws<InvalidOperationException>(() => TerminalTickets.Verify(token + "x", Secret, now));
        Assert.Throws<InvalidOperationException>(() => TerminalTickets.Verify(token, Secret, now.AddSeconds(61)));
        Assert.Throws<ArgumentOutOfRangeException>(() => TerminalTickets.Create(Secret, "computer-1", "user-1", "bot-1", 9, "user", now));
        Assert.Throws<ArgumentException>(() => TerminalTickets.Create(Secret, "computer-1", "user-1", "bot-1", 1, "admin", now));
    }

    private static byte[] DecodeBase64Url(string value)
    {
        var base64 = value.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(base64 + new string('=', (4 - base64.Length % 4) % 4));
    }
}
