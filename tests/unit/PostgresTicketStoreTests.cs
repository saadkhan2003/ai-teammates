using Dapper;
using Npgsql;
using Teammates.Api;
using Xunit.Sdk;

namespace Teammates.UnitTests;

[AttributeUsage(AttributeTargets.Method)]
public sealed class PostgresFactAttribute : FactAttribute
{
    public PostgresFactAttribute()
    {
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("TEST_PG_DSN")))
            Skip = "PostgreSQL integration skipped: set TEST_PG_DSN to an isolated test PostgreSQL server.";
    }
}

public sealed partial class PostgresTicketStoreTests : IAsyncLifetime
{
    private string? _database;
    private NpgsqlDataSource? _dataA;
    private NpgsqlDataSource? _dataB;

    public async Task InitializeAsync()
    {
        var dsn = Environment.GetEnvironmentVariable("TEST_PG_DSN");
        if (string.IsNullOrWhiteSpace(dsn)) return;
        _database = "test_" + Guid.NewGuid().ToString("N");
        var admin = new NpgsqlConnectionStringBuilder(dsn);
        admin.Database = "postgres";
        await using (var conn = new NpgsqlConnection(admin.ConnectionString))
        {
            await conn.OpenAsync();
            await conn.ExecuteAsync($"CREATE DATABASE {_database}");
        }
        var target = new NpgsqlConnectionStringBuilder(dsn) { Database = _database, MaxPoolSize = 12 };
        _dataA = NpgsqlDataSource.Create(target.ConnectionString);
        _dataB = NpgsqlDataSource.Create(target.ConnectionString);
        await using var db = await _dataA.OpenConnectionAsync();
        foreach (var file in Directory.GetFiles(Path.Combine(FindRepoRoot(), "db"), "*.sql").OrderBy(Path.GetFileName, StringComparer.Ordinal))
            await db.ExecuteAsync(await File.ReadAllTextAsync(file));
    }

