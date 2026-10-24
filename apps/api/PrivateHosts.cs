using System.Text.Json;
using Dapper;
using Teammates.Compute;

namespace Teammates.Api;

public static class PrivateHosts
{
    /// <summary>Push policy to each distinct live computer before acknowledging the policy update.</summary>
    public static async Task<bool> PropagateAsync(Platform platform, Guid owner, IEnumerable<string> hosts, CancellationToken ct)
    {
        var normalized = hosts.Distinct(StringComparer.OrdinalIgnoreCase).Order(StringComparer.OrdinalIgnoreCase).ToArray();
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var bots = await conn.QueryAsync<Guid>("SELECT id FROM bots WHERE owner_id=@owner ORDER BY id", new { owner });
        var sent = new HashSet<string>(StringComparer.Ordinal);
        foreach (var bot in bots)
        {
            var (computer, desktop) = await platform.PlacementForBot(bot, ct);
            var key = computer.Value + "/" + desktop;
            if (!sent.Add(key)) continue;
            var json = JsonSerializer.Serialize(new { hosts = normalized });
            await platform.Compute.ControlAsync(computer, $"/internal/private-hosts", json, ct);
        }
        return true;
    }

    public static async Task PropagateBotAsync(Platform platform, Guid botId, CancellationToken ct)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var owner = await conn.ExecuteScalarAsync<Guid?>("SELECT owner_id FROM bots WHERE id=@bot", new { bot = botId });
        if (owner is null) throw new InvalidOperationException("bot is unavailable");
        var policy = await SecurityRoutes.Load(platform, owner.Value);
        var (computer, _) = await platform.PlacementForBot(botId, ct);
        var json = JsonSerializer.Serialize(new { hosts = policy.PrivateHosts.Order(StringComparer.OrdinalIgnoreCase) });
        await platform.Compute.ControlAsync(computer, "/internal/private-hosts", json, ct);
    }
}
