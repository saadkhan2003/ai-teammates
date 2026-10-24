using Teammates.Api;

namespace Teammates.UnitTests;

public sealed class OneTimeTicketStoreTests
{
    [Fact]
    public async Task Fake_store_binds_scope_and_consumes_once()
    {
        var store = new InMemoryOneTimeTicketStore();
        var ticket = new OneTimeTicket(Guid.NewGuid(), "vnc", RandomToken(), Guid.NewGuid(), Guid.NewGuid(), null,
            "watch", "tab-test", 7, "{}", Hash("ip-test"), DateTime.UtcNow.AddMinutes(1));
        await store.IssueAsync(ticket, default);
        Assert.Null(await store.ConsumeAsync(ticket.Token, "vnc", Guid.NewGuid(), ticket.BotId, ticket.IpHash, default));
        Assert.Null(await store.ConsumeAsync(ticket.Token, "vnc", ticket.UserId, Guid.NewGuid(), ticket.IpHash, default));
        Assert.Null(await store.ConsumeAsync(ticket.Token, "terminal", ticket.UserId, ticket.BotId, ticket.IpHash, default));
        Assert.NotNull(await store.ConsumeAsync(ticket.Token, "vnc", ticket.UserId, ticket.BotId, ticket.IpHash, default));
        Assert.Null(await store.ConsumeAsync(ticket.Token, "vnc", ticket.UserId, ticket.BotId, ticket.IpHash, default));
    }

    [Fact]
    public async Task Fake_store_checks_ip_and_expiry_without_burning_wrong_ip_ticket()
    {
        var store = new InMemoryOneTimeTicketStore();
        var ticket = new OneTimeTicket(Guid.NewGuid(), "vnc", RandomToken(), Guid.NewGuid(), Guid.NewGuid(), null,
            "control", "tab-test", 1, "{}", Hash("ip-test"), DateTime.UtcNow.AddMinutes(1));
        await store.IssueAsync(ticket, default);
        Assert.Null(await store.ConsumeAsync(ticket.Token, "vnc", ticket.UserId, ticket.BotId, Hash("wrong"), default));
        Assert.NotNull(await store.ConsumeAsync(ticket.Token, "vnc", ticket.UserId, ticket.BotId, ticket.IpHash, default));

        var expired = ticket with { Id = Guid.NewGuid(), Token = RandomToken(), ExpiresAt = DateTime.UtcNow.AddSeconds(-1) };
        await store.IssueAsync(expired, default);
        Assert.Null(await store.ConsumeAsync(expired.Token, "vnc", expired.UserId, expired.BotId, expired.IpHash, default));
    }

    [Fact]
    public async Task Fake_store_has_one_winner_for_concurrent_replays()
    {
        var store = new InMemoryOneTimeTicketStore();
        var ticket = new OneTimeTicket(Guid.NewGuid(), "terminal", RandomToken(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(),
            "user", "", 0, "{}", null, DateTime.UtcNow.AddMinutes(1));
        await store.IssueAsync(ticket, default);
        var results = await Task.WhenAll(Enumerable.Range(0, 200).Select(_ => store.ConsumeAsync(ticket.Token, "terminal", ticket.UserId, ticket.BotId, null, default)));
        Assert.Single(results, x => x != null);
    }

    private static string RandomToken() => Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
    private static byte[] Hash(string value) => System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(value));
}