    public async Task DisposeAsync()
    {
        if (_dataA != null) await _dataA.DisposeAsync();
        if (_dataB != null) await _dataB.DisposeAsync();
        if (_database == null || string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("TEST_PG_DSN"))) return;
        var admin = new NpgsqlConnectionStringBuilder(Environment.GetEnvironmentVariable("TEST_PG_DSN")) { Database = "postgres" };
        await using var conn = new NpgsqlConnection(admin.ConnectionString);
        await conn.OpenAsync();
        await conn.ExecuteAsync($"DROP DATABASE IF EXISTS {_database} WITH (FORCE)");
    }

    [PostgresFact]
    public async Task Feedback_survives_transcript_saves_and_stale_completion_then_consumes_on_success()
    {
        await using var conn = await _dataA!.OpenConnectionAsync();
        var owner = await conn.ExecuteScalarAsync<Guid>("INSERT INTO users(username,password_hash) VALUES (@name,'unused') RETURNING id", new { name = Guid.NewGuid().ToString() });
        var bot = await conn.ExecuteScalarAsync<Guid>("INSERT INTO bots(owner_id,name,token_hash) VALUES (@owner,'feedback','unused') RETURNING id", new { owner });
        var conversation = await conn.ExecuteScalarAsync<Guid>("INSERT INTO conversations(bot_id) VALUES (@bot) RETURNING id", new { bot });
        var message = await conn.ExecuteScalarAsync<Guid>("INSERT INTO messages(conversation_id,role,content) VALUES (@conversation,'assistant','answer') RETURNING id", new { conversation });
        var id = await conn.ExecuteScalarAsync<Guid>("INSERT INTO tasks(bot_id,conversation_id,title,instruction,status,lease_epoch) VALUES (@bot,@conversation,'test','test','running',3) RETURNING id", new { bot, conversation });
        await conn.ExecuteAsync("INSERT INTO bot_feedback(bot_id,message_id,emoji,action,task_id) VALUES (@bot,@message,'+1','reacted',@id)", new { bot, message, id });
        var note = $"Hidden feedback, not chat and no reply expected: the user reacted +1 on message {message}.";
        await conn.ExecuteAsync("INSERT INTO task_transcript(task_id,seq,role,content) VALUES (@id,0,'system',@note)", new { id, note });
        Assert.Equal(1, await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM bot_feedback WHERE task_id=@id AND consumed_at IS NULL", new { id }));
        Assert.Empty(await conn.QueryAsync(FeedbackDelivery.CompleteSql, new { id, result = "{}", epoch = 2 }));
        Assert.Equal(1, await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM bot_feedback WHERE task_id=@id AND consumed_at IS NULL", new { id }));
        await conn.ExecuteAsync("UPDATE tasks SET status='waiting_resource' WHERE id=@id", new { id });
        Assert.Empty(await conn.QueryAsync(FeedbackDelivery.CompleteSql, new { id, result = "{}", epoch = 3 }));
        await conn.ExecuteAsync("UPDATE tasks SET status='running',lease_epoch=4 WHERE id=@id", new { id });
        Assert.Single(await conn.QueryAsync(FeedbackDelivery.CompleteSql, new { id, result = "{}", epoch = 4 }));
        Assert.Equal(0, await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM bot_feedback WHERE task_id=@id AND consumed_at IS NULL", new { id }));
    }

    [PostgresFact]
    public async Task Two_instances_consume_once_and_concurrent_replay_has_one_winner()
    {
        var storeA = new PostgresOneTimeTicketStore(_dataA!);
        var storeB = new PostgresOneTimeTicketStore(_dataB!);
        var user = Guid.NewGuid(); var bot = Guid.NewGuid();
        var token = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
        var ipHash = System.Security.Cryptography.RandomNumberGenerator.GetBytes(32);
        var ticket = new OneTimeTicket(Guid.NewGuid(), "vnc", token, user, bot, Guid.NewGuid(), "watch", "tab-test", 4,
            "{}", ipHash, DateTime.UtcNow.AddYears(-1)); // the database assigns the authoritative 60 second lifetime
        await storeA.IssueAsync(ticket, default);
        Assert.Null(await storeB.ConsumeAsync(token, "vnc", user, bot, System.Security.Cryptography.RandomNumberGenerator.GetBytes(32), default));
        var attempts = Enumerable.Range(0, 200).Select(i => (i % 2 == 0 ? storeA : storeB)
            .ConsumeAsync(token, "vnc", user, bot, ipHash, default));
        var results = await Task.WhenAll(attempts);
        Assert.Single(results, x => x != null);
        Assert.Null(await storeA.ConsumeAsync(token, "vnc", user, bot, ipHash, default));
    }

    [PostgresFact]
    public async Task Concurrent_lease_acquires_have_one_epoch_winner_and_epochs_increase()
    {
        var computer = Guid.NewGuid(); var firstUser = Guid.NewGuid(); var secondUser = Guid.NewGuid();
        await using (var conn = await _dataA!.OpenConnectionAsync())
            await conn.ExecuteAsync("INSERT INTO desktop_lease (computer_id,display,holder_kind,epoch,expires_at) VALUES (@computer,1,'none',1,clock_timestamp())", new { computer });
        var contenders = Enumerable.Range(0, 100).Select(Contend);
        var outcomes = await Task.WhenAll(contenders);
        var winner = Assert.Single(outcomes, row => row != null);
        var epoch = winner!.Epoch;
        Assert.Equal(2, epoch);
        var activeUser = winner.HolderUserId!.Value;
        var otherUser = activeUser == firstUser ? secondUser : firstUser;
        var prior = epoch;
        for (var i = 0; i < 8; i++)
        {
            await using (var conn = await _dataA.OpenConnectionAsync())
                Assert.NotNull(await DesktopLeaseRepository.ReleaseAsync(conn, computer, 1, activeUser, "tab-race", epoch, default));
            await using (var conn = await _dataB!.OpenConnectionAsync())
            {
                var next = await DesktopLeaseRepository.AcquireAsync(conn, computer, 1, otherUser, "tab-race", epoch + 1, false, default);
                Assert.NotNull(next);
                Assert.True(next!.Epoch > prior);
                prior = next.Epoch;
                epoch = next.Epoch;
            }
            (activeUser, otherUser) = (otherUser, activeUser);
        }

        async Task<DesktopLeaseRow?> Contend(int i)
        {
            await using var conn = await (i % 2 == 0 ? _dataA! : _dataB!).OpenConnectionAsync();
            return await DesktopLeaseRepository.AcquireAsync(conn, computer, 1, i % 2 == 0 ? firstUser : secondUser,
                "tab-race", 1, false, default);
        }
    }

    [PostgresFact]
    public async Task Two_sweepers_racing_release_after_claim_once_and_teach_is_unique()
    {
        var computer = Guid.NewGuid(); var user = Guid.NewGuid(); var bot = Guid.NewGuid();
        await using (var conn = await _dataA!.OpenConnectionAsync())
        {
            await conn.ExecuteAsync("INSERT INTO desktop_lease (computer_id,display,holder_kind,holder_user_id,tab_id,epoch,expires_at,release_after) VALUES (@computer,1,'human',@user,'tab-race',9,clock_timestamp()+interval '1 minute',clock_timestamp()-interval '1 second')", new { computer, user });
        }
        var claims = await Task.WhenAll(DesktopRwConnections.ClaimDueAsync(_dataA, default), DesktopRwConnections.ClaimDueAsync(_dataB!, default));
        Assert.Single(claims.SelectMany(rows => rows));

        var sessionA = Guid.NewGuid().ToString("N"); var sessionB = Guid.NewGuid().ToString("N");
        var starts = await Task.WhenAll(Enumerable.Range(0, 2).Select(StartTeach));
        Assert.Single(starts, result => result.HasValue);

        async Task<int?> StartTeach(int i)
        {
            await using var conn = await (i == 0 ? _dataA! : _dataB!).OpenConnectionAsync();
            return await conn.ExecuteScalarAsync<int?>("""
                INSERT INTO active_teach (bot_id,user_id,session_id,expires_at) VALUES (@bot,@user,@session,clock_timestamp()+interval '10 minutes')
                ON CONFLICT (bot_id) DO UPDATE SET user_id=EXCLUDED.user_id,session_id=EXCLUDED.session_id,expires_at=EXCLUDED.expires_at
                WHERE active_teach.expires_at<=clock_timestamp() RETURNING 1
                """, new { bot, user, session = i == 0 ? sessionA : sessionB });
        }
    }

    [PostgresFact]
    public async Task Login_broker_slot_is_encrypted_shared_and_single_use_across_instances()
    {
        var key = System.Security.Cryptography.RandomNumberGenerator.GetBytes(32);
        var brokerA = new LoginBroker(_dataA, key);
        var brokerB = new LoginBroker(_dataB, key);
        var id = Guid.NewGuid();
        await brokerA.HoldAsync(id, [new SecretField("password", "Fake-Only-Password-0001"u8.ToArray())], saveToVault: false);
        await using (var conn = await _dataA!.OpenConnectionAsync())
        {
            var cipher = await conn.ExecuteScalarAsync<byte[]>("SELECT ciphertext FROM login_broker_slots WHERE id=@id", new { id });
            Assert.True(cipher.AsSpan().IndexOf("Fake-Only-Password-0001"u8) < 0);
        }
        var slot = await brokerB.TryTakeAsync(id);
        Assert.Equal("Fake-Only-Password-0001"u8.ToArray(), Assert.Single(slot.Fields!).Value);
        Assert.Null((await brokerA.TryTakeAsync(id)).Fields);
    }

    private static string FindRepoRoot()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current != null && !File.Exists(Path.Combine(current.FullName, "README.md"))) current = current.Parent;
        return current?.FullName ?? throw new DirectoryNotFoundException("repo root unavailable");
    }
}
