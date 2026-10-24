using System.Net;
using System.Security.Cryptography;
using Dapper;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;
using Teammates.Api;
using Teammates.Compute;
using Teammates.Compute.Testing;

namespace Teammates.UnitTests;

public class ComputerPrewarmEndpointTests
{
    [PostgresFact]
    public async Task EndpointEnforcesAuthPolicyQuotasAndRateLimitAndReturnsBeforeWakeCompletes()
    {
        var dsn = Environment.GetEnvironmentVariable("TEST_PG_DSN");
        var db = "prewarm_" + Guid.NewGuid().ToString("N");
        await using var admin = new NpgsqlConnection(dsn); await admin.OpenAsync();
        await admin.ExecuteAsync($"CREATE DATABASE {db}");
        try
        {
            await using var data = NpgsqlDataSource.Create(new NpgsqlConnectionStringBuilder(dsn) { Database = db, Pooling = false }.ConnectionString);
            await using var conn = await data.OpenConnectionAsync();
            foreach (var file in Directory.GetFiles(Path.Combine(MigrationManifestTests.Root(), "db"), "*.sql").OrderBy(Path.GetFileName, StringComparer.Ordinal)) await conn.ExecuteAsync(await File.ReadAllTextAsync(file));
            await using var engine = new MockDockerEngine();
            var desktop = new MockDockerEngine.DesktopHandler();
            await using var compute = new DockerComputeProvider(new DockerComputeOptions { NetworkName = "prewarm-computers", Stack = "prewarm", ReadinessDeadline = TimeSpan.FromSeconds(5) },
                new MockDockerEngine.NoSecrets(), new MockDockerEngine.NoSnapshots(), computerHttpHandler: desktop, dockerClient: engine.Client);
            var platform = new Teammates.Api.Platform(data, RandomNumberGenerator.GetBytes(32), compute, null!, new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["LLM_PROVIDER"] = "mock" }).Build());
            var owner = await conn.ExecuteScalarAsync<Guid>("INSERT INTO users(username,password_hash,role) VALUES('wake-owner','unused','owner') RETURNING id");
            var other = await conn.ExecuteScalarAsync<Guid>("INSERT INTO users(username,password_hash,role) VALUES('other-owner','unused','owner') RETURNING id");
            await conn.ExecuteAsync("INSERT INTO user_quotas(user_id,max_computers) VALUES(@owner,1)", new { owner });
            var bot = Guid.NewGuid(); var absentBot = Guid.NewGuid();
            await conn.ExecuteAsync("INSERT INTO bots(id,owner_id,name,role,instructions,token_hash) VALUES(@bot,@owner,'Wake','test','','unused'),(@absentBot,@owner,'Absent','test','','unused')", new { bot, absentBot, owner });
            var id = new ComputerId(bot.ToString());
            using var recorder = new PerfRecorder(data, NullLogger<PerfRecorder>.Instance);
            compute.RecordPerformance = recorder.Record;
            await compute.CreateComputerAsync(new(id, "local", owner.ToString(), "test", IsolationClass.Docker, new(0, 0, 0, 256), "", new Dictionary<string, string>()), new("create"), CancellationToken.None);
            var service = new ComputerPrewarmService(platform, NullLogger<ComputerPrewarmService>.Instance);
            var builder = WebApplication.CreateBuilder(); builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
            builder.Services.AddSingleton(service);
            builder.Services.AddSingleton(recorder);
            await using var app = builder.Build();
            ComputerPrewarmService.Map(app); SpeedTelemetry.Map(app, platform); await app.StartAsync();
            await service.StartAsync(CancellationToken.None); await recorder.StartAsync(CancellationToken.None);
            try
            {
                using var http = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
                var path = $"/api/bots/{bot}/computer/prewarm";
                using var anonymous = await http.PostAsync(path, null); Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);
                http.DefaultRequestHeaders.Add("Cookie", "teammates_session=" + await platform.CreateSession(other));
                using var forbidden = await http.PostAsync(path, null); Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);
                http.DefaultRequestHeaders.Remove("Cookie"); http.DefaultRequestHeaders.Add("Cookie", "teammates_session=" + await platform.CreateSession(owner));
                http.DefaultRequestHeaders.Add("Origin", "https://wrong.invalid");
                using var crossSite = await http.PostAsync(path, null); Assert.Equal(HttpStatusCode.Forbidden, crossSite.StatusCode);
                http.DefaultRequestHeaders.Remove("Origin");
                await conn.ExecuteAsync("UPDATE user_quotas SET max_computers=0 WHERE user_id=@owner", new { owner });
                using var quota = await http.PostAsync(path, null); Assert.Equal(HttpStatusCode.Forbidden, quota.StatusCode);
                await conn.ExecuteAsync("UPDATE user_quotas SET max_computers=1 WHERE user_id=@owner", new { owner });
                await conn.ExecuteAsync("INSERT INTO user_policies(user_id,settings) VALUES(@owner, '{\"classes\":{\"write\":\"DENY\"}}')", new { owner });
                using var denied = await http.PostAsync(path, null); Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
                await conn.ExecuteAsync("DELETE FROM user_policies WHERE user_id=@owner", new { owner });
                using var absent = await http.PostAsync($"/api/bots/{absentBot}/computer/prewarm", null); Assert.Equal(HttpStatusCode.NoContent, absent.StatusCode);
                Assert.Single(engine.Containers);
                desktop.Block = new(TaskCreationOptions.RunContinuationsAsynchronously);
                Assert.Single(engine.Containers.Values).Paused = true;
                using var accepted = await http.PostAsync(path, null); Assert.Equal(HttpStatusCode.Accepted, accepted.StatusCode);
                await desktop.Entered.Task.WaitAsync(TimeSpan.FromSeconds(3));
                Assert.False(compute.IsComputerReady(id));
                using var duplicate = await http.PostAsync(path, null); Assert.Equal(HttpStatusCode.TooManyRequests, duplicate.StatusCode);
                Assert.Equal("30", duplicate.Headers.RetryAfter?.Delta?.TotalSeconds.ToString());
                desktop.Block.TrySetResult();
                using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(6));
                while (await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM perf_events WHERE name='wake_paused_ms'") == 0) await Task.Delay(50, deadline.Token);
                Assert.True(compute.IsComputerReady(id));
                Assert.Equal(1, await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM audit_events WHERE action='computer.prewarm'"));
                var stages = (await conn.QueryAsync<string>("SELECT name FROM perf_events")).ToArray();
                Assert.Contains("computer_create_ms", stages); Assert.Contains("computer_unpause_ms", stages);
                Assert.Contains("computer_chrome_healthy_ms", stages); Assert.Contains("computer_ready_ms", stages);
                Assert.Equal("unpause", await conn.ExecuteScalarAsync<string>("SELECT attrs->>'path' FROM perf_events WHERE name='wake_paused_ms'"));
                var report = (await conn.QueryAsync<SpeedTelemetry.SpeedRow>(SpeedTelemetry.Query, new { hours = 24 })).ToDictionary(x => x.Key);
                Assert.Equal(1, report["wake_paused_ms"].Count);
                using var speed = await http.GetAsync("/api/admin/speed"); Assert.Equal(HttpStatusCode.OK, speed.StatusCode);
            }
            finally
            {
                desktop.Block?.TrySetResult();
                await service.StopAsync(CancellationToken.None); service.Dispose();
                await recorder.StopAsync(CancellationToken.None);
            }
        }
        finally { await admin.ExecuteAsync($"DROP DATABASE {db} WITH (FORCE)"); }
    }
}
