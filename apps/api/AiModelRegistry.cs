using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Dapper;
using Npgsql;

namespace Teammates.Api;

public sealed record AiModel(string Id, string Label = "", bool Vision = false, bool Tools = false, bool Caching = false, int ContextTokens = 0, int? MaxCompletionTokens = null, List<string>? SupportedParameters = null,
    List<string>? InputModalities = null, List<string>? OutputModalities = null, Dictionary<string, string>? Pricing = null, string? ExpirationDate = null);
public sealed record AiTarget(Guid Provider, string Model);
public sealed record AiRole(AiTarget Primary, List<AiTarget>? Fallbacks = null, int? MaxTokens = null, double? Temperature = null, bool Privacy = false, int MinContextTokens = 0);
public sealed record AiCaching(bool Enabled = true, bool AnthropicCacheControl = true, bool SessionIdPerConversation = true, string Ttl = "5m");
public sealed record AiLatency(int? PreferredMaxLatencyMs = null);
public sealed record AiPrice(decimal InputPerMtok = 0, decimal OutputPerMtok = 0, decimal Multiplier = 1);
public sealed record AiRollout(int? CandidateVersion = null, int Percent = 0);
public sealed record AiConfig(Dictionary<string, AiRole> Roles, AiCaching? Caching = null, AiLatency? Latency = null,
    Dictionary<string, Dictionary<string, AiPrice>>? CreditPrices = null, AiRollout? Rollout = null, AiRetry? Retry = null, AiBudgets? Budgets = null);
public sealed record AiProvider(Guid Id, string Name, string Kind, string BaseUrl, bool Enabled, List<AiModel> Models, bool KeySet, DateTimeOffset? KeyUpdatedAt);
public sealed record AiVersion(int Version, AiConfig Config, string Note, Guid? CreatedBy, DateTimeOffset CreatedAt, bool IsActive);
public sealed record AiSnapshot(long Revision, List<AiProvider> Providers, List<AiVersion> Versions, AiKillSwitch? KillSwitch = null, AiRollout? Rollout = null, long ActivationEpoch = 0);
public sealed record AiEndpoint(Guid ProviderId, string Kind, string BaseUrl, string Model,
    [property: JsonIgnore] Func<CancellationToken, Task<byte[]?>> Key,
    [property: JsonIgnore] Func<CancellationToken, Task<byte[]?>>? NextKey = null, int? MaxCompletionTokens = null, AiModel? Catalog = null);
public sealed record AiResolution(AiEndpoint Primary, List<AiEndpoint> Fallbacks, AiCaching Caching, AiLatency Latency, int ConfigVersion, AiConfig Config, AiRole? Role = null, string RoleName = "chat",
    [property: JsonIgnore] Func<AiTarget, AiEndpoint>? EndpointFor = null,
    [property: JsonIgnore] Func<CancellationToken, Task<AiSpendDecision>>? CheckSpend = null, AiKillSwitch? KillSwitch = null,
    AiCircuitBreaker? Breakers = null,
    [property: JsonIgnore] Func<AiEndpoint, CancellationToken, Task<string?>>? CheckEndpoint = null);

