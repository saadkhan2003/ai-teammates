using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Npgsql;
using Teammates.Api;
using ApiPlatform = Teammates.Api.Platform;

namespace Teammates.UnitTests;

public sealed class AiRegistryPostgresTests : IAsyncLifetime
{
    private NpgsqlDataSource? _data;
    private string? _db;
    private ApiPlatform? _platform;
    private WebApplication? _app;
    private HttpClient? _http;
    private Guid _owner;
    private Guid _member;
    private string? _memberSession;
    public async Task InitializeAsync()
    {
        var dsn = Environment.GetEnvironmentVariable("TEST_PG_DSN");
        if (string.IsNullOrEmpty(dsn)) return;
        _db = "ai_test_" + Guid.NewGuid().ToString("N");
        await using (var admin = new NpgsqlConnection(dsn)) { await admin.OpenAsync(); await admin.ExecuteAsync($"CREATE DATABASE {_db}"); }
        _data = NpgsqlDataSource.Create(new NpgsqlConnectionStringBuilder(dsn) { Database = _db }.ConnectionString);
        await using var conn = await _data.OpenConnectionAsync();
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root != null && !File.Exists(Path.Combine(root.FullName, "README.md"))) root = root.Parent;
        foreach (var file in Directory.GetFiles(Path.Combine(root!.FullName, "db"), "*.sql").OrderBy(Path.GetFileName, StringComparer.Ordinal)) await conn.ExecuteAsync(await File.ReadAllTextAsync(file));
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["LLM_PROVIDER"] = "mock", ["MODEL_PLANNER"] = "legacy/planner", ["OPENROUTER_BASE_URL"] = "http://bootstrap.invalid/api/v1" }).Build();
        _platform = new(_data, RandomNumberGenerator.GetBytes(32), null!, null!, configuration);
        _owner = await conn.ExecuteScalarAsync<Guid>("INSERT INTO users(username,password_hash,role) VALUES('owner','unused','owner') RETURNING id");
        _member = await conn.ExecuteScalarAsync<Guid>("INSERT INTO users(username,password_hash,role) VALUES('member','unused','member') RETURNING id");
        var ownerSession = await _platform.CreateSession(_owner);
        _memberSession = await _platform.CreateSession(_member);
        var builder = WebApplication.CreateBuilder(); builder.WebHost.UseUrls("http://127.0.0.1:0"); builder.Logging.ClearProviders();
        _app = builder.Build(); AiAdmin.Map(_app, _platform);
        _app.MapGet("/stub/models", () => new { data = new[] { new { id = "one" } } });
        await _app.StartAsync();
        _http = new() { BaseAddress = new Uri(_app.Urls.Single()) };
        _http.DefaultRequestHeaders.Add("Cookie", "teammates_session=" + ownerSession);
    }
    public async Task DisposeAsync()
    {
        _http?.Dispose();
        if (_app != null) await _app.DisposeAsync();
        if (_data != null) await _data.DisposeAsync();
        if (_db != null) { await using var admin = new NpgsqlConnection(Environment.GetEnvironmentVariable("TEST_PG_DSN")); await admin.OpenAsync(); await admin.ExecuteAsync($"DROP DATABASE {_db} WITH (FORCE)"); }
    }
    private async Task<JsonElement> Request(HttpMethod method, string path, object? body = null, HttpStatusCode expected = HttpStatusCode.OK)
    {
        using var request = new HttpRequestMessage(method, "/api/admin/ai" + path) { Content = body == null ? null : JsonContent.Create(body, options: AiModelRegistry.Json) };
        using var response = await _http!.SendAsync(request);
        Assert.Equal(expected, response.StatusCode);
        return response.StatusCode == HttpStatusCode.NoContent ? default : JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();
    }

    [PostgresFact]
    public async Task Bootstrap_admin_guard_encrypted_keys_versions_roles_rollout_and_invalidation()
    {
        var registry = _platform!.AiRegistry;
        var user = _owner; var task = Guid.NewGuid();
        var bootstrap = await registry.Resolve("chat", user, task);
        Assert.Equal(0, bootstrap.ConfigVersion); Assert.Equal("mock", bootstrap.Primary.Kind); Assert.Equal("legacy/planner", bootstrap.Primary.Model); Assert.Equal("http://bootstrap.invalid/api/v1", bootstrap.Primary.BaseUrl);
        Assert.Null(await bootstrap.Primary.Key(default)); // Legacy missing-key behavior.
        await _platform.InsertSecret(_owner, "openrouter", "default", "API_KEY", "sk-or-bootstrap-unit-test-only", "", ["model_gateway"], [], null, "valid", null);
        Assert.Equal("sk-or-bootstrap-unit-test-only", Encoding.UTF8.GetString((await bootstrap.Primary.Key(default))!));
        using (var memberRequest = new HttpRequestMessage(HttpMethod.Get, "/api/admin/ai"))
        {
            memberRequest.Headers.Add("Cookie", "teammates_session=" + _memberSession);
            using var guest = new HttpClient { BaseAddress = _http!.BaseAddress };
            Assert.Equal(HttpStatusCode.Forbidden, (await guest.SendAsync(memberRequest)).StatusCode);
        }
        foreach (var (method, path, body) in new (HttpMethod, string, object?)[] { (HttpMethod.Post, "/providers", new { }), (HttpMethod.Put, "/config", new { }), (HttpMethod.Get, "/versions", null), (HttpMethod.Get, "/audit", null), (HttpMethod.Post, "/rollout/promote", null) })
        {
            using var guest = new HttpClient { BaseAddress = _http!.BaseAddress };
            using var request = new HttpRequestMessage(method, "/api/admin/ai" + path) { Content = body == null ? null : JsonContent.Create(body) };
            request.Headers.Add("Cookie", "teammates_session=" + _memberSession);
            Assert.Equal(HttpStatusCode.Forbidden, (await guest.SendAsync(request)).StatusCode);
        }
        var p1 = await Request(HttpMethod.Post, "/providers", new { name = "A", kind = "mock", base_url = "http://mock/api/v1", enabled = true, models = new[] { new AiModel("one", Tools: true), new AiModel("quick", Tools: true) } });
        var p2 = await Request(HttpMethod.Post, "/providers", new { name = "B", kind = "anthropic", base_url = "http://mock/anthropic", enabled = true, models = new[] { new AiModel("two", Tools: true, Vision: true) } });
        var a = p1.GetProperty("id").GetGuid(); var b = p2.GetProperty("id").GetGuid();
        await Request(HttpMethod.Put, $"/providers/{a}/key", new { key = "unit-only-provider-key" }, HttpStatusCode.NoContent);
        var meta = await Request(HttpMethod.Get, "");
        Assert.True(meta.GetProperty("providers")[0].GetProperty("key_set").GetBoolean());
        Assert.DoesNotContain("unit-only-provider-key", meta.GetRawText()); Assert.DoesNotContain("ciphertext", meta.GetRawText()); Assert.DoesNotContain("nonce", meta.GetRawText());
        await using var conn = await _data!.OpenConnectionAsync();
        var cipher = await conn.ExecuteScalarAsync<byte[]>("SELECT key_ciphertext FROM ai_providers WHERE id=@a", new { a });
        Assert.DoesNotContain("unit-only-provider-key", Encoding.UTF8.GetString(cipher!));
        var config = new AiConfig(new() { ["chat"] = new(new(a, "one"), [new(b, "two")]), ["quick"] = new(new(a, "quick")), ["vision"] = new(new(b, "two")), ["coding"] = new(new(a, "one")) });
        await Request(HttpMethod.Put, "/config", new { config, note = "initial", as_candidate = true });
        await Request(HttpMethod.Post, "/versions/1/publish", new { override_reason = "Unit fixture explicit owner approval" });
        var resolved = await registry.Resolve("chat", user, task);
        Assert.Equal(1, resolved.ConfigVersion); Assert.Equal(a, resolved.Primary.ProviderId); Assert.Single(resolved.Fallbacks);
        Assert.Equal("quick", (await registry.Resolve("compactor", user, task)).Primary.Model);
        Assert.Equal(b, (await registry.Resolve("vision", user, task)).Primary.ProviderId);
        Assert.Equal("one", (await registry.Resolve("coding", user, task)).Primary.Model);
        Assert.Equal(resolved.Primary.Model, (await registry.Resolve("chat", user, task)).Primary.Model);
        await Request(HttpMethod.Delete, $"/providers/{a}", expected: HttpStatusCode.BadRequest);
        await Request(HttpMethod.Put, "/config", new { config = config with { Roles = [] } }, HttpStatusCode.BadRequest);
        // A second instance listens to the same channel; notify invalidates without waiting for its safety poll.
        var remote = new AiModelRegistry(_platform); await remote.StartAsync(default);
        try
        {
            Assert.Equal(1, (await remote.Resolve("chat", user, task)).ConfigVersion);
            await Task.Delay(200);
            var candidate = config with { Roles = new() { ["chat"] = new(new(b, "two")) } };
            await Request(HttpMethod.Put, "/config", new { config = candidate, note = "candidate", as_candidate = true });
            await Request(HttpMethod.Put, "/rollout", new AiRollout(2, 0));
            Assert.Equal(a, (await registry.Resolve("chat", user, task)).Primary.ProviderId);
            await Request(HttpMethod.Put, "/rollout", new { candidate_version = 2, percent = 100, override_reason = "Unit fixture explicit owner approval" });
            Assert.Equal(b, (await registry.Resolve("chat", user, task)).Primary.ProviderId);
            for (var i = 0; i < 50 && (await remote.Resolve("chat", user, task)).ConfigVersion != 2; i++) await Task.Delay(20);
            Assert.Equal(2, (await remote.Resolve("chat", user, task)).ConfigVersion);
            var rollback = await Request(HttpMethod.Post, "/versions/1/rollback");
            Assert.Equal(1, rollback.GetProperty("version").GetInt32()); Assert.Equal(a, (await registry.Resolve("chat", user, task)).Primary.ProviderId);
            var history = await Request(HttpMethod.Get, "/versions"); Assert.Equal(2, history.GetArrayLength()); Assert.Single(history.EnumerateArray(), v => v.GetProperty("is_active").GetBoolean());
            var log = await Request(HttpMethod.Get, "/audit"); Assert.Contains(log.EnumerateArray(), e => e.GetProperty("action").GetString() == "config.rollback"); Assert.DoesNotContain("unit-only-provider-key", log.GetRawText());
        }
        finally { await remote.StopAsync(default); remote.Dispose(); }
    }
    private async Task<(Guid Provider, AiConfig Config)> Install()
    {
        var created = await Request(HttpMethod.Post, "/providers", new { name = "fixture", kind = "mock", base_url = _http!.BaseAddress + "stub", enabled = true, models = new[] { new AiModel("one", Tools: true, Vision: true, ContextTokens: 10000), new AiModel("two", Tools: true, Vision: true) } });
        var id = created.GetProperty("id").GetGuid();
        await Request(HttpMethod.Put, $"/providers/{id}/key", new { key = "fixture-active-key-only" }, HttpStatusCode.NoContent);
        var config = new AiConfig(new() { ["chat"] = new(new(id, "one")) });
        await Request(HttpMethod.Put, "/config", new { config, as_candidate = true });
        await Request(HttpMethod.Post, "/versions/1/publish", new { override_reason = "Explicit fixture bootstrap approval" });
        return (id, config);
    }

    [PostgresFact]
    public async Task Versions_are_immutable_eval_gate_blocks_bypass_and_rollback_moves_pointer()
    {
        var (provider, config) = await Install();
        await using var conn = await _data!.OpenConnectionAsync();
        var original = await conn.ExecuteScalarAsync<string>("SELECT config::text FROM ai_config_versions WHERE version=1");
        var originalApi = (await Request(HttpMethod.Get, "/versions"))[0].GetProperty("config").GetRawText();
        await Request(HttpMethod.Put, "/config", new { config, as_candidate = true });
        await Request(HttpMethod.Post, "/versions/2/publish", new { }, HttpStatusCode.BadRequest);
        await Request(HttpMethod.Post, "/versions/2/rollback", expected: HttpStatusCode.BadRequest);
        await Request(HttpMethod.Put, "/rollout", new { candidate_version = 2, percent = 100 }, HttpStatusCode.BadRequest);
        await Assert.ThrowsAsync<PostgresException>(() => conn.ExecuteAsync("UPDATE ai_config_versions SET config='{}' WHERE version=1"));
        await Assert.ThrowsAsync<PostgresException>(() => conn.ExecuteAsync("DELETE FROM ai_config_versions WHERE version=2"));
        await Request(HttpMethod.Put, "/rollout", new { candidate_version = 2, percent = 0 });
        var apiHistory = await Request(HttpMethod.Get, "/versions");
        Assert.Equal(originalApi, apiHistory.EnumerateArray().Single(v => v.GetProperty("version").GetInt32() == 1).GetProperty("config").GetRawText());
        Assert.Equal(original, await conn.ExecuteScalarAsync<string>("SELECT config::text FROM ai_config_versions WHERE version=1"));
        await conn.ExecuteAsync("INSERT INTO ai_eval_runs(candidate_version,active_version,candidate_score,active_score,hard_pass,details) VALUES(2,1,0.1,1,false,'{}')");
        await Request(HttpMethod.Post, "/versions/2/publish", new { }, HttpStatusCode.BadRequest);
        await Request(HttpMethod.Post, "/versions/2/publish", new { override_reason = "Owner accepts the documented regression" });
        Assert.Equal(2, (await _platform!.AiRegistry.Resolve("chat", _owner, Guid.Empty)).ConfigVersion);
        await Request(HttpMethod.Post, "/versions/1/rollback");
        Assert.Equal(1, await conn.ExecuteScalarAsync<int>("SELECT active_version FROM ai_config_state"));
        Assert.Equal(2, await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM ai_config_versions"));
        Assert.Equal(original, await conn.ExecuteScalarAsync<string>("SELECT config::text FROM ai_config_versions WHERE version=1"));
        var audit = await Request(HttpMethod.Get, "/audit");
        Assert.Contains("before", audit.GetRawText()); Assert.Contains("after", audit.GetRawText()); Assert.Contains("eval.owner_override", audit.GetRawText());
        Assert.DoesNotContain("fixture-active-key-only", audit.GetRawText());
    }

    [PostgresFact]
    public async Task Next_key_is_tested_promoted_reverted_and_never_serialized()
    {
        var (id, _) = await Install(); var registry = _platform!.AiRegistry;
        await Request(HttpMethod.Put, $"/providers/{id}/keys/next", new { key = "fixture-next-key-only" });
        await Request(HttpMethod.Post, $"/providers/{id}/keys/promote", expected: HttpStatusCode.BadRequest);
        var tested = await Request(HttpMethod.Post, $"/providers/{id}/keys/next/test"); Assert.True(tested.GetProperty("ok").GetBoolean());
        await Request(HttpMethod.Post, $"/providers/{id}/keys/promote");
        Assert.Equal("fixture-next-key-only", Encoding.UTF8.GetString((await registry.Key(id))!)); Assert.Null(await registry.KeySlot(id, "next"));
        Assert.Equal("fixture-active-key-only", Encoding.UTF8.GetString((await registry.KeySlot(id, "previous"))!));
        var meta = await Request(HttpMethod.Get, $"/providers/{id}/keys");
        Assert.DoesNotContain("fixture-", meta.GetRawText()); Assert.DoesNotContain("last4", meta.GetRawText()); Assert.Contains("updated_at", meta.GetRawText());
        await Request(HttpMethod.Post, $"/providers/{id}/keys/revert");
        Assert.Equal("fixture-active-key-only", Encoding.UTF8.GetString((await registry.Key(id))!));
        Assert.Equal("fixture-next-key-only", Encoding.UTF8.GetString((await registry.KeySlot(id, "previous"))!));
    }

    [PostgresFact]
    public async Task Mock_backed_catalog_alert_and_golden_evaluation_allow_publish()
    {
        var (id, config) = await Install();
        await Request(HttpMethod.Put, "/config", new { config, as_candidate = true });
        using var http = new HttpClient(new EvalHandler());
        var result = JsonSerializer.SerializeToElement(await new AiEvals(_platform!).Run(2, _owner, http), AiModelRegistry.Json);
        Assert.True(result.GetProperty("passed").GetBoolean()); Assert.True(result.GetProperty("hard_pass").GetBoolean());
        await Request(HttpMethod.Post, "/versions/2/publish", new { });
        await new AiCatalog(_platform!).Sync(http);
        var catalog = await Request(HttpMethod.Get, "/catalog"); Assert.Single(catalog.EnumerateArray());
        var alerts = await Request(HttpMethod.Get, "/alerts"); Assert.Contains("scheduled_expiration", alerts.GetRawText());
        var resolution = await _platform!.AiRegistry.Resolve("chat", _owner, Guid.Empty); Assert.Equal(128, resolution.Primary.MaxCompletionTokens);
        await using var conn = await _data!.OpenConnectionAsync(); await conn.ExecuteAsync("UPDATE ai_model_catalog SET present=false"); _platform.AiRegistry.Invalidate();
        Assert.Contains("missing_from_catalog", (await Request(HttpMethod.Get, "/alerts")).GetRawText());
    }

    [PostgresFact]
    public async Task Spend_cache_observes_stored_cost_and_kill_switch_invalidates_next_resolution()
    {
        var (id, config) = await Install();
        var capped = config with { Budgets = new(Plans: new() { ["default"] = new(1, 10) }) };
        await Request(HttpMethod.Put, "/config", new { config = capped, as_candidate = true });
        await Request(HttpMethod.Post, "/versions/2/publish", new { override_reason = "Explicit cap fixture configuration" });
        var registry = _platform!.AiRegistry;
        var resolution = await registry.Resolve("chat", _owner, Guid.Empty);
        Assert.False((await resolution.CheckSpend!(default)).Blocked);
        await using var conn = await _data!.OpenConnectionAsync();
        await conn.ExecuteAsync("INSERT INTO model_calls(owner_id,role,provider,model,latency_ms,cost_usd) VALUES(@owner,'chat','mock','one',1,1)", new { owner = _owner });
        registry.RecordSpend(_owner, Guid.Empty, 1);
        Assert.True((await resolution.CheckSpend!(default)).Blocked);
        await Request(HttpMethod.Put, "/kill-switch", new AiKillSwitch("stop"));
        Assert.Equal("stop", (await registry.Resolve("chat", _owner, Guid.Empty)).KillSwitch!.Mode);
        await Request(HttpMethod.Put, "/kill-switch", new AiKillSwitch("safe", new(id, "one")));
        Assert.Equal("safe", (await registry.Resolve("coding", _owner, Guid.Empty)).KillSwitch!.Mode);
        await Request(HttpMethod.Put, "/kill-switch", new AiKillSwitch("off"));
    }

    [PostgresFact]
    public async Task Rollback_clears_old_cohorts_and_waiters_preserve_budget_pauses_and_fence_leases()
    {
        var (id, config) = await Install();
        var registry = _platform!.AiRegistry;
        var candidate = config with { Roles = new() { ["chat"] = new(new(id, "two")) } };
        await Request(HttpMethod.Put, "/config", new { config = candidate, as_candidate = true });
        await Request(HttpMethod.Put, "/rollout", new { candidate_version = 2, percent = 100, override_reason = "Explicit cohort fixture evaluation approval" });
        await using var conn = await _data!.OpenConnectionAsync();
        var bot = await conn.ExecuteScalarAsync<Guid>("INSERT INTO bots(owner_id,name,token_hash) VALUES(@owner,'private fixture','unused') RETURNING id", new { owner = _owner });
        var task = await conn.ExecuteScalarAsync<Guid>("INSERT INTO tasks(bot_id,title,instruction,status,waiting_reason,lease_epoch) VALUES(@bot,'wait','wait','waiting_resource','Model requests are temporarily paused.',3) RETURNING id", new { bot });
        var budgetTask = await conn.ExecuteScalarAsync<Guid>("INSERT INTO tasks(bot_id,title,instruction,status,waiting_reason,lease_epoch) VALUES(@bot,'budget','budget','waiting_human','budget_reached',5) RETURNING id", new { bot });
        Assert.Equal(2, (await registry.Resolve("chat", _owner, task, bot)).ConfigVersion);
        await Request(HttpMethod.Put, "/rollout", new AiRollout(2, 0));
        Assert.Equal(2, (await registry.Resolve("chat", _owner, task, bot)).ConfigVersion);
        await Request(HttpMethod.Post, "/versions/1/rollback");
        Assert.Equal(1, (await registry.Resolve("chat", _owner, task, bot)).ConfigVersion);
        await Request(HttpMethod.Put, "/kill-switch", new AiKillSwitch("stop"));
        Assert.Equal(0, await AiWaiters.ResumeReady(_platform));
        await Request(HttpMethod.Put, "/kill-switch", new AiKillSwitch("off"));
        Assert.Equal(1, await AiWaiters.ResumeReady(_platform));
        var resumed = await conn.QuerySingleAsync<(string Status, int Epoch)>("SELECT status,lease_epoch FROM tasks WHERE id=@task", new { task });
        Assert.Equal("queued", resumed.Status); Assert.Equal(4, resumed.Epoch);
        var budget = await conn.QuerySingleAsync<(string Status, string Reason, int Epoch)>("SELECT status,waiting_reason,lease_epoch FROM tasks WHERE id=@budgetTask", new { budgetTask });
        Assert.Equal("waiting_human", budget.Status); Assert.Equal("budget_reached", budget.Reason); Assert.Equal(5, budget.Epoch);
        Assert.Equal(1, await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM task_run_events WHERE task_id=@task AND type='resource_resumed'", new { task }));
    }
    private sealed class EvalHandler : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (request.Method == HttpMethod.Get) return new(HttpStatusCode.OK) { Content = new StringContent("""{"data":[{"id":"one","supported_parameters":["tools"],"context_length":10000,"top_provider":{"max_completion_tokens":128},"expiration_date":"2027-01-01"}]}""") };
            var payload = await request.Content!.ReadAsStringAsync(ct);
            var answer = payload.Contains("AI_GOLDEN_JUDGE") ? "{\"score\":1}" : payload.Contains("arithmetic") ? "4" : payload.Contains("structured") ? "{\"ok\":true}" : "I cannot share private information.";
            return new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(new { model = "one", choices = new[] { new { message = new { content = answer } } }, usage = new { prompt_tokens = 5, completion_tokens = 2, cost = 0.000001 } })) };
        }
    }

}
