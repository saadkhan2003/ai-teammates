using Teammates.Compute;
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using Npgsql;

namespace Teammates.Api;

public static partial class AiAdmin
{
    private static readonly HttpClient Http = new(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(10) };
    private static IResult Json(object value) => Results.Json(value, AiModelRegistry.Json);
    private static Guid Actor(HttpContext ctx) => (Guid)ctx.Items["ai_actor"]!;
    private static T Read<T>(JsonElement body) => body.Deserialize<T>(AiModelRegistry.Json) ?? throw new ArgumentException("invalid body");
    // Create endpoints assign the id server-side; ignore any client id (the admin form sends "" for new rows).
    private static T ReadNew<T>(JsonElement body)
    {
        if (body.ValueKind != JsonValueKind.Object) return Read<T>(body);
        var node = System.Text.Json.Nodes.JsonObject.Create(body) ?? throw new ArgumentException("invalid body");
        node.Remove("id"); node.Remove("Id");
        return node.Deserialize<T>(AiModelRegistry.Json) ?? throw new ArgumentException("invalid body");
    }
    private static void Check(bool condition, string error) { if (!condition) throw new ArgumentException(error); }

    public static async Task<IResult?> Guard(HttpContext ctx, Platform platform)
    {
        var user = await Beta.User(ctx, platform);
        if (user == null) return Results.Unauthorized();
        if (!Access.IsStaff(await Beta.Role(platform, user.Value))) return Results.StatusCode(403);
        ctx.Items["ai_actor"] = user.Value;
        return null;
    }

