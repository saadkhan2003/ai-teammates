using System.Threading.Channels;
using System.Text.Json;
using Dapper;
using Teammates.Compute;

namespace Teammates.Api;

public enum PrewarmAdmission { Accepted, Duplicate, RateLimited, Busy }
public sealed record PrewarmRequest(Guid Owner, Guid Bot, ComputerId Computer);

/// <summary>Process-local, bounded best-effort queue. Focus never waits for Docker.</summary>
public sealed class PrewarmQueue(TimeProvider? clock = null)
{
    private readonly TimeProvider time = clock ?? TimeProvider.System;
    private readonly object sync = new();
    private readonly Dictionary<Guid, DateTimeOffset> bots = [];
    private readonly Dictionary<Guid, (DateTimeOffset Start, int Count)> owners = [];
    private readonly HashSet<string> pending = [];
    private readonly Channel<PrewarmRequest> queue = Channel.CreateBounded<PrewarmRequest>(128);

    public PrewarmAdmission TrySchedule(PrewarmRequest request)
    {
        lock (sync)
        {
            var now = time.GetUtcNow();
            foreach (var key in bots.Where(x => now - x.Value >= TimeSpan.FromSeconds(30)).Select(x => x.Key).ToArray()) bots.Remove(key);
            foreach (var key in owners.Where(x => now - x.Value.Start >= TimeSpan.FromMinutes(1)).Select(x => x.Key).ToArray()) owners.Remove(key);
            if (bots.ContainsKey(request.Bot) || pending.Contains(request.Computer.Value)) return PrewarmAdmission.Duplicate;
            owners.TryGetValue(request.Owner, out var owner);
            if (owner.Count >= 12) return PrewarmAdmission.RateLimited;
            if (bots.Count >= 4096 || !queue.Writer.TryWrite(request)) return PrewarmAdmission.Busy;
            bots[request.Bot] = now;
            owners[request.Owner] = (owner.Count == 0 ? now : owner.Start, owner.Count + 1);
            pending.Add(request.Computer.Value);
            return PrewarmAdmission.Accepted;
        }
    }

    public async Task RunAsync(Func<PrewarmRequest, CancellationToken, Task> wake, Action<Exception> failed, CancellationToken ct)
    {
        try
        {
            await Parallel.ForEachAsync(queue.Reader.ReadAllAsync(ct), new ParallelOptions { MaxDegreeOfParallelism = 2, CancellationToken = ct }, async (request, token) =>
            {
                try { await wake(request, token); }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { }
                catch (Exception ex) { failed(ex); }
                finally { lock (sync) pending.Remove(request.Computer.Value); }
            });
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
    }
}

public sealed class ComputerPrewarmService(Platform platform, ILogger<ComputerPrewarmService> logger) : BackgroundService
{
    private readonly Platform platform = platform;
    public PrewarmQueue Queue { get; } = new();

    public static int Authorize(Guid? actor, Guid? botOwner, int? maxComputers, UserPolicy policy, IEnumerable<DenyRule> rules)
    {
        if (actor == null) return 401;
        if (botOwner == null || actor != botOwner || maxComputers is <= 0) return 403;
        var decision = PolicyGate.Evaluate("computer.prewarm", JsonSerializer.SerializeToElement(new { }), new HashSet<string>(), policy, rules, null, false);
        return decision.Decision == PolicyEngine.Allow ? 202 : 403;
    }

    private async Task<int> CheckAsync(Guid owner, Guid bot, CancellationToken ct)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var row = await conn.QuerySingleOrDefaultAsync<(Guid? Owner, int? Max)>(
            "SELECT b.owner_id, q.max_computers FROM bots b JOIN users u ON u.id=b.owner_id AND u.status='active' LEFT JOIN user_quotas q ON q.user_id=b.owner_id WHERE b.id=@bot", new { bot });
        // Check ownership before loading policy or touching compute inventory.
        if (row.Owner != owner) return 403;
        return Authorize(owner, row.Owner, row.Max, await SecurityRoutes.Load(platform, owner), await SecurityRoutes.DenyRules(platform));
    }

    public static void Map(WebApplication app)
    {
        app.MapPost("/api/bots/{id:guid}/computer/prewarm", async (HttpContext ctx, Guid id, ComputerPrewarmService service, CancellationToken ct) =>
        {
            var owner = await Routes.RequireUser(ctx, service.platform);
            if (owner == null) return Results.Unauthorized();
            if (!RumValidation.SameOrigin(ctx.Request)) return Results.StatusCode(403);
            var status = await service.CheckAsync(owner.Value, id, ct);
            if (status != 202) return Results.StatusCode(status);
            var placement = await service.platform.PlacementForBot(id, ct);
            // Read the existing inventory only. Unlike DemandAsync, this never starts recovery/create.
            if (!service.platform.Compute.HasExistingComputer(placement.Computer, owner.Value.ToString())) return Results.NoContent();
            var admission = service.Queue.TrySchedule(new(owner.Value, id, placement.Computer));
            if (admission is PrewarmAdmission.Duplicate or PrewarmAdmission.RateLimited)
            {
                ctx.Response.Headers.RetryAfter = admission == PrewarmAdmission.RateLimited ? "60" : "30";
                return Results.StatusCode(429);
            }
            return admission == PrewarmAdmission.Busy ? Results.StatusCode(503) : Results.Accepted();
        });
    }

    protected override Task ExecuteAsync(CancellationToken ct) => Queue.RunAsync(async (request, token) =>
    {
        if (await CheckAsync(request.Owner, request.Bot, token) != 202) return;
        var placement = await platform.PlacementForBot(request.Bot, token);
        if (placement.Computer != request.Computer) return;
        // Audit before starting the computer; a failed audit must not permit an unaudited wake.
        await platform.Audit(request.Owner.ToString(), "computer.prewarm", request.Bot, null, new { source = "composer" });
        await using var conn = await platform.Data.OpenConnectionAsync(token);
        var quota = await conn.ExecuteScalarAsync<int?>("SELECT max_computers FROM user_quotas WHERE user_id=@owner", new { owner = request.Owner });
        await platform.Compute.PrewarmExistingAsync(request.Computer, request.Owner.ToString(), token, quota ?? 1);
    }, _ => logger.LogWarning("Computer prewarm deferred"), ct);
}

public sealed class ComputerWarmPoolService(Platform platform, ILogger<ComputerWarmPoolService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        try { await platform.Compute.RunWarmPoolAsync(ct); }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception) { logger.LogWarning("Computer template pool unavailable"); }
    }
}
