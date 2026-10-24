using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Dapper;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Npgsql;
using Teammates.Api;

namespace Teammates.UnitTests;

public sealed class BriefDatabaseTests : IAsyncLifetime
{
    private string? _database; private NpgsqlDataSource? _data; private WebApplication? _app;
    private HttpClient? _ownerClient; private HttpClient? _otherClient; private Teammates.Api.Platform? _platform;
    private Guid _owner, _bot, _conversation, _parent;
    public async Task InitializeAsync()
    {
        var dsn = Environment.GetEnvironmentVariable("TEST_PG_DSN"); if (string.IsNullOrWhiteSpace(dsn)) return;
        DefaultTypeMap.MatchNamesWithUnderscores = true;
        _database = "briefs_test_" + Guid.NewGuid().ToString("N");
        await using (var admin = new NpgsqlConnection(new NpgsqlConnectionStringBuilder(dsn) { Database = "postgres" }.ConnectionString))
        { await admin.OpenAsync(); await admin.ExecuteAsync($"CREATE DATABASE {_database}"); }
        _data = NpgsqlDataSource.Create(new NpgsqlConnectionStringBuilder(dsn) { Database = _database, MaxPoolSize = 15 }.ConnectionString);
        await using var c = await _data.OpenConnectionAsync();
        foreach (var file in Teammates.Api.Platform.MigrationFiles) await c.ExecuteAsync(await File.ReadAllTextAsync(Path.Combine(MigrationManifestTests.Root(), "db", file)));
        _owner = await c.ExecuteScalarAsync<Guid>("INSERT INTO users(username,password_hash) VALUES('brief-owner','unused') RETURNING id");
        var other = await c.ExecuteScalarAsync<Guid>("INSERT INTO users(username,password_hash) VALUES('brief-other','unused') RETURNING id");
        _bot = await c.ExecuteScalarAsync<Guid>("INSERT INTO bots(owner_id,name,token_hash) VALUES(@owner,'Brief bot','unused') RETURNING id", new { owner = _owner });
        _conversation = await c.ExecuteScalarAsync<Guid>("INSERT INTO conversations(bot_id) VALUES(@bot) RETURNING id", new { bot = _bot });
        _parent = await c.ExecuteScalarAsync<Guid>("INSERT INTO tasks(bot_id,conversation_id,title,instruction,kind,status) VALUES(@bot,@conversation,'Prepare','Prepare a brief','work','running') RETURNING id", new { bot = _bot, conversation = _conversation });
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["LLM_PROVIDER"] = "mock", ["ENABLE_TEST_HOOKS"] = "true", ["WORKER_TOKEN"] = "unit-worker" }).Build();
        _platform = new(_data, new byte[32], null!, null!, config); // These database routes never access compute or S3.
        var builder = WebApplication.CreateSlimBuilder(); builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
        _app = builder.Build(); Routes.Map(_app, _platform, null!); await _app.StartAsync();
        _ownerClient = new HttpClient { BaseAddress = new Uri(_app.Urls.Single()) }; _otherClient = new HttpClient { BaseAddress = _ownerClient.BaseAddress };
        _ownerClient.DefaultRequestHeaders.Add("Cookie", "teammates_session=" + await _platform.CreateSession(_owner));
        _otherClient.DefaultRequestHeaders.Add("Cookie", "teammates_session=" + await _platform.CreateSession(other));
    }
    public async Task DisposeAsync()
    {
        _ownerClient?.Dispose(); _otherClient?.Dispose(); if (_app is not null) await _app.DisposeAsync();
        if (_data is not null) await _data.DisposeAsync();
        if (_database is null) return;
        var dsn = new NpgsqlConnectionStringBuilder(Environment.GetEnvironmentVariable("TEST_PG_DSN")) { Database = "postgres" };
        await using var c = new NpgsqlConnection(dsn.ConnectionString); await c.OpenAsync(); await c.ExecuteAsync($"DROP DATABASE IF EXISTS {_database} WITH (FORCE)");
    }
    private async Task<Guid> Seed()
    {
        using var response = await _ownerClient!.PostAsJsonAsync("/api/test/briefs/seed", new { botId = _bot, conversationId = _conversation });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("taskId").GetGuid();
    }
    private async Task<Guid> LearningMessage(string text = "A clean layout with muted labels and generous spacing.", string role = "assistant", string kind = "text", Guid? task = null)
    {
        await using var c=await _data!.OpenConnectionAsync();
        return await c.ExecuteScalarAsync<Guid>("INSERT INTO messages(conversation_id,role,kind,content,task_id) VALUES(@conversation,@role,@kind,@text,@task) RETURNING id",new { conversation=_conversation,role,kind,text,task });
    }
    private async Task<int> Learn(Func<ApprovalSignal,CancellationToken,Task<LearnedPreference?>>? extract=null)
    {
        await using var c=await _data!.OpenConnectionAsync();await c.ExecuteAsync("UPDATE approval_signals SET created_at=now()-interval '3 seconds'");
        return await ApprovalSignals.LearnPending(_platform!,extract);
    }
    [PostgresFact]
    public async Task LearningReactionToggleLastStateAndOwnerPrivacy()
    {
        var message=await LearningMessage();
        Assert.Equal(HttpStatusCode.Forbidden,(await _otherClient!.PostAsJsonAsync($"/api/messages/{message}/reactions",new { emoji="👍" })).StatusCode);
        await _ownerClient!.PostAsJsonAsync($"/api/messages/{message}/reactions",new { emoji="👍" });
        await _ownerClient.PostAsJsonAsync($"/api/messages/{message}/reactions",new { emoji="👍" });
        await using var c=await _data!.OpenConnectionAsync();Assert.Equal(0,await c.ExecuteScalarAsync<int>("SELECT count(*) FROM approval_signals"));
        await _ownerClient.PostAsJsonAsync($"/api/messages/{message}/reactions",new { emoji="👍" });
        await _ownerClient.PostAsJsonAsync($"/api/messages/{message}/reactions",new { emoji="👎" });
        Assert.Equal("negative",await c.ExecuteScalarAsync<string>("SELECT kind FROM approval_signals"));Assert.Equal(1,await Learn());
        var notes=await _ownerClient.GetFromJsonAsync<JsonElement>($"/api/bots/{_bot}/learned");Assert.Single(notes.EnumerateArray());Assert.Equal("avoid",notes[0].GetProperty("kind").GetString());
        Assert.Equal(message,notes[0].GetProperty("source").GetProperty("messageId").GetGuid());
        var note=notes[0].GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.Forbidden,(await _otherClient.GetAsync($"/api/bots/{_bot}/learned")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden,(await _otherClient.DeleteAsync($"/api/bots/{_bot}/learned/{note}")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent,(await _ownerClient.DeleteAsync($"/api/bots/{_bot}/learned/{note}")).StatusCode);
        await c.ExecuteAsync("UPDATE approval_signals SET learned_at=NULL");await Learn();
        Assert.Empty((await _ownerClient.GetFromJsonAsync<JsonElement>($"/api/bots/{_bot}/learned")).EnumerateArray());
        Assert.Equal(1,await c.ExecuteScalarAsync<int>("SELECT count(*) FROM audit_events WHERE action='learning.deleted'"));
    }
    [PostgresFact]
    public async Task LearningIgnoresOtherUsersPeersToolsAndQuotedUntrustedApproval()
    {
        await using var c=await _data!.OpenConnectionAsync();
        var peer=await c.ExecuteScalarAsync<Guid>("INSERT INTO tasks(bot_id,conversation_id,title,instruction,kind,origin_depth) VALUES(@bot,@conversation,'peer','peer','peer',1) RETURNING id",new { bot=_bot,conversation=_conversation });
        foreach(var message in new[] { await LearningMessage("perfect","tool"),await LearningMessage("perfect","assistant","text",peer),await LearningMessage("perfect","assistant","memory"),await LearningMessage("perfect","user") })
            await ApprovalSignals.Record(c,null,_bot,_owner,_conversation,message,"positive","reply","perfect","untrusted","test:"+message);
        var good=await LearningMessage();var other=await c.ExecuteScalarAsync<Guid>("SELECT id FROM users WHERE id<>@owner LIMIT 1",new { owner=_owner });
        await ApprovalSignals.Record(c,null,_bot,other,_conversation,good,"positive","reaction","👍","result","other");
        Assert.Equal(0,await c.ExecuteScalarAsync<int>("SELECT count(*) FROM approval_signals"));
        // Approval inside quote parts is data, not the human's own feedback text.
        var response=await _ownerClient!.PostAsJsonAsync($"/api/conversations/{_conversation}/messages",new { parts=new object[] { new { type="quote",text="perfect",sourceMessageId=good },new { type="text",text="Summarize this quote" } } });
        Assert.True(response.IsSuccessStatusCode);Assert.Equal(0,await c.ExecuteScalarAsync<int>("SELECT count(*) FROM approval_signals"));
        var replied=await _ownerClient.PostAsJsonAsync($"/api/conversations/{_conversation}/messages",new { parts=new object[] { new { type="reply",messageId=good },new { type="text",text="perfect" } } });
        Assert.True(replied.IsSuccessStatusCode);Assert.Equal(1,await c.ExecuteScalarAsync<int>("SELECT count(*) FROM approval_signals WHERE signal='reply'"));
    }
    [PostgresFact]
    public async Task LearningSupersedesCorrectionsDedupesCapsAndProtectsContext()
    {
        await using var c=await _data!.OpenConnectionAsync();var message=await LearningMessage();
        await ApprovalSignals.Record(c,null,_bot,_owner,_conversation,message,"positive","reply","perfect","A spacious clean design","positive");await Learn();
        await ApprovalSignals.Record(c,null,_bot,_owner,_conversation,message,"correction","reply","no, shorter please","A spacious clean design","negative");await Learn();
        Assert.Equal(1,await c.ExecuteScalarAsync<int>("SELECT count(*) FROM memories WHERE learned_kind IS NOT NULL AND status='active'"));
        Assert.Equal(1,await c.ExecuteScalarAsync<int>("SELECT count(*) FROM memories WHERE status='superseded'"));
        await ApprovalSignals.Record(c,null,_bot,_owner,_conversation,message,"correction","reply","no, shorter please","A spacious clean design","negative-again");await Learn();
        Assert.Equal(1,await c.ExecuteScalarAsync<int>("SELECT count(*) FROM memories WHERE learned_kind IS NOT NULL AND status='active'"));
        var own=await ApprovalSignals.Context(c,_bot,"shorter");Assert.Contains("Avoid:",own);Assert.True(own.Length<=1200);
        var otherBot=await c.ExecuteScalarAsync<Guid>("INSERT INTO bots(owner_id,name,token_hash) VALUES(@owner,'Private other','unused') RETURNING id",new { owner=_owner });
        Assert.Equal("",await ApprovalSignals.Context(c,otherBot,"shorter"));
        // Even an accidental sharing flag must not expose learned notes to a sibling bot.
        await c.ExecuteAsync("UPDATE memories SET visibility='owner' WHERE learned_kind IS NOT NULL");
        Assert.DoesNotContain("shorter",JsonSerializer.Serialize(await new MemoryStore(_platform!).Search(otherBot,_owner,"shorter")));
        await c.ExecuteAsync("UPDATE memories SET visibility='bot' WHERE learned_kind IS NOT NULL");
        for(var n=0;n<55;n++)
        {
            var signal=new ApprovalSignal { Id=Guid.NewGuid(),BotId=_bot,UserId=_owner,ConversationId=_conversation,MessageId=message,Kind="positive",Signal="reaction",Detail=JsonSerializer.Serialize(new { text="👍",excerpt="result" }) };
            await using var tx=await c.BeginTransactionAsync();
            await new MemoryStore(_platform!).SaveLearned(c,tx,signal,new("preference","Prefer layout variant "+n+" for project "+n,"layout:"+n));await tx.CommitAsync();
        }
        Assert.Equal(50,await c.ExecuteScalarAsync<int>("SELECT count(*) FROM memories WHERE learned_kind IS NOT NULL AND status IN ('active','pending')"));
        var bad=new ApprovalSignal { Id=Guid.NewGuid(),BotId=_bot,UserId=_owner,Kind="positive",Signal="reaction",Detail="{\"text\":\"perfect\",\"excerpt\":\"layout\"}" };
        await using(var tx=await c.BeginTransactionAsync()) { Assert.Null(await new MemoryStore(_platform!).SaveLearned(c,tx,bad,new("preference","password: unit-private-password","secret")));await tx.CommitAsync(); }
        Assert.DoesNotContain("unit-private-password",await ApprovalSignals.Context(c,_bot,"password"));
    }
    [PostgresFact]
    public async Task LearningExtractorFailureFallsBackAndCompletionIsEpochFenced()
    {
        var message=await LearningMessage();await _ownerClient!.PostAsJsonAsync($"/api/messages/{message}/reactions",new { emoji="👍" });
        Assert.Equal(1,await Learn((_,_)=>throw new InvalidOperationException("mock outage")));
        await using var c=await _data!.OpenConnectionAsync();var id=await c.ExecuteScalarAsync<Guid>("SELECT id FROM approval_signals");
        await c.ExecuteAsync("UPDATE approval_signals SET task_id=@task",new { task=_parent });
        await c.ExecuteAsync("INSERT INTO task_transcript(task_id,seq,role,content) VALUES(@task,0,'system',@text)",new { task=_parent,text="[approval-signal:"+id+"]" });
        await c.QueryAsync(FeedbackDelivery.CompleteSql,new { id=_parent,epoch=9,result="{}" });
        Assert.Equal(1,await c.ExecuteScalarAsync<int>("SELECT count(*) FROM approval_signals WHERE consumed_at IS NULL"));
        await c.QueryAsync(FeedbackDelivery.CompleteSql,new { id=_parent,epoch=0,result="{}" });
        Assert.Equal(0,await c.ExecuteScalarAsync<int>("SELECT count(*) FROM approval_signals WHERE consumed_at IS NULL"));
    }
    [PostgresFact]
    public async Task GetSteerPrivacyAuditAndLessonsHaveRealPersistence()
    {
        var task = await Seed();
        using var got = await _ownerClient!.GetAsync($"/api/tasks/{task}/brief"); Assert.Equal(HttpStatusCode.OK, got.StatusCode);
        var payload = await got.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(task, payload.GetProperty("taskId").GetGuid()); Assert.Equal(4.25, payload.GetProperty("thoughtSeconds").GetDouble());
        Assert.Equal(1, payload.GetProperty("version").GetInt32()); Assert.Equal("waiting_human", payload.GetProperty("status").GetString());
        Assert.True(payload.GetProperty("quality").GetProperty("passed").GetBoolean()); Assert.Equal(2, payload.GetProperty("references").GetArrayLength());
        Assert.Equal(HttpStatusCode.Forbidden, (await _otherClient!.GetAsync($"/api/tasks/{task}/brief")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await _otherClient.PostAsJsonAsync($"/api/tasks/{task}/brief/steer", new { text = "Change another owner's task" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _ownerClient.GetAsync($"/api/tasks/{_parent}/brief")).StatusCode);
        foreach (var invalid in new[] { "", " ", new string('x',4001) })
            Assert.Equal(HttpStatusCode.BadRequest, (await _ownerClient.PostAsJsonAsync($"/api/tasks/{task}/brief/steer", new { text = invalid })).StatusCode);
        using var steer = await _ownerClient.PostAsJsonAsync($"/api/tasks/{task}/brief/steer", new { text = "Keep light theme and attach both crops." }); Assert.Equal(HttpStatusCode.Accepted, steer.StatusCode);
        var note = await steer.Content.ReadFromJsonAsync<JsonElement>(); Assert.True(note.TryGetProperty("createdAt", out _)); Assert.True(note.TryGetProperty("id", out _));
        await _ownerClient.PostAsJsonAsync($"/api/tasks/{task}/brief/steer", new { text = "  Keep   light theme and attach both crops. " });
        var lessons = await _ownerClient.GetFromJsonAsync<JsonElement>($"/api/bots/{_bot}/brief-lessons"); Assert.Single(lessons.EnumerateArray());
        Assert.Equal(HttpStatusCode.Forbidden, (await _otherClient.GetAsync($"/api/bots/{_bot}/brief-lessons")).StatusCode);
        await using var c = await _data!.OpenConnectionAsync();
        Assert.Equal(2, await c.ExecuteScalarAsync<int>("SELECT count(*) FROM audit_events WHERE task_id=@task AND action='brief.steered'", new { task }));
        await c.ExecuteAsync("UPDATE tasks SET status='running',lease_epoch=2 WHERE id=@task", new { task });
        using var worker = new HttpClient { BaseAddress = _ownerClient.BaseAddress }; worker.DefaultRequestHeaders.Add("Authorization", "Bearer unit-worker");
        Assert.Equal(HttpStatusCode.Conflict, (await worker.GetAsync($"/internal/tasks/{task}/brief/steering?epoch=1")).StatusCode);
        var delivery = await worker.GetFromJsonAsync<JsonElement>($"/internal/tasks/{task}/brief/steering?epoch=2"); Assert.Equal(2, delivery.GetProperty("steering").GetArrayLength());
        await c.ExecuteAsync("UPDATE tasks SET status='failed',error='Snapshot check did not pass' WHERE id=@task", new { task });
        Assert.Equal(1, await c.ExecuteScalarAsync<int>("SELECT count(*) FROM brief_lessons WHERE source_task_id=@task AND source='failed_run'", new { task }));
        var lessonId = lessons[0].GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.Forbidden, (await _otherClient.DeleteAsync($"/api/bots/{_bot}/brief-lessons/{lessonId}")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await _ownerClient.DeleteAsync($"/api/bots/{_bot}/brief-lessons/{lessonId}")).StatusCode);
    }
    [PostgresFact]
    public async Task CreationRejectsWeakBriefThenPersistsOneRewriteAndMeasuredThoughtTime()
    {
        var weak = JsonSerializer.SerializeToElement(new { title = "Thin brief", brief = new { goal = "Improve it.", context = "Asked.", acceptance = new[] { new { criterion = "Output", check = "inspect output" } }, report_back = "Report." } });
        var rejected = await BriefStore.Prepare(_platform!, _bot, _parent, JsonSerializer.SerializeToElement(new { title = "Missing", brief = new { goal = "Improve it" } }), false, default);
        Assert.Equal("brief_rejected", JsonSerializer.SerializeToElement(rejected.Error).GetProperty("status").GetString());
        var first = await BriefStore.Prepare(_platform!, _bot, _parent, weak, false, default);
        Assert.Equal("brief_needs_rewrite", JsonSerializer.SerializeToElement(first.Error).GetProperty("status").GetString());
        var second = await BriefStore.Prepare(_platform!, _bot, _parent, weak, false, default);
        Assert.NotNull(second.Value); Assert.NotEmpty(second.Value!.Quality.Warnings);
        await using var c = await _data!.OpenConnectionAsync();
        await c.ExecuteAsync("INSERT INTO model_calls(task_id,bot_id,role,provider,model,latency_ms) VALUES(@parent,@bot,'planner','mock','mock/planner',1730)", new { parent = _parent, bot = _bot });
        IReadOnlyList<string>? argv = null;
        var strong = await CodingTools.Run(_platform!, _bot, _parent, "spawn_child_task", JsonSerializer.SerializeToElement(new { title = "Strong brief", repo = "project", brief = BriefRoutes.SeedBrief() }), call => { argv = call; return Task.FromResult((0,"","")); }, default);
        Assert.NotNull(argv); Assert.Equal(Teammates.Api.BotFs.Root(_bot) + "/project", argv![2]);
        Assert.StartsWith(Teammates.Api.BotFs.Root(_bot) + "/project/.worktrees/", argv[5]);
        var child = JsonSerializer.SerializeToElement(strong).GetProperty("taskId").GetGuid();
        var payload = await _ownerClient!.GetFromJsonAsync<JsonElement>($"/api/tasks/{child}/brief"); Assert.Equal(1.73, payload.GetProperty("thoughtSeconds").GetDouble());
        Assert.StartsWith("Work only inside /workspace/", await c.ExecuteScalarAsync<string>("SELECT instruction FROM tasks WHERE id=@child", new { child }));
        // Attempt tracking counts good submissions too, so only the first quality check can request a rewrite.
        var laterWeak = JsonSerializer.SerializeToElement(new { title = "Strong brief", brief = new { goal = "Improve it.", context = "Asked.", acceptance = new[] { new { criterion = "Output", check = "inspect output" } }, report_back = "Report." } });
        var acceptedWithWarnings = await BriefStore.Prepare(_platform!, _bot, _parent, laterWeak, false, default);
        Assert.NotNull(acceptedWithWarnings.Value); Assert.NotEmpty(acceptedWithWarnings.Value!.Quality.Warnings);
        var messages = await _ownerClient!.GetFromJsonAsync<JsonElement>($"/api/bots/{_bot}/messages");
        var linked = messages.GetProperty("messages").EnumerateArray().Single(x => x.GetProperty("requestId").GetGuid() == _parent);
        Assert.Contains(child.ToString(), linked.GetProperty("childTasks").GetRawText());
    }
    [PostgresFact]
    public async Task AutoContextIsPrivateCappedAndRedactsEachSource()
    {
        await using var c = await _data!.OpenConnectionAsync();
        var dummy = "sk-or-" + new string('z',30);
        await c.ExecuteAsync("INSERT INTO memories(bot_id,owner_id,kind,content,status,author,visibility) VALUES(@bot,@owner,'rule',@content,'active','user','bot')", new { bot = _bot, owner = _owner, content = "Use light theme " + dummy });
        await c.ExecuteAsync("INSERT INTO messages(conversation_id,role,content) VALUES(@conversation,'user','[attached: /workspace/uploads/2026-10-24/ref.png]')", new { conversation = _conversation });
        await BriefStore.AddLesson(c, _bot, _owner, _parent, "Keep exact values " + dummy, "steer");
        var item = await c.ExecuteScalarAsync<Guid>("INSERT INTO library_items(bot_id,name,sha256) VALUES(@bot,'referenced-notes.md','fixture') RETURNING id", new { bot = _bot });
        await c.ExecuteAsync("INSERT INTO messages(conversation_id,role,content) VALUES(@conversation,'user','Use referenced-notes.md from my Library')", new { conversation = _conversation });
        var auto = await BriefStore.AutoContext(_platform!, _bot, _owner, _conversation, "typography", default);
        Assert.DoesNotContain(dummy, auto); Assert.Contains("[REDACTED]", auto); Assert.Contains("/workspace/uploads/2026-10-24/ref.png", auto); Assert.Contains("Brief lesson:", auto); Assert.Contains(item.ToString(), auto); Assert.True(auto.Length <= 1500);
        var otherBot = await c.ExecuteScalarAsync<Guid>("INSERT INTO bots(owner_id,name,token_hash) VALUES(@owner,'Other bot','unused') RETURNING id", new { owner = _owner });
        Assert.DoesNotContain("Keep exact values", await BriefStore.AutoContext(_platform!, otherBot, _owner, null, "typography", default));
    }
    [PostgresFact]
    public async Task OptionalPeerAndRoutineBriefsRenderAndLegacyInstructionsStayUnchanged()
    {
        await using var c = await _data!.OpenConnectionAsync();
        var light = new { goal = "Produce a concise source-linked weekday digest.", report_back = "Return the report path and source audit counts." };
        var createArgs = JsonSerializer.SerializeToElement(new { name = "Weekday digest", cron = "0 9 * * 1-5", brief = light });
        Assert.Null(ToolSchema.Validate("create_routine", createArgs));
        var created = JsonSerializer.SerializeToElement(await BotMessaging.Run(_platform!, _owner, _bot, _parent, "create_routine", createArgs, default));
        Assert.True(created.GetProperty("ok").GetBoolean());
        var routine = created.GetProperty("routineId").GetGuid();
        var instruction = await c.ExecuteScalarAsync<string>("SELECT instruction FROM routines WHERE id=@routine", new { routine });
        Assert.Contains("## Goal", instruction); Assert.Contains(light.report_back, instruction);
        var routineArgs = JsonSerializer.SerializeToElement(new { routine = routine.ToString() });
        await BotMessaging.Run(_platform!, _owner, _bot, _parent, "get_routine", routineArgs, default);
        var updated = JsonSerializer.SerializeToElement(await BotMessaging.Run(_platform!, _owner, _bot, _parent, "update_routine", JsonSerializer.SerializeToElement(new { routine = routine.ToString(), timezone = "Asia/Karachi", cron = "0 8 * * 1-5", brief = new { goal = "Produce the updated source-linked digest.", report_back = "Return updated report paths and verification counts." } }), default));
        Assert.True(updated.GetProperty("ok").GetBoolean());
        Assert.Contains("updated source-linked", await c.ExecuteScalarAsync<string>("SELECT instruction FROM routines WHERE id=@routine", new { routine }));
        var legacy = JsonSerializer.SerializeToElement(await BotMessaging.Run(_platform!, _owner, _bot, _parent, "create_routine", JsonSerializer.SerializeToElement(new { name = "Legacy digest", cron = "0 10 * * 1-5", instruction = "Preserve this exact legacy instruction." }), default));
        Assert.True(legacy.GetProperty("ok").GetBoolean());
        Assert.Equal("Preserve this exact legacy instruction.", await c.ExecuteScalarAsync<string>("SELECT instruction FROM routines WHERE id=@routine", new { routine = legacy.GetProperty("routineId").GetGuid() }));
        var peer = await c.ExecuteScalarAsync<Guid>("INSERT INTO bots(owner_id,name,token_hash) VALUES(@owner,'Research peer','unused') RETURNING id", new { owner = _owner });
        var delegated = JsonSerializer.SerializeToElement(await BotMessaging.Run(_platform!, _owner, _bot, _parent, "message_bot", JsonSerializer.SerializeToElement(new { bot = peer.ToString(), title = "Compare sources", brief = light }), default));
        Assert.True(delegated.GetProperty("ok").GetBoolean());
        Assert.Contains("## Report back", await c.ExecuteScalarAsync<string>("SELECT content FROM bot_thread_messages WHERE thread_id=@thread AND kind='request'", new { thread = delegated.GetProperty("threadId").GetGuid() }));
    }
    [PostgresFact]
    public async Task ForgedBotCannotAuthorizePreexecOrExecuteAChildBrief()
    {
        var runtime = new Teammates.Api.Runtime(_platform!, null!);
        var envelope = JsonSerializer.SerializeToElement(new { taskId = _parent, botId = Guid.NewGuid(), epoch = 0, tool = "spawn_child_task", args = new { title = "Forged", brief = BriefRoutes.SeedBrief() } });
        foreach (var result in new[] { await runtime.Authorize(envelope, default), await runtime.PreExec(envelope, default), await runtime.Execute(envelope, default) })
            Assert.Equal(409, ((Microsoft.AspNetCore.Http.IStatusCodeHttpResult)result).StatusCode);
    }
    [Fact]
    public async Task SeedEndpointIsActually404BeforeAuthOrDatabaseWhenHooksAreOff()
    {
        var builder = WebApplication.CreateSlimBuilder(); builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var data = NpgsqlDataSource.Create("Host=127.0.0.1;Port=1;Database=unused;Username=unused");
        var p = new Teammates.Api.Platform(data, new byte[32], null!, null!, new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string,string?> { ["ENABLE_TEST_HOOKS"] = "false" }).Build());
        await using var app = builder.Build(); BriefRoutes.Map(app,p); await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync("/api/test/briefs/seed", new { botId = Guid.NewGuid() })).StatusCode);
    }
}