    public static void Map(WebApplication app, Platform platform)
    {
        var registry = platform.AiRegistry;
        var limiter = new LoginRateLimiter(platform.TestHooks);
        var group = app.MapGroup("/api/admin/ai");
        group.AddEndpointFilter(async (context, next) =>
        {
            if (await Guard(context.HttpContext, platform) is { } denied) return denied;
            if (context.HttpContext.Request.Method != "GET")
            {
                var actor = Actor(context.HttpContext).ToString();
                if (limiter.IsBlocked(actor, DateTimeOffset.UtcNow)) return Results.StatusCode(429);
                limiter.NoteAttempt(actor, DateTimeOffset.UtcNow);
            }
            try { return await next(context); }
            catch (ArgumentException ex) { return Results.BadRequest(new { error = ex.Message }); }
            catch (KeyNotFoundException) { return Results.BadRequest(new { error = "required field missing" }); }
            catch (InvalidOperationException) { return Results.BadRequest(new { error = "invalid field type" }); }
            catch (JsonException) { return Results.BadRequest(new { error = "invalid configuration shape" }); }
            catch (PostgresException ex) when (ex.SqlState == "23505") { return Results.Conflict(new { error = "name already exists" }); }
        });
        group.MapGet("", async () =>
        {
            var snapshot = await registry.Snapshot();
            var active = snapshot.Versions.FirstOrDefault(v => v.IsActive);
            await using var conn = await platform.Data.OpenConnectionAsync();
            var changedRaw = await conn.ExecuteScalarAsync<DateTime?>("SELECT max(created_at) FROM ai_config_audit WHERE action IN ('config.published','config.rollback','rollout.promoted')");
            DateTimeOffset? changed = changedRaw is { } at ? new DateTimeOffset(DateTime.SpecifyKind(at, DateTimeKind.Utc)) : null;
            return Json(new { bootstrap_config = active == null ? new { kind = platform.LlmProvider, model = platform.ModelName } : null, last_change = changed, providers = snapshot.Providers, active_config = active?.Config, version = active?.Version ?? 0, rollout = snapshot.Rollout ?? new(), bootstrap = active == null });
        });
        group.MapGet("/versions", async () => Json((await registry.Snapshot()).Versions));
        group.MapGet("/audit", async (HttpContext ctx) =>
        {
            var limit = int.TryParse(ctx.Request.Query["limit"], out var n) ? Math.Clamp(n, 1, 200) : 50;
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync("SELECT id,actor,action,detail::text,created_at FROM ai_config_audit ORDER BY id DESC LIMIT @limit", new { limit });
            return Json(rows.Select(r => new { id = (long)r.id, actor = (Guid?)r.actor, action = (string)r.action, detail = JsonSerializer.Deserialize<JsonElement>((string)r.detail), created_at = (DateTimeOffset)r.created_at }));
        });
        group.MapPost("/providers", (HttpContext ctx, JsonElement body) => Write(platform, Actor(ctx), "provider.created", async (conn, tx) =>
        {
            var provider = ReadNew<AiProvider>(body) with { Id = Guid.NewGuid() };
            ValidateProvider(provider);
            await conn.ExecuteAsync("INSERT INTO ai_providers(id,name,kind,base_url,enabled,models) VALUES(@Id,@Name,@Kind,@BaseUrl,@Enabled,CAST(@models AS jsonb))", new { provider.Id, provider.Name, provider.Kind, provider.BaseUrl, provider.Enabled, models = JsonSerializer.Serialize(provider.Models, AiModelRegistry.Json) }, tx);
            return new { id = provider.Id };
        }));
        group.MapPut("/providers/{id:guid}", (HttpContext ctx, Guid id, JsonElement body) => Write(platform, Actor(ctx), "provider.updated", async (conn, tx) =>
        {
            var provider = Read<AiProvider>(body) with { Id = id };
            ValidateProvider(provider);
            var snapshot = await registry.Snapshot();
            Check(snapshot.Providers.Any(p => p.Id == id), "provider not found");
            var providers = snapshot.Providers.Select(p => p.Id == id ? provider : p).ToList();
            if (snapshot.KillSwitch?.SafeModel is { } safe && safe.Provider == id)
            {
                Check(provider.Enabled && provider.Kind == snapshot.Providers.Single(p => p.Id == id).Kind && provider.Models.Any(m => m.Id == safe.Model), "provider/model is reserved by the kill switch");
                foreach (var version in snapshot.Versions)
                    foreach (var (name, role) in version.Config.Roles) Check(AiCapabilities.Reasons(name, role, provider, provider.Models.Single(m => m.Id == safe.Model)).Count == 0, "safe model must retain configured role capabilities and privacy");
            }
            foreach (var config in await ReferencedConfigs(conn, tx, snapshot)) Check(AiModelRegistry.Validate(config, providers).Count == 0, "provider is referenced by immutable saved history; retain its models and capabilities");
            await conn.ExecuteAsync("UPDATE ai_providers SET name=@Name,kind=@Kind,base_url=@BaseUrl,enabled=@Enabled,models=CAST(@models AS jsonb),updated_at=now() WHERE id=@Id", new { provider.Id, provider.Name, provider.Kind, provider.BaseUrl, provider.Enabled, models = JsonSerializer.Serialize(provider.Models, AiModelRegistry.Json) }, tx);
            return new { id };
        }));
        group.MapDelete("/providers/{id:guid}", (HttpContext ctx, Guid id) => Write(platform, Actor(ctx), "provider.deleted", async (conn, tx) =>
        {
            var snapshot = await registry.Snapshot();
            Check(snapshot.KillSwitch?.SafeModel?.Provider != id && !(await ReferencedConfigs(conn, tx, snapshot)).Any(c => AiModelRegistry.Targets(c).Any(t => t.Provider == id)), "provider is referenced by saved history or the kill switch");
            Check(await conn.ExecuteAsync("DELETE FROM ai_providers WHERE id=@id", new { id }, tx) == 1, "provider not found");
            return new { id };
        }));
        group.MapPut("/providers/{id:guid}/key", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var key = body.GetProperty("key").GetString() ?? "";
            Check(key.Length is > 0 and <= 16384 && !key.Any(char.IsControl), "key is required and must be a single line");
            var bytes = Encoding.UTF8.GetBytes(key);
            try
            {
                var (cipher, nonce) = KeyEncryption.Encrypt(platform.MasterKey, id, Guid.Empty, "AI_PROVIDER", KeyEncryption.KeyVersion, bytes);
                await Write(platform, Actor(ctx), "provider.key_rotated", async (conn, tx) =>
                {
                    Check(await conn.ExecuteAsync("UPDATE ai_providers SET key_ciphertext=@cipher,key_nonce=@nonce,key_version=@version,key_updated_at=now(),updated_at=now() WHERE id=@id", new { id, cipher, nonce, version = KeyEncryption.KeyVersion }, tx) == 1, "provider not found");
                    return new { id };
                });
            }
            finally { CryptographicOperations.ZeroMemory(bytes); key = ""; }
            return Results.NoContent();
        });
        group.MapPost("/providers/{id:guid}/test", async (HttpContext ctx, Guid id, CancellationToken ct) =>
        {
            var provider = (await registry.Snapshot(ct)).Providers.FirstOrDefault(p => p.Id == id);
            if (provider == null) return Results.NotFound();
            var result = await Test(provider, await registry.Key(id, ct), ct);
            await Write(platform, Actor(ctx), "provider.tested", (conn, tx) => Task.FromResult<object>(new { id, result.Ok }));
            return Json(result);
        });
        group.MapPut("/config", (HttpContext ctx, JsonElement body) => Write(platform, Actor(ctx), "config.created", async (conn, tx) =>
        {
            var config = Read<AiConfig>(body.GetProperty("config"));
            var candidate = !body.TryGetProperty("as_candidate", out var asCandidate) || asCandidate.GetBoolean();
            var note = body.TryGetProperty("note", out var noteNode) ? Dlp.Redact(noteNode.GetString() ?? "") : "";
            Check(note.Length <= 1000, "note too long");
            var snapshot = await registry.Snapshot();
            ValidateConfig(config, snapshot);
            var active = snapshot.Versions.FirstOrDefault(v => v.IsActive);

            // Candidate rollout metadata comes from the active version, never from itself.
            Check(candidate, "create a candidate, run eval, then publish");
            var version = await CreateVersion(conn, tx, config with { Rollout = candidate ? new() : config.Rollout }, note, Actor(ctx), !candidate);
            if (candidate) await SetRollout(conn, tx, active?.Version ?? 0, new(version, 0));
            return new { version, as_candidate = candidate };
        }));
        group.MapPost("/versions/{v:int}/rollback", (HttpContext ctx, int v) => Write(platform, Actor(ctx), "config.rollback", async (conn, tx) =>
        {
            var snapshot = await registry.Snapshot();
            var source = snapshot.Versions.FirstOrDefault(x => x.Version == v);
            Check(source != null, "version not found");
            var config = source!.Config with { Rollout = new() };
            ValidateConfig(config, snapshot);
            if (!await conn.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM ai_config_activations WHERE version=@v)", new { v }, tx))
                await CheckEval(conn, tx, v, Actor(ctx), null, platform);
            await Activate(conn, tx, v);
            return new { version = v, source_version = v };
        }));
        group.MapPut("/rollout", (HttpContext ctx, JsonElement body) => Write(platform, Actor(ctx), "rollout.updated", async (conn, tx) =>
        {
            var rollout = Read<AiRollout>(body);
            var snapshot = await registry.Snapshot();
            var active = snapshot.Versions.FirstOrDefault(v => v.IsActive);
            Check(active != null, "active configuration required");
            ValidateConfig(active!.Config with { Rollout = rollout }, snapshot);
            if (rollout.Percent > 0 && rollout.CandidateVersion is { } candidateVersion) await CheckEval(conn, tx, candidateVersion, Actor(ctx), body, platform);
            await SetRollout(conn, tx, active.Version, rollout);
            return rollout;
        }));
        group.MapPost("/rollout/promote", (Func<HttpContext, Task<IResult>>)((HttpContext ctx) => Write(platform, Actor(ctx), "rollout.promoted", async (conn, tx) =>
        {
            var snapshot = await registry.Snapshot();
            var active = snapshot.Versions.FirstOrDefault(v => v.IsActive);
            var candidate = snapshot.Versions.FirstOrDefault(v => v.Version == snapshot.Rollout?.CandidateVersion);
            Check(candidate != null, "candidate required");
            await CheckEval(conn, tx, candidate!.Version, Actor(ctx), null, platform);
            var config = candidate!.Config with { Rollout = new() };
            ValidateConfig(config, snapshot);
            await Activate(conn, tx, candidate.Version);
            return new { version = candidate.Version };
        })));
        MapControls(group, platform);
        MapShell(app, platform);
    }

    private static Task<IEnumerable<AiConfig>> ReferencedConfigs(NpgsqlConnection conn, NpgsqlTransaction tx, AiSnapshot snapshot) =>
        Task.FromResult<IEnumerable<AiConfig>>(snapshot.Versions.Select(v => v.Config));
    public static void ValidateProvider(AiProvider provider)
    {
        Check(!string.IsNullOrWhiteSpace(provider.Name) && provider.Name.Length <= 120, "name required (max 120 characters)");
        Check(provider.Kind is "mock" or "openrouter" or "anthropic" or "openai" or "google" or "openai_compatible", "invalid provider kind");
        Check(Uri.TryCreate(provider.BaseUrl, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https" && uri.UserInfo == "" && uri.Query == "" && uri.Fragment == "", "base_url must be an http(s) URL without credentials, query or fragment");
        Check(provider.Models is { Count: > 0 and <= 500 } && provider.Models.All(m => m != null && !string.IsNullOrWhiteSpace(m.Id) && m.Id.Length <= 200 && m.ContextTokens >= 0 && (m.MaxCompletionTokens == null || m.MaxCompletionTokens > 0) && (m.Pricing == null || m.Pricing.Values.All(value => decimal.TryParse(value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var amount) && amount >= 0))) && provider.Models.Select(m => m.Id).Distinct().Count() == provider.Models.Count, "models must have unique nonempty ids and nonnegative context_tokens");
    }
    private static void ValidateConfig(AiConfig config, AiSnapshot snapshot)
    {
        var errors = AiModelRegistry.Validate(config, snapshot.Providers);
        if (snapshot.KillSwitch is { Mode: "safe", SafeModel: { } safe })
        {
            var provider = snapshot.Providers.FirstOrDefault(p => p.Id == safe.Provider && p.Enabled);
            var model = provider?.Models.FirstOrDefault(m => m.Id == safe.Model);
            if (model == null) errors.Add("safe model is unavailable");
            else foreach (var (name, role) in config.Roles ?? []) if (role != null) errors.AddRange(AiCapabilities.Reasons(name, role, provider!, model));
        }
        if (config.Rollout?.CandidateVersion is { } v)
        {
            var candidate = snapshot.Versions.FirstOrDefault(x => x.Version == v && !x.IsActive);
            if (candidate == null || AiModelRegistry.Validate(candidate.Config, snapshot.Providers).Count > 0) errors.Add("candidate must be an existing valid inactive version");
        }
        Check(errors.Count == 0, string.Join("; ", errors.Distinct()));
    }
    public static async Task<int> CreateVersion(NpgsqlConnection conn, NpgsqlTransaction tx, AiConfig config, string note, Guid actor, bool active)
    {
        var version = await conn.ExecuteScalarAsync<int>("SELECT coalesce(max(version),0)+1 FROM ai_config_versions", transaction: tx);

        await conn.ExecuteAsync("INSERT INTO ai_config_versions(version,config,note,created_by,is_active) VALUES(@version,CAST(@config AS jsonb),@note,@actor,@active)", new { version, config = JsonSerializer.Serialize(config, AiModelRegistry.Json), note, actor, active = false }, tx);
        if (active) await Activate(conn, tx, version);
        return version;
    }
    private static Task SetRollout(NpgsqlConnection conn, NpgsqlTransaction tx, int version, AiRollout rollout) => conn.ExecuteAsync("UPDATE ai_config_state SET candidate_version=@CandidateVersion,rollout_percent=@Percent WHERE id=1", new { version, rollout.CandidateVersion, rollout.Percent }, tx);

    private static async Task Activate(NpgsqlConnection conn, NpgsqlTransaction tx, int version)
    {
        await conn.ExecuteAsync("INSERT INTO ai_config_activations(version) VALUES(@version) ON CONFLICT DO NOTHING", new { version }, tx);
        await conn.ExecuteAsync("UPDATE ai_config_state SET active_version=@version,candidate_version=NULL,rollout_percent=0,activation_epoch=activation_epoch+1 WHERE id=1", new { version }, tx);
    }

    private static async Task<IResult> Write(Platform platform, Guid actor, string action, Func<NpgsqlConnection, NpgsqlTransaction, Task<object>> change)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        await using var tx = await conn.BeginTransactionAsync();
        await conn.ExecuteAsync("SELECT pg_advisory_xact_lock(840044)", transaction: tx);
        // Refresh after obtaining the write lock, so concurrent writers validate the committed state.
        platform.AiRegistry.Invalidate();
        var before = await StateSummary(conn, tx);
        var detail = await change(conn, tx);
        var after = await StateSummary(conn, tx);
        var json = JsonSerializer.Serialize(new { result = detail, before, after }, AiModelRegistry.Json);
        await conn.ExecuteAsync("INSERT INTO ai_config_audit(actor,action,detail) VALUES(@actor,@action,CAST(@json AS jsonb))", new { actor, action, json }, tx);
        await tx.CommitAsync();
        platform.AiRegistry.Invalidate();
        await platform.Audit(actor.ToString(), "ai." + action, null, null, detail);
        return Json(detail);
    }

    public sealed record ProbeResult(bool Ok, long LatencyMs, string? Error = null, List<string>? Models = null);
    public static async Task<ProbeResult> Test(AiProvider provider, byte[]? bytes, CancellationToken ct, HttpClient? client = null)
    {
        if (bytes == null) return new(false, 0, "key_not_set");
        var key = Encoding.UTF8.GetString(bytes);
        CryptographicOperations.ZeroMemory(bytes);
        var clock = Stopwatch.StartNew();
        try
        {
            var url = provider.Kind == "anthropic" ? AiGateway.MessagesUrl(provider.BaseUrl).Replace("/messages", "/models") : provider.BaseUrl.TrimEnd('/') + (provider.Kind == "openrouter" ? "/key" : "/models");
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            if (provider.Kind == "anthropic") { request.Headers.Add("x-api-key", key); request.Headers.Add("anthropic-version", "2023-06-01"); }
            else request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
            using var response = await (client ?? Http).SendAsync(request, ct);
            if (!response.IsSuccessStatusCode) return new(false, clock.ElapsedMilliseconds, $"http_{(int)response.StatusCode}");
            var raw = await response.Content.ReadAsStringAsync(ct);
            if (provider.Kind == "openrouter" && !ProviderWire.ReadKey(raw).Ok) return new(false, clock.ElapsedMilliseconds, "invalid_response");
            using var doc = JsonDocument.Parse(raw);
            var models = doc.RootElement.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array
                ? data.EnumerateArray().Where(m => m.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String).Select(m => OutputRedactor.Redact(m.GetProperty("id").GetString()!, [key])).Take(500).ToList() : null;
            return new(true, clock.ElapsedMilliseconds, Models: models);
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or JsonException) { return new(false, clock.ElapsedMilliseconds, "unreachable_or_invalid_response"); }
        finally { key = ""; }
    }

    private static void MapShell(WebApplication app, Platform platform)
    {
        var group = app.MapGroup("/api/admin");
        group.AddEndpointFilter(async (context, next) => await Guard(context.HttpContext, platform) ?? await next(context));
        group.MapGet("/accounts", async () =>
        {
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync("SELECT u.id,u.username,u.display_name,u.role,u.status,count(m.id)::int AS calls,coalesce(sum(m.cost_usd),0) AS cost FROM users u LEFT JOIN model_calls m ON m.owner_id=u.id GROUP BY u.id ORDER BY u.created_at");
            return Results.Json(new { allowances = new Dictionary<string, int>(), users = rows.Select(r => new { id = (Guid)r.id, username = (string)r.username, displayName = (string?)r.display_name ?? (string)r.username, email = "", role = (string)r.role, status = (string)r.status, planId = "default", creditBalance = 0, creditAllowance = 0, modelCalls = (int)r.calls, costUsd = (decimal)r.cost, suspended = (string)r.status == "disabled" }) });
        });
        group.MapGet("/platform", () => Results.Json(new { billingAvailable = false, aiConfigurationUrl = "/api/admin/ai", version = "0.4" }));
        group.MapGet("/ai/calls", async () =>
        {
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync("SELECT id,owner_id,bot_id,task_id,provider_id,provider,model,served_model,fallback_used,config_version,prompt_tokens,completion_tokens,cost_usd,credits,ok,created_at FROM model_calls ORDER BY created_at DESC LIMIT 100");
            return Results.Json(rows.Select(Platform.ToDict));
        });
    }
}
