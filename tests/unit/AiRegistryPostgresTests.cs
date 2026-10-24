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
        _app = builder.Build(); AiAdmin.Map(_app, _platform); await _app.StartAsync();
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
        var p1 = await Request(HttpMethod.Post, "/providers", new { name = "A", kind = "mock", base_url = "http://mock/api/v1", enabled = true, models = new[] { new AiModel("one"), new AiModel("quick") } });
        var p2 = await Request(HttpMethod.Post, "/providers", new { name = "B", kind = "anthropic", base_url = "http://mock/anthropic", enabled = true, models = new[] { new AiModel("two") } });
        var a = p1.GetProperty("id").GetGuid(); var b = p2.GetProperty("id").GetGuid();
        await Request(HttpMethod.Put, $"/providers/{a}/key", new { key = "unit-only-provider-key" }, HttpStatusCode.NoContent);
        var meta = await Request(HttpMethod.Get, "");
        Assert.True(meta.GetProperty("providers")[0].GetProperty("key_set").GetBoolean());
        Assert.DoesNotContain("unit-only-provider-key", meta.GetRawText()); Assert.DoesNotContain("ciphertext", meta.GetRawText()); Assert.DoesNotContain("nonce", meta.GetRawText());
        await using var conn = await _data!.OpenConnectionAsync();
        var cipher = await conn.ExecuteScalarAsync<byte[]>("SELECT key_ciphertext FROM ai_providers WHERE id=@a", new { a });
        Assert.DoesNotContain("unit-only-provider-key", Encoding.UTF8.GetString(cipher!));
        var config = new AiConfig(new() { ["chat"] = new(new(a, "one"), [new(b, "two")]), ["quick"] = new(new(a, "quick")), ["vision"] = new(new(b, "two")), ["coding"] = new(new(a, "one")) });
        await Request(HttpMethod.Put, "/config", new { config, note = "initial" });
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
            await Request(HttpMethod.Put, "/rollout", new AiRollout(2, 100));
            Assert.Equal(b, (await registry.Resolve("chat", user, task)).Primary.ProviderId);
            for (var i = 0; i < 50 && (await remote.Resolve("chat", user, task)).ConfigVersion != 2; i++) await Task.Delay(20);
            Assert.Equal(2, (await remote.Resolve("chat", user, task)).ConfigVersion);
            var rollback = await Request(HttpMethod.Post, "/versions/1/rollback");
            Assert.Equal(3, rollback.GetProperty("version").GetInt32()); Assert.Equal(a, (await registry.Resolve("chat", user, task)).Primary.ProviderId);
            var history = await Request(HttpMethod.Get, "/versions"); Assert.Equal(3, history.GetArrayLength()); Assert.Single(history.EnumerateArray(), v => v.GetProperty("is_active").GetBoolean());
            var log = await Request(HttpMethod.Get, "/audit"); Assert.Contains(log.EnumerateArray(), e => e.GetProperty("action").GetString() == "config.rollback"); Assert.DoesNotContain("unit-only-provider-key", log.GetRawText());
        }
        finally { await remote.StopAsync(default); remote.Dispose(); }
    }
}
