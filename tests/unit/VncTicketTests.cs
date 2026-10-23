using Teammates.Api;
using Teammates.Compute;

namespace Teammates.UnitTests;

public sealed class VncTicketTests
{
    private static DesktopEndpoint Endpoint(Guid bot) => new(
        new ComputerId(bot.ToString()), "127.0.0.1", 5901, DesktopMode.View, 1, DateTimeOffset.UtcNow.AddMinutes(1));

    [Fact]
    public void Ticket_is_bound_to_user_window_and_ip_and_consumed_once()
    {
        var user = Guid.NewGuid();
        var bot = Guid.NewGuid();
        var ip = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData("fake-ip"u8));
        var ticket = VncTicketStore.Issue(user, bot, user, "watch", Endpoint(bot), "fake-session", ip);
        Assert.True(ticket.Token.Length >= 32);

        Assert.Null(VncTicketStore.Consume(ticket.Token, Guid.NewGuid(), user, ip, out var wrongWindow));
        Assert.Equal(403, wrongWindow);
        Assert.Null(VncTicketStore.Consume(ticket.Token, bot, user, "00" + ip[2..], out var wrongIp));
        Assert.Equal(401, wrongIp);
        var endpoint = VncTicketStore.Consume(ticket.Token, bot, user, ip, out var ok);
        Assert.Equal(401, ok);
        Assert.NotNull(endpoint);
        Assert.Equal(bot, endpoint.BotId);
        Assert.Null(VncTicketStore.Consume(ticket.Token, bot, user, ip, out var replay));
        Assert.Equal(401, replay);
    }

    [Fact]
    public void Expired_ticket_is_rejected_as_unauthorized()
    {
        var user = Guid.NewGuid();
        var bot = Guid.NewGuid();
        var ip = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData("expired-fake-ip"u8));
        var ticket = VncTicketStore.Issue(user, bot, user, "watch", Endpoint(bot), "fake-session", ip, DateTimeOffset.UtcNow.AddSeconds(-61));
        Assert.Null(VncTicketStore.Consume(ticket.Token, bot, user, ip, out var status));
        Assert.Equal(401, status);
    }

    [Fact]
    public void Control_ticket_requires_a_live_human_lease()
    {
        var user = Guid.NewGuid();
        var bot = Guid.NewGuid();
        var ip = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData("other-fake-ip"u8));
        var ticket = VncTicketStore.Issue(user, bot, user, "control", Endpoint(bot), "fake-session", ip);
        Assert.Null(VncTicketStore.Consume(ticket.Token, bot, user, ip, out var denied));
        Assert.Equal(409, denied);
        Assert.True(VncTicketStore.TryAcquireHuman(user, user, DateTimeOffset.UtcNow));
        var endpoint = VncTicketStore.Consume(ticket.Token, bot, user, ip, out _);
        Assert.NotNull(endpoint);
        VncTicketStore.ReleaseHuman(user, user);
    }
}
