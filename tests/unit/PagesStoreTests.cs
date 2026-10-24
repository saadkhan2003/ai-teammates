using Microsoft.Extensions.Logging;
using Dapper;
using Npgsql;
using Teammates.Api;

namespace Teammates.UnitTests;

public class PagesStoreTests : IAsyncLifetime
{
    private string? database;
    private NpgsqlDataSource? data;
    private PagesStore Store => new(data!);
    private Guid owner = Guid.NewGuid(), stranger = Guid.NewGuid(), bot = Guid.NewGuid(), chat = Guid.NewGuid();
    public async Task InitializeAsync()
    {
        var dsn = Environment.GetEnvironmentVariable("TEST_PG_DSN");
        if (string.IsNullOrEmpty(dsn)) return;
        DefaultTypeMap.MatchNamesWithUnderscores = true;
        database = "pages_v1_" + Guid.NewGuid().ToString("N");
        await using var admin = new NpgsqlConnection(dsn); await admin.OpenAsync();
        await admin.ExecuteAsync($"CREATE DATABASE {database}");
        data = NpgsqlDataSource.Create(new NpgsqlConnectionStringBuilder(dsn) { Database = database }.ConnectionString);
        await using var c = await data.OpenConnectionAsync();
        await c.ExecuteAsync("CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE bots(id uuid PRIMARY KEY, owner_id uuid); CREATE TABLE conversations(id uuid PRIMARY KEY, bot_id uuid);");
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !File.Exists(Path.Combine(dir.FullName, "db/053_pages.sql"))) dir = dir.Parent;
        await c.ExecuteAsync(await File.ReadAllTextAsync(Path.Combine(dir!.FullName, "db/053_pages.sql")));
        await c.ExecuteAsync("INSERT INTO users VALUES(@owner),(@stranger); INSERT INTO bots VALUES(@bot,@owner); INSERT INTO conversations VALUES(@chat,@bot);", new { owner, stranger, bot, chat });
    }
    public async Task DisposeAsync()
    {
        if (data != null) await data.DisposeAsync();
        if (database == null) return;
        await using var c = new NpgsqlConnection(Environment.GetEnvironmentVariable("TEST_PG_DSN")); await c.OpenAsync();
        await c.ExecuteAsync($"DROP DATABASE {database} WITH (FORCE)");
    }
    [PostgresFact]
    public async Task OwnerAndBotChecksCoverReadListWritesHistoryAndShares()
    {
        var page = await Store.Save(owner, bot, chat, null, "Report", "report", "First", "Created", "user");
        Assert.NotNull(page); Assert.Equal(1, page.CurrentVersion);
        Assert.Null(await Store.Read(stranger, page.Id));
        Assert.Empty(await Store.List(stranger, bot, "", ""));
        Assert.Empty(await Store.History(stranger, page.Id));
        Assert.Null(await Store.Save(stranger, bot, chat, page.Id, "", "", "Attack", "", "user"));
        Assert.Null(await Store.Save(owner, Guid.NewGuid(), chat, page.Id, "", "", "Attack", "", "bot"));
        Assert.Null(await Store.Save(owner, bot, Guid.NewGuid(), null, "Wrong chat", "report", "body", "", "user"));
        Assert.Null(await Store.Share(stranger, page.Id));
        Assert.Empty(await Store.Links(stranger, page.Id));
    }
    [PostgresFact]
    public async Task ConcurrentEditsAndRestoreAppendVersionsWithoutChangingHistory()
    {
        var first = (await Store.Save(owner, bot, chat, null, "Report", "report", "Original", "Created", "user"))!;
        await Task.WhenAll(Store.Save(owner, bot, chat, first.Id, "", "", "A", "Edit A", "bot"), Store.Save(owner, bot, chat, first.Id, "", "", "B", "Edit B", "user"));
        Assert.Equal(3, (await Store.Read(owner, first.Id))!.CurrentVersion);
        var restored = await Store.Save(owner, bot, chat, first.Id, "", "", null, "", "user", restore: 1);
        Assert.Equal(4, restored!.Version); Assert.Equal("Original", restored.Source);
        Assert.Equal("Original", (await Store.Read(owner, first.Id, 1))!.Source);
        Assert.Equal(4, (await Store.History(owner, first.Id)).Count());
        await Assert.ThrowsAsync<ArgumentException>(() => Store.Save(owner, bot, chat, first.Id, "", "", new string('x', PagesStore.MaxSourceBytes + 1), "", "bot"));
        Assert.Equal(4, (await Store.Read(owner, first.Id))!.Version);
    }
    [PostgresFact]
    public async Task SharesStoreHashesAndRevokeCannotBeCrossedByAnotherOwner()
    {
        var page = (await Store.Save(owner, bot, chat, null, "Report", "report", "Private", "", "user"))!;
        Assert.Equal("private", page.ShareMode);
        var link = (await Store.Share(owner, page.Id))!.Value;
        await using var c = await data!.OpenConnectionAsync();
        Assert.Equal(PagesStore.HashToken(link.Token), await c.ExecuteScalarAsync<string>("SELECT token_hash FROM page_share_links WHERE id=@id", new { id = link.Id }));
        Assert.NotNull(await Store.Shared(link.Token));
        Assert.Null(await Store.Shared(PagesStore.NewToken()));
        Assert.False(await Store.Revoke(stranger, page.Id, link.Id));
        Assert.NotNull(await Store.Shared(link.Token));
        Assert.True(await Store.Revoke(owner, page.Id, link.Id));
        Assert.Null(await Store.Shared(link.Token));
        Assert.Equal("private", (await Store.Read(owner, page.Id))!.ShareMode);
    }
    [PostgresFact]
    public async Task HttpRoutesRequireSessionAndRejectForeignOwnerForEveryOperation()
    {
        await using var c = await data!.OpenConnectionAsync();
        await c.ExecuteAsync("CREATE TABLE sessions(user_id uuid,token_hash text,expires_at timestamptz)");
        var token = PagesStore.NewToken();
        await c.ExecuteAsync("INSERT INTO sessions VALUES(@stranger,@hash,now()+interval '1 hour')", new { stranger, hash = PagesStore.HashToken(token) });
        var page = (await Store.Save(owner, bot, chat, null, "Report", "report", "Private", "", "user"))!;
        var link = (await Store.Share(owner, page.Id))!.Value;
        var builder = Microsoft.AspNetCore.Builder.WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        await using var app = builder.Build(); app.Urls.Add("http://127.0.0.1:0");
        var platform = new Teammates.Api.Platform(data!, new byte[32], null!, null!, new Microsoft.Extensions.Configuration.ConfigurationBuilder().Build());
        PagesRoutes.Map(app, platform); await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
        var requests = new[] {
            ("GET", $"/api/bots/{bot}/pages"), ("POST", $"/api/bots/{bot}/pages"),
            ("GET", $"/api/pages/{page.Id}"), ("PUT", $"/api/pages/{page.Id}"),
            ("GET", $"/api/pages/{page.Id}/versions"), ("POST", $"/api/pages/{page.Id}/restore/1"),
            ("GET", $"/api/pages/{page.Id}/shares"), ("POST", $"/api/pages/{page.Id}/shares"),
            ("DELETE", $"/api/pages/{page.Id}/shares/{link.Id}") };
        foreach (var (method, path) in requests)
        {
            using var request = new HttpRequestMessage(new HttpMethod(method), path);
            if (method is "POST" or "PUT") request.Content = new StringContent("{}", System.Text.Encoding.UTF8, "application/json");
            Assert.Equal(System.Net.HttpStatusCode.Unauthorized, (await client.SendAsync(request)).StatusCode);
        }
        client.DefaultRequestHeaders.Add("Cookie", "teammates_session=" + token);
        foreach (var (method, path) in requests)
        {
            using var request = new HttpRequestMessage(new HttpMethod(method), path);
            if (method is "POST" or "PUT") request.Content = new StringContent("{}", System.Text.Encoding.UTF8, "application/json");
            Assert.Equal(System.Net.HttpStatusCode.NotFound, (await client.SendAsync(request)).StatusCode);
        }
        Assert.Equal(System.Net.HttpStatusCode.OK, (await client.GetAsync("/api/public/pages/" + link.Token)).StatusCode);
        await app.StopAsync();
    }

}