/// <summary>One snapshot per process. Keys are decrypted only at the last responsible moment.</summary>
public sealed class AiModelRegistry(Platform platform) : BackgroundService
{
    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower, PropertyNameCaseInsensitive = true };
    private readonly SemaphoreSlim _load = new(1, 1);
    private AiSnapshot? _snapshot;
    private long _generation;
    public AiCircuitBreaker Breakers { get; } = new();
    private readonly AiSpendCache _spend = new(platform);
    private readonly ConcurrentDictionary<(Guid Task, int Active, long Epoch), int> _assignments = new();
    public void RecordSpend(Guid owner, Guid bot, decimal cost) => _spend.Record(owner, bot, cost);
    public void Invalidate() { Interlocked.Increment(ref _generation); Volatile.Write(ref _snapshot, null); }

    public static AiConfig Bootstrap(string provider, string model) => new(new() { ["chat"] = new(new(Guid.Empty, model)) });
    public static bool Candidate(Guid user, int version, int percent) => percent >= 100 || (percent > 0 &&
        BinaryPrimitives.ReadUInt32BigEndian(SHA256.HashData(Encoding.UTF8.GetBytes($"{user:D}:{version}"))) % 100 < percent);

    public async Task<AiSnapshot> Snapshot(CancellationToken ct = default)
    {
        if (Volatile.Read(ref _snapshot) is { } cached) return cached;
        await _load.WaitAsync(ct);
        try
        {
            if (_snapshot is { } loaded) return loaded;
            var generation = Interlocked.Read(ref _generation);
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            await using var tx = await conn.BeginTransactionAsync(System.Data.IsolationLevel.RepeatableRead, ct);
            var state = await conn.QuerySingleAsync("SELECT revision,active_version,candidate_version,rollout_percent,kill_switch::text,activation_epoch FROM ai_config_state WHERE id=1", transaction: tx);
            long revision = state.revision;
            int? activeId = state.active_version;
            var rolloutState = new AiRollout((int?)state.candidate_version, (int)state.rollout_percent);
            var kill = JsonSerializer.Deserialize<AiKillSwitch>((string)state.kill_switch, Json);
            var providers = (await conn.QueryAsync("SELECT id,name,kind,base_url,enabled,models::text,(key_ciphertext IS NOT NULL) AS key_set,key_updated_at FROM ai_providers ORDER BY name", transaction: tx))
                .Select(r => new AiProvider((Guid)r.id, (string)r.name, (string)r.kind, (string)r.base_url, (bool)r.enabled,
                    JsonSerializer.Deserialize<List<AiModel>>((string)r.models, Json)!, (bool)r.key_set, (DateTimeOffset?)r.key_updated_at)).ToList();
            var catalog = (await conn.QueryAsync("SELECT provider_id,model,metadata::text,present FROM ai_model_catalog", transaction: tx)).ToList();
            providers = providers.Select(p => p with { Models = catalog.Any(c => (Guid)c.provider_id == p.Id) ? catalog.Where(c => (Guid)c.provider_id == p.Id && (bool)c.present).Select(c => JsonSerializer.Deserialize<AiModel>((string)c.metadata, Json)!).ToList() : p.Models }).ToList();
            var versions = (await conn.QueryAsync("SELECT version,config::text,note,created_by,created_at,is_active FROM ai_config_versions ORDER BY version DESC", transaction: tx))
                .Select(r => new AiVersion((int)r.version, JsonSerializer.Deserialize<AiConfig>((string)r.config, Json)!, (string)r.note,
                    (Guid?)r.created_by, (DateTimeOffset)r.created_at, (int)r.version == activeId)).ToList();
            await tx.CommitAsync(ct);
            var snapshot = new AiSnapshot(revision, providers, versions, kill, rolloutState, (long)state.activation_epoch);
            if (generation == Interlocked.Read(ref _generation)) Volatile.Write(ref _snapshot, snapshot);
            return snapshot;
        }
        finally { _load.Release(); }
    }

    public async Task<AiResolution> Resolve(string role, Guid userId, Guid taskId, Guid? botId = null, CancellationToken ct = default)
    {
        var snapshot = await Snapshot(ct);
        var active = snapshot.Versions.FirstOrDefault(v => v.IsActive);
        var version = active;
        if (active != null && snapshot.Rollout is { CandidateVersion: { } candidate, Percent: > 0 } rollout && Candidate(userId, candidate, rollout.Percent))
            version = snapshot.Versions.FirstOrDefault(v => v.Version == candidate) ?? active;
        if (active != null && taskId != Guid.Empty)
        {
            var assignmentKey = (taskId, active.Version, snapshot.ActivationEpoch);
            if (!_assignments.TryGetValue(assignmentKey, out var assigned))
            {
                await using var conn = await platform.Data.OpenConnectionAsync(ct);
                // Only persisted tasks need a binding; synthetic previews remain stateless.
                await conn.ExecuteAsync("INSERT INTO ai_task_config_assignments(task_id,active_version,resolved_version,activation_epoch) SELECT id,@active,@resolved,@epoch FROM tasks WHERE id=@task ON CONFLICT DO NOTHING", new { task = taskId, active = active.Version, resolved = version!.Version, epoch = snapshot.ActivationEpoch });
                var persisted = await conn.ExecuteScalarAsync<int?>("SELECT resolved_version FROM ai_task_config_assignments WHERE task_id=@task AND active_version=@active AND activation_epoch=@epoch", new { task = taskId, active = active.Version, epoch = snapshot.ActivationEpoch });
                assigned = persisted ?? version!.Version;
                // Bound process memory; the database retains assignments across eviction/restarts.
                if (_assignments.Count > 20000) _assignments.Clear();
                if (persisted != null) _assignments.TryAdd(assignmentKey, assigned);
            }
            version = snapshot.Versions.First(v => v.Version == assigned);
        }
        var config = version?.Config ?? Bootstrap(platform.LlmProvider, platform.ModelName);
        role = role is "planner" ? "chat" : role is "compactor" ? "quick" : role;
        var selected = config.Roles.GetValueOrDefault(role) ?? config.Roles["chat"];
        AiEndpoint Endpoint(AiTarget t)
        {
            if (t.Provider == Guid.Empty) return new(Guid.Empty, platform.LlmProvider, platform.OpenRouterBase, t.Model,
                token => platform.Resolve(userId, "secret://openrouter/default", "model_gateway", botId, null, taskId, "model_gateway"));
            var p = snapshot.Providers.Single(p => p.Id == t.Provider);
            return new(p.Id, p.Kind, p.BaseUrl, t.Model, token => Key(p.Id, token), token => KeySlot(p.Id, "next", token), p.Models.FirstOrDefault(m => m.Id == t.Model)?.MaxCompletionTokens, p.Models.FirstOrDefault(m => m.Id == t.Model));
        }
        return new(Endpoint(selected.Primary), (selected.Fallbacks ?? []).Select(Endpoint).ToList(), config.Caching ?? new(), config.Latency ?? new(), version?.Version ?? 0, config, selected, role, Endpoint,
            token => _spend.Check(config.Budgets, userId, botId, token), snapshot.KillSwitch, Breakers, (endpoint, token) => AdminModelAdmission.Check(platform, endpoint.Model, token));
    }

    public async Task<byte[]?> Key(Guid id, CancellationToken ct = default)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var row = await conn.QuerySingleOrDefaultAsync<(byte[]? Cipher, byte[]? Nonce, int Version)>(
            "SELECT key_ciphertext,key_nonce,key_version FROM ai_providers WHERE id=@id", new { id });
        return row.Cipher == null ? null : KeyEncryption.Decrypt(platform.MasterKey, id, Guid.Empty, "AI_PROVIDER", row.Version, row.Cipher, row.Nonce!);
    }

    public async Task<byte[]?> KeySlot(Guid id, string slot, CancellationToken ct = default)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var row = await conn.QuerySingleOrDefaultAsync<(byte[]? Cipher, byte[]? Nonce, int Version)>(
            "SELECT ciphertext,nonce,key_version FROM ai_provider_key_slots WHERE provider_id=@id AND slot=@slot", new { id, slot });
        return row.Cipher == null ? null : KeyEncryption.Decrypt(platform.MasterKey, id, Guid.Empty, "AI_PROVIDER", row.Version, row.Cipher, row.Nonce!);
    }

    public static IEnumerable<AiTarget> Targets(AiConfig config) => config.Roles.Values.SelectMany(r => new[] { r.Primary }.Concat(r.Fallbacks ?? []))
        .Concat((config.Budgets?.Plans?.Values.AsEnumerable() ?? []).Concat(config.Budgets?.Users?.Values.AsEnumerable() ?? []).Concat(config.Budgets?.Bots?.Values.AsEnumerable() ?? []).Where(c => c?.Downgrade != null).Select(c => c.Downgrade!));

    public static List<string> Validate(AiConfig config, IReadOnlyList<AiProvider> providers)
    {
        var errors = new List<string>();
        if (config.Roles == null || !config.Roles.ContainsKey("chat")) errors.Add("roles.chat is required");
        foreach (var (name, role) in config.Roles ?? [])
        {
            if (name is not ("chat" or "quick" or "vision" or "coding")) errors.Add("unknown role");
            if (role?.Primary == null) { errors.Add("primary is required"); continue; }
            if (role.Fallbacks?.Count > 8) errors.Add("at most eight fallbacks per role");
            foreach (var target in new[] { role.Primary }.Concat(role.Fallbacks ?? []))
            {
                var provider = providers.FirstOrDefault(p => p.Id == target?.Provider);
                if (provider == null || !provider.Enabled) errors.Add("provider must exist and be enabled");
                else if (provider.Models.FirstOrDefault(m => m.Id == target!.Model) is not { } model) errors.Add("model must be listed by provider");
                else errors.AddRange(AiCapabilities.Reasons(name, role, provider, model));
            }
        }
        if (config.Retry is { } retry && (retry.MaxRetries is < 0 or > 3 || retry.AllowedFails < 1 || retry.CooldownSeconds is < 1 or > 3600)) errors.Add("invalid retry/cooldown settings");
        errors.AddRange(AiSpendCache.Validate(config.Budgets, providers));
        if (config.Roles != null && errors.Count == 0) errors.AddRange(AiSpendCache.ValidateDowngrades(config, providers));
        if (config.Rollout is { Percent: < 0 or > 100 } || config.Rollout is { Percent: > 0, CandidateVersion: null }) errors.Add("invalid rollout");
        if (config.Latency?.PreferredMaxLatencyMs is <= 0) errors.Add("latency must be positive");
        if (config.Caching?.Ttl is not (null or "5m" or "1h")) errors.Add("cache ttl must be 5m or 1h");
        foreach (var map in config.CreditPrices?.Values.AsEnumerable() ?? [])
            if (map == null || map.Values.Any(p => p == null || p.InputPerMtok < 0 || p.OutputPerMtok < 0 || p.Multiplier < 0)) errors.Add("prices must be nonnegative");
        return errors;
    }

    public static decimal? Credits(AiConfig config, string plan, string model, TokenUsage usage) =>
        config.CreditPrices?.GetValueOrDefault(plan)?.GetValueOrDefault(model) is { } price
            ? (usage.PromptTokens * price.InputPerMtok + usage.CompletionTokens * price.OutputPerMtok) / 1_000_000m * price.Multiplier : null;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var conn = await platform.Data.OpenConnectionAsync(stoppingToken);
                conn.Notification += (_, _) => Invalidate();
                await conn.ExecuteAsync("LISTEN ai_config");
                while (!stoppingToken.IsCancellationRequested)
                {
                    await conn.WaitAsync(10_000, stoppingToken);
                    var revision = await conn.ExecuteScalarAsync<long>("SELECT revision FROM ai_config_state WHERE id=1");
                    if (_snapshot is { } cached && revision != cached.Revision) Invalidate();
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception) { Invalidate(); await Task.Delay(1000, stoppingToken); }
        }
    }
}
