using System.Collections.Concurrent;
using System.Net.Http.Headers;
using Dapper;

namespace Teammates.Api;

public sealed record AiRetry(int MaxRetries = 1, int AllowedFails = 3, int CooldownSeconds = 30);
public sealed record AiKillSwitch(string Mode = "off", AiTarget? SafeModel = null);
public sealed record AiCap(decimal? Daily = null, decimal? Monthly = null, string Action = "block", AiTarget? Downgrade = null);
public sealed record AiBudgets(Dictionary<string, AiCap>? Plans = null, Dictionary<Guid, AiCap>? Users = null, Dictionary<Guid, AiCap>? Bots = null);
public sealed record AiSpend(decimal Day, decimal Month);
public sealed record AiSpendDecision(bool Blocked = false, AiTarget? Downgrade = null);

public static class AiCapabilities
{
    public static List<string> Reasons(string name, AiRole role, AiProvider provider, AiModel model)
    {
        var errors = new List<string>();
        if (name is "chat" or "coding" && !(model.SupportedParameters?.Contains("tools") ?? model.Tools)) errors.Add($"{name}: model requires tools support");
        if (name == "vision" && !(model.InputModalities?.Contains("image") ?? model.Vision)) errors.Add("vision: model requires image input");
        if (model.ContextTokens < role.MinContextTokens) errors.Add($"{name}: context_length below role minimum ({role.MinContextTokens})");
        if (role.MaxTokens is <= 0 || role.Temperature is < 0 or > 2 || !double.IsFinite(role.Temperature ?? 0) || role.MinContextTokens < 0) errors.Add($"{name}: invalid token, temperature or context setting");
        // Native endpoints have no enforceable per-request ZDR routing contract.
        if (role.Privacy && provider.Kind != "openrouter") errors.Add($"{name}: privacy routing requires a provider that honors ZDR and data_collection deny; this provider cannot honor it");
        return errors;
    }
    public static int MaxTokens(AiRole? role, AiEndpoint endpoint) => Math.Max(1, Math.Min(role?.MaxTokens ?? 2048, endpoint.MaxCompletionTokens ?? int.MaxValue));
}

/// <summary>Per API instance, keyed by provider/model. An open circuit admits exactly one probe after cooldown.</summary>
public sealed class AiCircuitBreaker(TimeProvider? time = null)
{
    private sealed class Circuit { public int Failures; public DateTimeOffset? OpenUntil; public bool Probe; }
    private readonly ConcurrentDictionary<(Guid, string), Circuit> _states = new();
    private DateTimeOffset Now => (time ?? TimeProvider.System).GetUtcNow();
    public bool Enter(AiEndpoint endpoint)
    {
        var c = _states.GetOrAdd((endpoint.ProviderId, endpoint.Model), _ => new());
        lock (c)
        {
            if (c.OpenUntil == null) return true;
            if (c.OpenUntil > Now || c.Probe) return false;
            c.Probe = true; return true;
        }
    }
    public void Success(AiEndpoint endpoint)
    {
        var c = _states.GetOrAdd((endpoint.ProviderId, endpoint.Model), _ => new());
        lock (c) { c.Failures = 0; c.OpenUntil = null; c.Probe = false; }
    }
    public void Failure(AiEndpoint endpoint, AiRetry policy)
    {
        var c = _states.GetOrAdd((endpoint.ProviderId, endpoint.Model), _ => new());
        lock (c)
        {
            c.Failures++;
            if (c.Probe || c.Failures >= policy.AllowedFails) c.OpenUntil = Now.AddSeconds(policy.CooldownSeconds);
            c.Probe = false;
        }
    }
    public void CancelProbe(AiEndpoint endpoint)
    {
        if (_states.TryGetValue((endpoint.ProviderId, endpoint.Model), out var c)) lock (c) c.Probe = false;
    }
    public object[] Health() => _states.Select(pair =>
    {
        var c = pair.Value;
        lock (c) return (object)new { provider_id = pair.Key.Item1, model = pair.Key.Item2, state = c.Probe ? "half-open" : c.OpenUntil != null ? "open" : "closed", consecutive_failures = c.Failures, retry_at = c.OpenUntil };
    }).ToArray();
    public static TimeSpan Backoff(RetryConditionHeaderValue? retryAfter, int attempt, DateTimeOffset now)
    {
        var requested = retryAfter?.Delta ?? (retryAfter?.Date is { } date ? date - now : TimeSpan.Zero);
        return requested > TimeSpan.Zero ? requested : TimeSpan.FromMilliseconds(100 * Math.Pow(2, attempt) + Random.Shared.Next(25, 100));
    }
}

