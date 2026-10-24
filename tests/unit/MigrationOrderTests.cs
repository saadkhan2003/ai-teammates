using Dapper;
using Npgsql;
using Teammates.Api;

namespace Teammates.UnitTests;

/// <summary>Applies the real migration files to throwaway PostgreSQL databases in manifest order.</summary>
public sealed class MigrationOrderTests
{
    private static readonly string[] V05Tables = ["task_briefs", "brief_lessons", "approval_signals", "billing_plans", "computer_jobs", "ai_providers"];

    private static Task<string> Read(string file) => File.ReadAllTextAsync(Path.Combine(MigrationManifestTests.Root(), "db", file));

    private static async Task Fresh(Func<NpgsqlConnection, Task> body)
    {
        var dsn = Environment.GetEnvironmentVariable("TEST_PG_DSN"); if (string.IsNullOrWhiteSpace(dsn)) return;
        var name = "migration_order_" + Guid.NewGuid().ToString("N");
        var admin = new NpgsqlConnectionStringBuilder(dsn) { Database = "postgres" }.ConnectionString;
        await using (var c = new NpgsqlConnection(admin)) { await c.OpenAsync(); await c.ExecuteAsync($"CREATE DATABASE {name}"); }
        try
        {
            await using var conn = new NpgsqlConnection(new NpgsqlConnectionStringBuilder(dsn) { Database = name, Pooling = false }.ConnectionString);
            await conn.OpenAsync();
            await body(conn);
        }
        finally
        {
            await using var c = new NpgsqlConnection(admin); await c.OpenAsync();
            await c.ExecuteAsync($"DROP DATABASE IF EXISTS {name} WITH (FORCE)");
        }
    }

    private static async Task AssertComplete(NpgsqlConnection conn)
    {
        foreach (var table in V05Tables)
            Assert.True(await conn.ExecuteScalarAsync<bool>("SELECT to_regclass(@t) IS NOT NULL", new { t = "public." + table }), table);
        var ids = (await conn.QueryAsync<string>("SELECT id FROM schema_migrations ORDER BY id")).ToArray();
        Assert.Equal(Teammates.Api.Platform.MigrationFiles.Select(f => f[..3]), ids);
        Assert.True(await conn.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='billing_plans' AND column_name='storage_quota_gb')"));
        Assert.True(await conn.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='memories' AND column_name='learned_kind')"));
    }

    [Fact]
    public Task Fresh_database_applies_every_file_in_order_and_a_second_pass_is_a_no_op() => Fresh(async conn =>
    {
        await Teammates.Api.Platform.ApplyMigrations(conn, Read);
        await AssertComplete(conn);
        await Teammates.Api.Platform.ApplyMigrations(conn, Read);
        await AssertComplete(conn);
    });

    [Fact]
    public Task Renumbered_and_brief_migrations_can_run_twice() => Fresh(async conn =>
    {
        await Teammates.Api.Platform.ApplyMigrations(conn, Read);
        var plans = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM billing_plans");
        foreach (var file in new[] { "047_task_briefs.sql", "048_brief_lessons.sql", "049_approval_signals.sql", "050_usage_credits.sql", "051_resources.sql" })
            await conn.ExecuteAsync(await Read(file));
        Assert.Equal(plans, await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM billing_plans"));
        await AssertComplete(conn);
    });

    [Fact]
    public Task Speed_v1_database_with_old_047_048_ids_gains_the_brief_tables() => Fresh(async conn =>
    {
        // Rebuild a speed-v1 database: 001–046, then usage credits and resources recorded as 047 and 048.
        await conn.ExecuteAsync(await Read(Teammates.Api.Platform.MigrationFiles[0]));
        await conn.ExecuteAsync("INSERT INTO schema_migrations (id) VALUES ('001') ON CONFLICT DO NOTHING");
        foreach (var file in Teammates.Api.Platform.MigrationFiles.Skip(1).Where(f => int.Parse(f[..3]) <= 46))
        {
            await conn.ExecuteAsync(await Read(file));
            await conn.ExecuteAsync("INSERT INTO schema_migrations (id) VALUES (@id)", new { id = file[..3] });
        }
        await conn.ExecuteAsync(await Read("050_usage_credits.sql"));
        await conn.ExecuteAsync(await Read("051_resources.sql"));
        await conn.ExecuteAsync("INSERT INTO schema_migrations (id) VALUES ('047'),('048')");
        await conn.ExecuteAsync("UPDATE billing_plans SET weekly_credits = weekly_credits + 1 WHERE id = 'pro'");
        var customized = await conn.ExecuteScalarAsync<long>("SELECT weekly_credits FROM billing_plans WHERE id = 'pro'");

        await Teammates.Api.Platform.ApplyMigrations(conn, Read);

        await AssertComplete(conn);
        Assert.Equal(customized, await conn.ExecuteScalarAsync<long>("SELECT weekly_credits FROM billing_plans WHERE id = 'pro'"));
    });

    [Fact]
    public Task Briefs_v1_database_with_gap_gains_the_speed_tables() => Fresh(async conn =>
    {
        // A briefs-v1 database has 001–042 and 047–049 recorded, with nothing for 043–046.
        await conn.ExecuteAsync(await Read(Teammates.Api.Platform.MigrationFiles[0]));
        await conn.ExecuteAsync("INSERT INTO schema_migrations (id) VALUES ('001') ON CONFLICT DO NOTHING");
        foreach (var file in Teammates.Api.Platform.MigrationFiles.Skip(1).Where(f => int.Parse(f[..3]) is <= 42 or (>= 47 and <= 49)))
        {
            await conn.ExecuteAsync(await Read(file));
            await conn.ExecuteAsync("INSERT INTO schema_migrations (id) VALUES (@id)", new { id = file[..3] });
        }
        await Teammates.Api.Platform.ApplyMigrations(conn, Read);
        await AssertComplete(conn);
    });
}
