using Dapper;
using Microsoft.Extensions.Configuration;
using Npgsql;
using Teammates.Compute;

namespace Teammates.UnitTests;

// A stopped computer whose container disappears must never be rebuilt as running
// unless its owner or one of their bots asks for it again.
public sealed class ComputerRecoveryTests : IAsyncLifetime
{
    private string? _database; private NpgsqlDataSource? _data;

    public async Task InitializeAsync()
    {
        var dsn = Environment.GetEnvironmentVariable("TEST_PG_DSN"); if (string.IsNullOrWhiteSpace(dsn)) return;
        _database = "recovery_test_" + Guid.NewGuid().ToString("N");
        await using (var admin = new NpgsqlConnection(new NpgsqlConnectionStringBuilder(dsn) { Database = "postgres" }.ConnectionString))
        { await admin.OpenAsync(); await admin.ExecuteAsync($"CREATE DATABASE {_database}"); }
        _data = NpgsqlDataSource.Create(new NpgsqlConnectionStringBuilder(dsn) { Database = _database, MaxPoolSize = 5 }.ConnectionString);
        await using var c = await _data.OpenConnectionAsync();
        foreach (var file in Teammates.Api.Platform.MigrationFiles) await c.ExecuteAsync(await File.ReadAllTextAsync(Path.Combine(MigrationManifestTests.Root(), "db", file)));
    }

    public async Task DisposeAsync()
    {
        if (_data is not null) await _data.DisposeAsync();
        if (_database is null) return;
        var dsn = new NpgsqlConnectionStringBuilder(Environment.GetEnvironmentVariable("TEST_PG_DSN")) { Database = "postgres" };
        await using var c = new NpgsqlConnection(dsn.ConnectionString); await c.OpenAsync(); await c.ExecuteAsync($"DROP DATABASE IF EXISTS {_database} WITH (FORCE)");
    }

    private async Task<(Guid User, Guid Computer)> Seed(NpgsqlConnection c, string status)
    {
        var user = await c.ExecuteScalarAsync<Guid>("INSERT INTO users(username,password_hash) VALUES(@name,'unused') RETURNING id", new { name = "rec-" + Guid.NewGuid().ToString("N")[..8] });
        var computer = Guid.NewGuid();
        await c.ExecuteAsync("INSERT INTO user_computers(user_id, computer_id, desktop_bot_id, status) VALUES(@user, @computer, @computer, @status)", new { user, computer, status });
        return (user, computer);
    }

    private static Task<string> Status(NpgsqlConnection c, Guid computer) =>
        c.ExecuteScalarAsync<string>("SELECT status FROM user_computers WHERE computer_id=@computer", new { computer })!;

    [Fact]
    public async Task Missing_stopped_computer_is_not_restored()
    {
        if (_data is null) return;
        await using var c = await _data.OpenConnectionAsync();
        var (_, computer) = await Seed(c, "stopped");
        // Compute is deliberately null: touching it would mean a restore was attempted.
        var platform = new Teammates.Api.Platform(_data, new byte[32], null!, null!, new ConfigurationBuilder().Build());
        Assert.False(await platform.BeginComputerRecovery(new ComputerId(computer.ToString()), CancellationToken.None));
        Assert.Equal("stopped", await Status(c, computer));
    }

    [Fact]
    public async Task Only_wanted_computers_are_claimed_for_recovery()
    {
        if (_data is null) return;
        await using var c = await _data.OpenConnectionAsync();
        var (runningUser, running) = await Seed(c, "running");
        var (_, stopped) = await Seed(c, "stopped");
        Assert.Equal(runningUser, await Teammates.Api.Platform.ClaimComputerRecovery(c, running));
        Assert.Equal("recovering", await Status(c, running));
        Assert.Equal(runningUser, await Teammates.Api.Platform.ClaimComputerRecovery(c, running));
        Assert.Null(await Teammates.Api.Platform.ClaimComputerRecovery(c, stopped));
        Assert.Null(await Teammates.Api.Platform.ClaimComputerRecovery(c, Guid.NewGuid()));
        Assert.Equal("stopped", await Status(c, stopped));
    }

    [Fact]
    public async Task Explicit_request_makes_a_stopped_computer_recoverable_again()
    {
        if (_data is null) return;
        await using var c = await _data.OpenConnectionAsync();
        var (user, computer) = await Seed(c, "stopped");
        Assert.Equal(1, await Teammates.Api.Platform.WantComputer(c, user));
        Assert.Equal("running", await Status(c, computer));
        Assert.Equal(user, await Teammates.Api.Platform.ClaimComputerRecovery(c, computer));
        // A recovering computer is not reset by a second request.
        Assert.Equal(0, await Teammates.Api.Platform.WantComputer(c, user));
        Assert.Equal("recovering", await Status(c, computer));
    }

    [Fact]
    public void Wiring_keeps_restore_behind_the_status_guard()
    {
        var root = MigrationManifestTests.Root();
        var platform = File.ReadAllText(Path.Combine(root, "apps", "api", "Platform.cs"));
        var begin = platform[platform.IndexOf("public async Task<bool> BeginComputerRecovery", StringComparison.Ordinal)..];
        begin = begin[..begin.IndexOf("public static Task<Guid?> ClaimComputerRecovery", StringComparison.Ordinal)];
        Assert.True(begin.IndexOf("ClaimComputerRecovery", StringComparison.Ordinal) < begin.IndexOf("RestoreComputerAsync", StringComparison.Ordinal));
        Assert.DoesNotContain("SET status='recovering' WHERE computer_id=@id\"", begin);
        var beta = File.ReadAllText(Path.Combine(root, "apps", "api", "Beta.cs"));
        Assert.Equal(2, beta.Split("Platform.WantComputer(").Length - 1);
        var stop = beta[beta.IndexOf("\"/api/computer/stop\"", StringComparison.Ordinal)..];
        stop = stop[..stop.IndexOf("\"/api/computer/restart\"", StringComparison.Ordinal)];
        Assert.True(stop.IndexOf("SET status='stopped'", StringComparison.Ordinal) < stop.IndexOf("StopComputerAsync", StringComparison.Ordinal));
        Assert.Contains("ComputeErrorCode.NotFound", stop);
        Assert.Contains("Platform.WantComputer(conn, user.Value)", File.ReadAllText(Path.Combine(root, "apps", "api", "Routes.cs")));
    }
}
