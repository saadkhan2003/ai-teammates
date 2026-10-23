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
        var ticket = VncTicketStore.Issue(user, bot, user, "watch", "tab-fake", 4, Endpoint(bot), "fake-session", ip);
        Assert.True(ticket.Token.Length >= 32);

        Assert.Null(VncTicketStore.Consume(ticket.Token, Guid.NewGuid(), user, ip, out var wrongWindow));
        Assert.Equal(403, wrongWindow);
        Assert.Null(VncTicketStore.Consume(ticket.Token, bot, user, "00" + ip[2..], out var wrongIp));
        Assert.Equal(401, wrongIp);
        var endpoint = VncTicketStore.Consume(ticket.Token, bot, user, ip, out var ok);
        Assert.Equal(401, ok);
        Assert.NotNull(endpoint);
        Assert.Equal(bot, endpoint.BotId);
        Assert.Equal("tab-fake", endpoint.TabId);
        Assert.Equal(4, endpoint.Epoch);
        Assert.Null(VncTicketStore.Consume(ticket.Token, bot, user, ip, out var replay));
        Assert.Equal(401, replay);
    }

    [Fact]
    public void Expired_ticket_is_rejected_as_unauthorized()
    {
        var user = Guid.NewGuid();
        var bot = Guid.NewGuid();
        var ip = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData("expired-fake-ip"u8));
        var ticket = VncTicketStore.Issue(user, bot, user, "watch", "tab-fake", 4, Endpoint(bot), "fake-session", ip, DateTimeOffset.UtcNow.AddSeconds(-61));
        Assert.Null(VncTicketStore.Consume(ticket.Token, bot, user, ip, out var status));
        Assert.Equal(401, status);
    }

    [Fact]
    public void Control_ticket_is_bound_to_tab_and_epoch_and_invalidated_on_owner_change()
    {
        var user = Guid.NewGuid();
        var bot = Guid.NewGuid();
        var ip = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData("other-fake-ip"u8));
        var ticket = VncTicketStore.Issue(user, bot, user, "control", "tab-1", 5, Endpoint(bot), "fake-session", ip);
        VncTicketStore.InvalidateLease(bot, 6);
        var endpoint = VncTicketStore.Consume(ticket.Token, bot, user, ip, out _);
        Assert.Null(endpoint);
    }

    [Fact]
    public async Task Last_control_socket_gets_grace_and_reconnect_cancels_release()
    {
        var oldDelay = WebSocketCloseGrace.Delay;
        var waits = new System.Collections.Concurrent.ConcurrentQueue<TaskCompletionSource>();
        WebSocketCloseGrace.Delay = (_, token) =>
        {
            var wait = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            token.Register(() => wait.TrySetCanceled(token));
            waits.Enqueue(wait);
            return wait.Task;
        };
        try
        {
            var released = 0;
            var key = "grace-test-" + Guid.NewGuid().ToString("N");
            WebSocketCloseGrace.Connected(key);
            WebSocketCloseGrace.Connected(key);
            WebSocketCloseGrace.Disconnected(key, () => { Interlocked.Increment(ref released); return Task.CompletedTask; });
            Assert.Equal(0, released);
            WebSocketCloseGrace.Disconnected(key, () => { Interlocked.Increment(ref released); return Task.CompletedTask; });
            await WaitFor(() => waits.Count == 1);
            WebSocketCloseGrace.Connected(key);
            WebSocketCloseGrace.Disconnected(key, () => { Interlocked.Increment(ref released); return Task.CompletedTask; });
            await WaitFor(() => waits.Count == 2);
            waits.TryDequeue(out var cancelled);
            cancelled!.TrySetResult();
            waits.TryDequeue(out var active);
            active!.TrySetResult();
            await WaitFor(() => Volatile.Read(ref released) == 1);
            Assert.Equal(1, released);
        }
        finally { WebSocketCloseGrace.Delay = oldDelay; }
    }

    private static async Task WaitFor(Func<bool> predicate)
    {
        for (var i = 0; i < 100 && !predicate(); i++) await Task.Delay(5);
        Assert.True(predicate());
    }
}
