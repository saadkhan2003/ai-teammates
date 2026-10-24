using System.Text.Json;
using Dapper;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;
using Teammates.Api;

namespace Teammates.UnitTests;

public class SpeedTelemetryTests
{
    [Theory]
    [InlineData("member", 403)] [InlineData("admin", 200)] [InlineData("owner", 200)] [InlineData(null, 403)]
    public void AdminSpeedRequiresStaff(string? role, int expected) => Assert.Equal(expected, ((IStatusCodeHttpResult)SpeedTelemetry.AdminGuard(role)).StatusCode);

    [Theory]
    [InlineData("echo_ms", -2, 0)] [InlineData("inp_ms", 700000, 600000)] [InlineData("cls", .2, .2)]
    public void RumWhitelistsAndClamps(string name, double value, double expected)
    {
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(new { events = new[] { new { name, value_ms = value } } }));
        Assert.True(RumValidation.TryEvents(doc.RootElement, Guid.NewGuid(), out var events));
        Assert.Equal(expected, Assert.Single(events).ValueMs);
    }
    [Theory]
    [InlineData("{}")]
    [InlineData("{\"events\":[{\"name\":\"server_ttft_ms\",\"value_ms\":1}]}")]
    [InlineData("{\"events\":[{\"name\":\"echo_ms\",\"value_ms\":\"private text\"}]}")]
    [InlineData("{\"events\":[null]}")]
    public void RumRejectsMalformedOrUnlistedMetrics(string json)
    {
        using var doc = JsonDocument.Parse(json);
        Assert.False(RumValidation.TryEvents(doc.RootElement, Guid.NewGuid(), out _));
    }
    [Fact]
    public void RumLimitsBatchAndStripsContentAndRawRoutes()
    {
        using var oversized = JsonDocument.Parse(JsonSerializer.Serialize(new { events = Enumerable.Repeat(new { name = "echo_ms", value_ms = 1 }, 51) }));
        Assert.False(RumValidation.TryEvents(oversized.RootElement, Guid.NewGuid(), out _));
        using var doc = JsonDocument.Parse("""{"events":[{"name":"echo_ms","value_ms":4,"route":"/bots/private-id?text=private","attrs":{"text":"private","prompt":"private","count":3,"cached":true,"duration":"private","nested":{"text":"private"}}}]}""");
        Assert.True(RumValidation.TryEvents(doc.RootElement, Guid.NewGuid(), out var events));
        var sample = Assert.Single(events);
        Assert.Null(sample.Route); Assert.DoesNotContain("private", sample.Attrs);
        using var attrs = JsonDocument.Parse(sample.Attrs);
        Assert.Equal(2, attrs.RootElement.EnumerateObject().Count());
        Assert.Equal("/bots/[id]", RumValidation.SafeRoute("/bots/[id]"));
    }
    [Theory]
    [InlineData("https://app.test", "same-origin", true)]
    [InlineData("https://evil.test", "cross-site", false)]
    [InlineData("null", "same-site", false)]
    public void RumChecksOrigin(string origin, string fetchSite, bool expected)
    {
        var ctx = new DefaultHttpContext(); ctx.Request.Host = new HostString("app.test");
        ctx.Request.Headers.Origin = origin; ctx.Request.Headers["Sec-Fetch-Site"] = fetchSite;
        Assert.Equal(expected, RumValidation.SameOrigin(ctx.Request));
    }
    [Fact]
    public void PercentilesInterpolateLikePostgresAndMissingIsNull()
    {
        Assert.Null(PerfRecorder.Percentile([], .5));
        Assert.Equal(25, PerfRecorder.Percentile([10, 20, 30, 40], .5));
        Assert.Equal(38.5, PerfRecorder.Percentile([10, 20, 30, 40], .95));
        Assert.Equal(15, SpeedTelemetry.Targets.Length);
        Assert.Equal(15, SpeedTelemetry.Targets.Select(t => t.Key).Distinct().Count());
        Assert.Contains("percentile_cont(0.95)", SpeedTelemetry.Query);
    }
    [Theory]
    [InlineData("""{"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":75,"cache_write_tokens":10}}}""", 100, 75, 10)]
    [InlineData("""{"usage":{"input_tokens":15,"output_tokens":5,"cache_read_input_tokens":75,"cache_creation_input_tokens":10}}""", 100, 75, 10)]
    [InlineData("""{"usage":{"prompt_tokens":100,"completion_tokens":5}}""", 100, null, null)]
    [InlineData("""{"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":null}}}""", 100, null, null)]
    public void ReadsProviderCacheUsage(string json, int prompt, int? cached, int? written)
    {
        using var doc = JsonDocument.Parse(json); var usage = ProviderWire.ReadUsage(doc.RootElement);
        Assert.Equal(prompt, usage.PromptTokens); Assert.Equal(cached, usage.CachedTokens); Assert.Equal(written, usage.CacheWriteTokens);
    }
    [Fact]
    public void RecorderDropsWithoutWaitingAndKeepsBoundedRouteRing()
    {
        using var data = NpgsqlDataSource.Create("Host=127.0.0.1;Database=unused");
        using var recorder = new PerfRecorder(data, NullLogger<PerfRecorder>.Instance);
        for (var i = 0; i < 5000; i++) recorder.Record("future_stage_ms", i);
        Assert.True(recorder.Dropped > 0);
        for (var i = 0; i < 500; i++) recorder.Api("/api/bots/{id}", i);
        Assert.Equal(256, recorder.RouteSnapshot("/api/bots/{id}").Count);
        var owner = Guid.NewGuid();
        for (var i = 0; i < 12; i++) Assert.True(recorder.AllowRum(owner));
        Assert.False(recorder.AllowRum(owner)); Assert.True(recorder.AllowRum(Guid.NewGuid()));
    }

    [PostgresFact]
    public async Task SpeedQueryComputesRealPercentilesWithMigrationAndModelSamples()
    {
        var db = "speed_" + Guid.NewGuid().ToString("N");
        var settings = new NpgsqlConnectionStringBuilder(Environment.GetEnvironmentVariable("TEST_PG_DSN")) { Database = "postgres" };
        await using var admin = new NpgsqlConnection(settings.ConnectionString); await admin.OpenAsync();
        await admin.ExecuteAsync($"CREATE DATABASE {db}");
        try
        {
            settings.Database = db; settings.Pooling = false;
            await using var conn = new NpgsqlConnection(settings.ConnectionString); await conn.OpenAsync();
            await conn.ExecuteAsync("CREATE TABLE model_calls(created_at timestamptz DEFAULT now(), prompt_tokens int, latency_ms int)");
            var root = FindRoot();
            await conn.ExecuteAsync(await File.ReadAllTextAsync(Path.Combine(root, "db/043_speed_telemetry.sql")));
            await conn.ExecuteAsync("INSERT INTO perf_events(source,name,value_ms) VALUES ('client','echo_ms',10),('client','echo_ms',20),('client','echo_ms',30),('client','echo_ms',40); INSERT INTO model_calls(ttft_ms,total_ms) VALUES(80,90)");
            var rows = (await conn.QueryAsync<SpeedTelemetry.SpeedRow>(SpeedTelemetry.Query, new { hours = 24 })).ToDictionary(r => r.Key);
            Assert.Equal(25, rows["echo_ms"].P50); Assert.Equal(38.5, rows["echo_ms"].P95);
            Assert.Equal(4, rows["echo_ms"].Count); Assert.Equal(80, rows["server_ttft_ms"].P50);
            Assert.Equal(90, rows["model_total_ms"].P95); Assert.False(rows.ContainsKey("inp_ms"));
        }
        finally { await admin.ExecuteAsync($"DROP DATABASE {db} WITH (FORCE)"); }
    }
    private static string FindRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, "db"))) dir = dir.Parent;
        return dir?.FullName ?? throw new InvalidOperationException("Repository root not found");
    }
}
