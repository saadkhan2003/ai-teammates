using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using Npgsql;

namespace Teammates.Api;

public static partial class AiAdmin
{
    private static IDictionary<string, object> Row(object row) => (IDictionary<string, object>)row;
    private static async Task<object> StateSummary(NpgsqlConnection conn, NpgsqlTransaction tx)
    {
        var state = await conn.QuerySingleAsync("SELECT active_version,candidate_version,rollout_percent,kill_switch::text,activation_epoch FROM ai_config_state WHERE id=1", transaction: tx);
        var config = await conn.ExecuteScalarAsync<string?>("SELECT config::text FROM ai_config_versions WHERE version=@version", new { version = (int?)state.active_version }, tx);
        var candidateConfig = await conn.ExecuteScalarAsync<string?>("SELECT config::text FROM ai_config_versions WHERE version=@version", new { version = (int?)state.candidate_version }, tx);
        var slots = await conn.QueryAsync("SELECT provider_id,slot,updated_at,tested_at FROM ai_provider_key_slots ORDER BY provider_id,slot", transaction: tx);
        var providers = await conn.QueryAsync("SELECT id,name,kind,base_url,enabled,models::text,key_updated_at FROM ai_providers ORDER BY id", transaction: tx);
        return new { activation_epoch = (long)state.activation_epoch, active_version = (int?)state.active_version, candidate_version = (int?)state.candidate_version, percent = (int)state.rollout_percent, kill_switch = JsonSerializer.Deserialize<JsonElement>((string)state.kill_switch), config = config == null ? (JsonElement?)null : JsonSerializer.Deserialize<JsonElement>(config), candidate_config = candidateConfig == null ? (JsonElement?)null : JsonSerializer.Deserialize<JsonElement>(candidateConfig), providers = providers.Select(Row), slots = slots.Select(Row) };
    }
    private static async Task CheckEval(NpgsqlConnection conn, NpgsqlTransaction tx, int version, Guid actor, JsonElement? body, Platform platform)
    {
        var active = await conn.ExecuteScalarAsync<int?>("SELECT active_version FROM ai_config_state WHERE id=1", transaction: tx);
        if (active == version) return;
        var run = await conn.QuerySingleOrDefaultAsync("SELECT candidate_score,active_score,hard_pass,tolerance FROM ai_eval_runs WHERE candidate_version=@version AND active_version IS NOT DISTINCT FROM @active ORDER BY id DESC LIMIT 1", new { version, active }, tx);
        if (run != null && AiEvals.MayPublish((decimal)run.candidate_score, (decimal)run.active_score, (bool)run.hard_pass, (decimal)run.tolerance)) return;
        var reason = body is { } b && b.TryGetProperty("override_reason", out var r) && r.ValueKind == JsonValueKind.String ? Dlp.Redact(r.GetString() ?? "").Trim() : "";
        Check(reason.Length is >= 8 and <= 1000 && await Beta.Role(platform, actor) == "owner", "eval gate blocked: run a passing eval against the current active version, or an owner must provide an override_reason (8–1000 characters)");
        await conn.ExecuteAsync("INSERT INTO ai_config_audit(actor,action,detail) VALUES(@actor,'eval.owner_override',CAST(@detail AS jsonb))", new { actor, detail = JsonSerializer.Serialize(new { version, active_version = active, reason }, AiModelRegistry.Json) }, tx);
    }
    private static void MapControls(RouteGroupBuilder group, Platform platform)
    {
        var registry = platform.AiRegistry;
        group.MapGet("/catalog", async () =>
        {
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync("SELECT provider_id,model,metadata::text,present,synced_at FROM ai_model_catalog ORDER BY provider_id,model");
            return Json(rows.Select(r => new { provider_id = (Guid)r.provider_id, model = (string)r.model, metadata = JsonSerializer.Deserialize<JsonElement>((string)r.metadata), present = (bool)r.present, synced_at = (DateTimeOffset)r.synced_at }));
        });
        group.MapPost("/catalog/sync", async (HttpContext ctx, CancellationToken ct) =>
        {
            var results = await new AiCatalog(platform).Sync(ct: ct);
            return await Write(platform, Actor(ctx), "catalog.synced", (conn, tx) => Task.FromResult(results));
        });
        group.MapGet("/alerts", async (CancellationToken ct) => Json(await new AiCatalog(platform).Alerts(ct)));
        group.MapGet("/health", async () =>
        {
            await using var conn = await platform.Data.OpenConnectionAsync();
            var metrics = await conn.QueryAsync("SELECT role,provider_id,coalesce(served_model,model) AS model,count(*) AS calls,avg(CASE WHEN ok THEN 0.0 ELSE 1.0 END) AS error_rate,avg(CASE WHEN fallback_used THEN 1.0 ELSE 0.0 END) AS fallback_rate,percentile_cont(0.5) WITHIN GROUP(ORDER BY latency_ms) AS p50,percentile_cont(0.95) WITHIN GROUP(ORDER BY latency_ms) AS p95 FROM model_calls WHERE created_at>now()-interval '24 hours' GROUP BY role,provider_id,coalesce(served_model,model)");
            return Json(new { breakers = registry.Breakers.Health(), metrics = metrics.Select(Row), scope = "this API instance; latency and rates cover all instances over 24h" });
        });
        group.MapGet("/spend", async (int? page, int? page_size) =>
        {
            // Grouped by owner, owners paginated (busiest first); names come from users/bots, ids stay for copy.
            var size = Math.Clamp(page_size ?? 10, 1, 50);
            var at = Math.Max(page ?? 1, 1);
            await using var conn = await platform.Data.OpenConnectionAsync();
            const string month = "date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'";
            const string day = "date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'";
            var totals = await conn.QuerySingleAsync($"SELECT count(DISTINCT owner_id) AS owners,coalesce(sum(cost_usd) FILTER(WHERE created_at>={day}),0) AS today,coalesce(sum(cost_usd),0) AS month FROM model_calls WHERE created_at>={month}");
            var rows = (await conn.QueryAsync($@"WITH spend AS (SELECT owner_id,bot_id,coalesce(sum(cost_usd) FILTER(WHERE created_at>={day}),0) AS today,coalesce(sum(cost_usd),0) AS month FROM model_calls WHERE created_at>={month} GROUP BY owner_id,bot_id),
                owners AS (SELECT owner_id,sum(today) AS owner_today,sum(month) AS owner_month FROM spend GROUP BY owner_id ORDER BY sum(month) DESC,owner_id LIMIT @size OFFSET @offset)
                SELECT s.owner_id,s.bot_id,s.today,s.month,o.owner_today,o.owner_month,
                       coalesce(nullif(u.display_name,''),u.username) AS owner_name,u.username AS owner_username,b.name AS bot_name
                FROM spend s JOIN owners o ON o.owner_id=s.owner_id LEFT JOIN users u ON u.id=s.owner_id LEFT JOIN bots b ON b.id=s.bot_id
                ORDER BY o.owner_month DESC,s.owner_id,s.month DESC,s.bot_id", new { size, offset = (at - 1) * size })).Select(Row).ToList();
            var grouped = rows.GroupBy(r => r["owner_id"]?.ToString() ?? "").Select(g => new
            {
                owner_id = g.Key,
                owner_name = g.First()["owner_name"] as string,
                owner_username = g.First()["owner_username"] as string,
                today = g.First()["owner_today"],
                month = g.First()["owner_month"],
                bots = g.Select(r => new { bot_id = r["bot_id"]?.ToString(), bot_name = r["bot_name"] as string, today = r["today"], month = r["month"] }),
            });
            var active = (await registry.Snapshot()).Versions.FirstOrDefault(v => v.IsActive);
            return Json(new
            {
                spend = rows.Select(r => new Dictionary<string, object?> { ["owner_id"] = r["owner_id"], ["bot_id"] = r["bot_id"], ["owner_name"] = r["owner_name"], ["bot_name"] = r["bot_name"], ["today"] = r["today"], ["month"] = r["month"] }),
                owners = grouped,
                total = new { today = ((IDictionary<string, object>)totals)["today"], month = ((IDictionary<string, object>)totals)["month"] },
                page = at, page_size = size, total_owners = ((IDictionary<string, object>)totals)["owners"],
                caps = active?.Config.Budgets, plan = "default", currency = "USD", cache_seconds = 3,
            });
        });
        group.MapPut("/kill-switch", (HttpContext ctx, JsonElement body) => Write(platform, Actor(ctx), "kill_switch.updated", async (conn, tx) =>
        {
            var control = Read<AiKillSwitch>(body);
            Check(control.Mode is "off" or "stop" or "safe", "mode must be off, stop or safe");
            if (control.Mode == "safe")
            {
                Check(control.SafeModel != null, "safe_model required");
                var snapshot = await registry.Snapshot();
                var provider = snapshot.Providers.FirstOrDefault(p => p.Enabled && p.Id == control.SafeModel!.Provider);
                var model = provider?.Models.FirstOrDefault(m => m.Id == control.SafeModel!.Model);
                Check(model != null, "safe model must exist and be enabled");
                foreach (var v in snapshot.Versions.Where(v => v.IsActive || v.Version == snapshot.Rollout?.CandidateVersion))
                    foreach (var (name, role) in v.Config.Roles) Check(AiCapabilities.Reasons(name, role, provider!, model!).Count == 0, "safe model cannot serve every configured role or honor its privacy setting");
            }
            await conn.ExecuteAsync("UPDATE ai_config_state SET kill_switch=CAST(@json AS jsonb) WHERE id=1", new { json = JsonSerializer.Serialize(control, AiModelRegistry.Json) }, tx);
            return control;
        }));
        group.MapGet("/kill-switch", async () => Json((await registry.Snapshot()).KillSwitch ?? new()));
        group.MapGet("/evals", async () =>
        {
            await using var conn = await platform.Data.OpenConnectionAsync();
            return Json((await conn.QueryAsync("SELECT id,candidate_version,active_version,candidate_score,active_score,hard_pass,tolerance,created_at,details::text FROM ai_eval_runs ORDER BY id DESC LIMIT 100")).Select(Row));
        });
        group.MapPost("/versions/{v:int}/eval", async (HttpContext ctx, int v, CancellationToken ct) =>
        {
            var result = await new AiEvals(platform).Run(v, Actor(ctx), ct: ct);
            return await Write(platform, Actor(ctx), "eval.completed", (conn, tx) => Task.FromResult(result));
        });
        group.MapPost("/versions/{v:int}/publish", (HttpContext ctx, int v, JsonElement body) => Write(platform, Actor(ctx), "config.published", async (conn, tx) =>
        {
            var snapshot = await registry.Snapshot();
            var version = snapshot.Versions.FirstOrDefault(x => x.Version == v);
            Check(version != null, "version not found"); ValidateConfig(version!.Config with { Rollout = new() }, snapshot);
            await CheckEval(conn, tx, v, Actor(ctx), body, platform); await Activate(conn, tx, v);
            return new { version = v };
        }));
        group.MapGet("/providers/{id:guid}/keys", async (Guid id) =>
        {
            await using var conn = await platform.Data.OpenConnectionAsync();
            var active = await conn.QuerySingleOrDefaultAsync("SELECT (key_ciphertext IS NOT NULL) AS key_set,key_updated_at AS updated_at FROM ai_providers WHERE id=@id", new { id });
            if (active == null) return Results.NotFound();
            var slots = (await conn.QueryAsync("SELECT slot,true AS key_set,updated_at,tested_at FROM ai_provider_key_slots WHERE provider_id=@id ORDER BY slot", new { id })).Select(Row);
            return Json(new { active = Row(active), slots });
        });
        group.MapPut("/providers/{id:guid}/keys/next", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var key = body.GetProperty("key").GetString() ?? "";
            Check(key.Length is > 0 and <= 16384 && !key.Any(char.IsControl), "key is required and must be a single line");
            var bytes = Encoding.UTF8.GetBytes(key);
            try
            {
                var (cipher, nonce) = KeyEncryption.Encrypt(platform.MasterKey, id, Guid.Empty, "AI_PROVIDER", KeyEncryption.KeyVersion, bytes);
                return await Write(platform, Actor(ctx), "provider.next_key_uploaded", async (conn, tx) =>
                {
                    Check(await conn.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM ai_providers WHERE id=@id)", new { id }, tx), "provider not found");
                    await conn.ExecuteAsync("INSERT INTO ai_provider_key_slots(provider_id,slot,ciphertext,nonce,key_version) VALUES(@id,'next',@cipher,@nonce,@version) ON CONFLICT(provider_id,slot) DO UPDATE SET ciphertext=@cipher,nonce=@nonce,key_version=@version,updated_at=now(),tested_at=NULL", new { id, cipher, nonce, version = KeyEncryption.KeyVersion }, tx);
                    return new { id, slot = "next", key_set = true };
                });
            }
            finally { CryptographicOperations.ZeroMemory(bytes); key = ""; }
        });
        group.MapPost("/providers/{id:guid}/keys/{slot}/test", async (HttpContext ctx, Guid id, string slot, CancellationToken ct) =>
        {
            Check(slot is "active" or "next" or "previous", "invalid key slot");
            var provider = (await registry.Snapshot(ct)).Providers.FirstOrDefault(p => p.Id == id);
            Check(provider != null, "provider not found");
            // Hold the write lock through the short probe, so a concurrently uploaded key cannot inherit its test result.
            return await Write(platform, Actor(ctx), "provider.key_tested", async (conn, tx) =>
            {
                var result = await Test(provider!, slot == "active" ? await registry.Key(id, ct) : await registry.KeySlot(id, slot, ct), ct);
                if (result.Ok && slot != "active") await conn.ExecuteAsync("UPDATE ai_provider_key_slots SET tested_at=now() WHERE provider_id=@id AND slot=@slot", new { id, slot }, tx);
                return new { result.Ok, result.LatencyMs, result.Error, id, slot };
            });
        });
        group.MapPost("/providers/{id:guid}/keys/promote", (HttpContext ctx, Guid id) => Rotate(platform, Actor(ctx), id, "next"));
        group.MapPost("/providers/{id:guid}/keys/revert", (HttpContext ctx, Guid id) => Rotate(platform, Actor(ctx), id, "previous"));
    }
    private static Task<IResult> Rotate(Platform platform, Guid actor, Guid id, string source) => Write(platform, actor, "provider.key_" + (source == "next" ? "promoted" : "reverted"), async (conn, tx) =>
    {
        var next = await conn.QuerySingleOrDefaultAsync("SELECT ciphertext,nonce,key_version,tested_at FROM ai_provider_key_slots WHERE provider_id=@id AND slot=@source FOR UPDATE", new { id, source }, tx);
        Check(next != null && (source == "previous" || next.tested_at != null), "upload and successfully test the next key first (or no previous key exists)");
        // Swap atomically; the former active remains available for a quick revert.
        await conn.ExecuteAsync("INSERT INTO ai_provider_key_slots(provider_id,slot,ciphertext,nonce,key_version,tested_at) SELECT id,'previous',key_ciphertext,key_nonce,key_version,now() FROM ai_providers WHERE id=@id AND key_ciphertext IS NOT NULL ON CONFLICT(provider_id,slot) DO UPDATE SET ciphertext=excluded.ciphertext,nonce=excluded.nonce,key_version=excluded.key_version,updated_at=now(),tested_at=now()", new { id }, tx);
        await conn.ExecuteAsync("UPDATE ai_providers SET key_ciphertext=@cipher,key_nonce=@nonce,key_version=@version,key_updated_at=now(),updated_at=now() WHERE id=@id", new { id, cipher = (byte[])next!.ciphertext, nonce = (byte[])next.nonce, version = (int)next.key_version }, tx);
        if (source == "next") await conn.ExecuteAsync("DELETE FROM ai_provider_key_slots WHERE provider_id=@id AND slot='next'", new { id }, tx);
        return new { id, slot = "active", key_set = true };
    });
}
