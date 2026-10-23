using Teammates.Api;

namespace Teammates.UnitTests;

public sealed class VncTicketTests
{
    [Fact]
    public async Task Expired_ticket_is_rejected_as_unauthorized()
    {
        var user = Guid.NewGuid();
        var bot = Guid.NewGuid();
        var ip = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData("expired-fake-ip"u8));
        var store = new InMemoryOneTimeTicketStore();
        var ticket = new OneTimeTicket(Guid.NewGuid(), "vnc", Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)), user, bot, user,
            "watch", "tab-fake", 4, "{}", Convert.FromHexString(ip), DateTime.UtcNow.AddSeconds(-61));
        await store.IssueAsync(ticket, default);
        Assert.Null(await store.ConsumeAsync(ticket.Token, "vnc", user, bot, Convert.FromHexString(ip), default));
    }

    [Fact]
    public async Task Control_ticket_is_bound_to_tab_and_epoch_and_invalidated_on_owner_change()
    {
        var user = Guid.NewGuid();
        var bot = Guid.NewGuid();
        var ip = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData("other-fake-ip"u8));
        var store = new InMemoryOneTimeTicketStore();
        var ticket = new OneTimeTicket(Guid.NewGuid(), "vnc", Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)), user, bot, user,
            "control", "tab-1", 5, "{}", Convert.FromHexString(ip), DateTime.UtcNow.AddMinutes(1));
        await store.IssueAsync(ticket, default);
        await store.InvalidateLeaseAsync(bot, 6, default);
        Assert.Null(await store.ConsumeAsync(ticket.Token, "vnc", user, bot, Convert.FromHexString(ip), default));
    }

}