public sealed class AiSpendCache(Platform platform)
{
    private sealed record Entry(DateTimeOffset At, AiSpend Owner, AiSpend Bot);
    private readonly ConcurrentDictionary<(Guid Owner, Guid Bot), Entry> _entries = new();
    private readonly SemaphoreSlim _load = new(1, 1);
    public static List<string> Validate(AiBudgets? budgets, IReadOnlyList<AiProvider> providers)
    {
        var errors = new List<string>();
        foreach (var cap in (budgets?.Plans?.Values.AsEnumerable() ?? []).Concat(budgets?.Users?.Values.AsEnumerable() ?? []).Concat(budgets?.Bots?.Values.AsEnumerable() ?? []))
        {
            if (cap == null || cap.Daily is < 0 || cap.Monthly is < 0 || cap.Action is not ("block" or "downgrade")) { errors.Add("invalid spend cap"); continue; }
            if (cap.Action == "downgrade" && (cap.Downgrade == null || !providers.Any(p => p.Enabled && p.Id == cap.Downgrade.Provider && p.Models.Any(m => m.Id == cap.Downgrade.Model)))) errors.Add("downgrade requires an enabled configured model");
        }
        return errors;
    }
    public static List<string> ValidateDowngrades(AiConfig config, IReadOnlyList<AiProvider> providers)
    {
        var errors = new List<string>();
        var budgets = config.Budgets;
        foreach (var cap in (budgets?.Plans?.Values.AsEnumerable() ?? []).Concat(budgets?.Users?.Values.AsEnumerable() ?? []).Concat(budgets?.Bots?.Values.AsEnumerable() ?? []))
        {
            if (cap?.Action != "downgrade" || cap.Downgrade == null) continue;
            var provider = providers.FirstOrDefault(p => p.Id == cap.Downgrade.Provider);
            var cheap = provider?.Models.FirstOrDefault(m => m.Id == cap.Downgrade.Model);
            if (provider == null || cheap == null) continue;
            decimal? Price(AiModel model) => model.Pricing != null && decimal.TryParse(model.Pricing.GetValueOrDefault("prompt"), System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var input) && decimal.TryParse(model.Pricing.GetValueOrDefault("completion"), System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var output) ? input + output : null;
            foreach (var (name, role) in config.Roles ?? [])
            {
                errors.AddRange(AiCapabilities.Reasons(name, role, provider, cheap));
                var primary = providers.FirstOrDefault(p => p.Id == role.Primary.Provider)?.Models.FirstOrDefault(m => m.Id == role.Primary.Model);
                if (primary == null || Price(primary) is not { } normal || Price(cheap) is not { } lower || lower >= normal) errors.Add("downgrade must have catalog/manual prices cheaper than each role primary");
            }
        }
        return errors;
    }
    public static AiSpendDecision Decide(AiBudgets? budgets, Guid owner, Guid? bot, AiSpend ownerSpend, AiSpend botSpend)
    {
        var caps = new List<(AiCap?, AiSpend)> { (budgets?.Plans?.GetValueOrDefault("default"), ownerSpend), (budgets?.Users?.GetValueOrDefault(owner), ownerSpend), (bot == null ? null : budgets?.Bots?.GetValueOrDefault(bot.Value), botSpend) };
        AiTarget? downgrade = null;
        foreach (var (cap, spend) in caps)
            if (cap != null && (cap.Daily is { } d && spend.Day >= d || cap.Monthly is { } m && spend.Month >= m))
            {
                if (cap.Action == "block" || cap.Downgrade == null) return new(true);
                downgrade = cap.Downgrade;
            }
        return new(false, downgrade);
    }
    public void Record(Guid owner, Guid bot, decimal cost)
    {
        foreach (var pair in _entries.Where(e => e.Key.Owner == owner))
            _entries.TryUpdate(pair.Key, pair.Value with { Owner = new(pair.Value.Owner.Day + cost, pair.Value.Owner.Month + cost), Bot = pair.Key.Bot == bot ? new(pair.Value.Bot.Day + cost, pair.Value.Bot.Month + cost) : pair.Value.Bot }, pair.Value);
    }
    public async Task<AiSpendDecision> Check(AiBudgets? budgets, Guid owner, Guid? bot, CancellationToken ct)
    {
        if (budgets == null) return new();
        var key = (owner, bot ?? Guid.Empty);
        var now = DateTimeOffset.UtcNow;
        bool Fresh(Entry e) => now - e.At < TimeSpan.FromSeconds(3) && e.At.UtcDateTime.Date == now.UtcDateTime.Date;
        if (_entries.TryGetValue(key, out var entry) && Fresh(entry)) return Decide(budgets, owner, bot, entry.Owner, entry.Bot);
        await _load.WaitAsync(ct);
        try
        {
            if (!_entries.TryGetValue(key, out entry) || !Fresh(entry))
            {
                await using var conn = await platform.Data.OpenConnectionAsync(ct);
                var month = new DateTime(now.Year, now.Month, 1, 0, 0, 0, DateTimeKind.Utc);
                var row = await conn.QuerySingleAsync("""
                    SELECT coalesce(sum(cost_usd) FILTER(WHERE created_at>=@day),0) AS day, coalesce(sum(cost_usd),0) AS month,
                    coalesce(sum(cost_usd) FILTER(WHERE bot_id=@bot AND created_at>=@day),0) AS bot_day,
                    coalesce(sum(cost_usd) FILTER(WHERE bot_id=@bot),0) AS bot_month
                    FROM model_calls WHERE owner_id=@owner AND created_at>=@month
                    """, new { owner, bot, month, day = now.UtcDateTime.Date });
                entry = new(now, new((decimal)row.day, (decimal)row.month), new((decimal)row.bot_day, (decimal)row.bot_month));
                if (_entries.Count > 10000) _entries.Clear();
                _entries[key] = entry;
            }
            return Decide(budgets, owner, bot, entry.Owner, entry.Bot);
        }
        finally { _load.Release(); }
    }
}
