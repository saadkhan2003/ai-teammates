using System.Text.Json;
using Dapper;
using Teammates.Api;
namespace Teammates.UnitTests;
public sealed partial class PostgresTicketStoreTests
{
    [PostgresFact]
    public async Task Client_id_round_trips_once_and_acceptance_emits_task_started()
    {
        await using var conn = await _dataA!.OpenConnectionAsync();
        var owner = await conn.ExecuteScalarAsync<Guid>("INSERT INTO users(username,password_hash) VALUES (@name,'unused') RETURNING id",new { name=Guid.NewGuid().ToString() });
        var bot = await conn.ExecuteScalarAsync<Guid>("INSERT INTO bots(owner_id,name,token_hash) VALUES (@owner,'speed','unused') RETURNING id",new { owner });
        var id = await conn.ExecuteScalarAsync<Guid>("INSERT INTO conversations(bot_id) VALUES (@bot) RETURNING id",new { bot });
        var clientId=Guid.NewGuid(); var args=new { messageId=clientId, clientId, id, content="hello", metadata="{}", replyTo=(Guid?)null };
        Assert.Equal(clientId,await conn.ExecuteScalarAsync<Guid?>(MessageAcceptance.InsertSql,args));
        Assert.Null(await conn.ExecuteScalarAsync<Guid?>(MessageAcceptance.InsertSql,args));
        Assert.Equal(clientId.ToString(),await conn.ExecuteScalarAsync<string>("SELECT metadata->>'client_id' FROM messages WHERE id=@clientId",new {clientId}));
        var log=new SseLog(); var frame=log.Append(JsonSerializer.Serialize(MessageAcceptance.Started(bot,Guid.NewGuid(),clientId,clientId)));
        using var evt=JsonDocument.Parse(Assert.Single(log.After(0)).Data);
        Assert.Equal("task.started",evt.RootElement.GetProperty("type").GetString()); Assert.Equal(clientId,evt.RootElement.GetProperty("client_id").GetGuid());
    }
    [PostgresFact]
    public async Task Event_projection_carries_scoped_task_message_bot_and_approval_patches()
    {
        await using var conn = await _dataA!.OpenConnectionAsync();
        var owner=await conn.ExecuteScalarAsync<Guid>("INSERT INTO users(username,password_hash) VALUES(@name,'unused') RETURNING id",new{name=Guid.NewGuid().ToString()});
        var bot=await conn.ExecuteScalarAsync<Guid>("INSERT INTO bots(owner_id,name,token_hash) VALUES(@owner,'speed','unused') RETURNING id",new{owner});
        var conversation=await conn.ExecuteScalarAsync<Guid>("INSERT INTO conversations(bot_id) VALUES(@bot) RETURNING id",new{bot});
        var clientId=Guid.NewGuid();
        await conn.ExecuteAsync(MessageAcceptance.InsertSql,new {messageId=clientId,clientId,id=conversation,content="hello",metadata="{}",replyTo=(Guid?)null});
        var task=await conn.ExecuteScalarAsync<Guid>("INSERT INTO tasks(bot_id,conversation_id,title,instruction,source_message_id,status) VALUES(@bot,@conversation,'speed','do it',@clientId,'queued') RETURNING id",new{bot,conversation,clientId});
        var evt=await EventProjection.Enrich(_dataA,MessageAcceptance.Started(bot,task,clientId,clientId));
        Assert.Equal(owner.ToString(),evt["ownerId"]!.ToString()); Assert.Equal("queued",evt["task"]!["status"]!.ToString());
        Assert.Equal(clientId.ToString(),evt["messages"]![0]!["clientId"]!.ToString()); Assert.Equal("speed",evt["bot"]!["name"]!.ToString());
        await conn.ExecuteAsync("INSERT INTO messages(conversation_id,role,content,task_id) VALUES(@conversation,'assistant',@content,@task)",new{conversation,task,content="Card 4242424242424242"});
        var done=await EventProjection.Enrich(_dataA,new{type="task",taskId=task,status="completed"});
        Assert.DoesNotContain("4242424242424242",done.ToJsonString()); Assert.Contains("[REDACTED]",done.ToJsonString());
        var approval=await EventProjection.Enrich(_dataA,new{type="approval",taskId=task}); Assert.NotNull(approval["approvals"]);
        var unknown=await EventProjection.Enrich(_dataA,new{type="bot_thread",detail="private"}); Assert.DoesNotContain("private",unknown.ToJsonString());
    }

    [PostgresFact]
    public async Task Parallel_read_audit_steps_keep_unique_sequence_and_checkpoint_count()
    {
        await using var conn = await _dataA!.OpenConnectionAsync();
        var owner=await conn.ExecuteScalarAsync<Guid>("INSERT INTO users(username,password_hash) VALUES(@name,'unused') RETURNING id",new{name=Guid.NewGuid().ToString()});
        var bot=await conn.ExecuteScalarAsync<Guid>("INSERT INTO bots(owner_id,name,token_hash) VALUES(@owner,'speed','unused') RETURNING id",new{owner});
        var task=await conn.ExecuteScalarAsync<Guid>("INSERT INTO tasks(bot_id,title,instruction,status,lease_epoch) VALUES(@bot,'reads','reads','running',1) RETURNING id",new{bot});
        var platform=new Teammates.Api.Platform(_dataA,new byte[32],null!,null!,new Microsoft.Extensions.Configuration.ConfigurationBuilder().Build());
        var runtime=new Teammates.Api.Runtime(platform,null!);
        var step=typeof(Teammates.Api.Runtime).GetMethod("Step",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic)!;
        var args=JsonSerializer.SerializeToElement(new {path="/workspace/a"});
        await Task.WhenAll(Enumerable.Range(0,8).Select(_=>(Task)step.Invoke(runtime,[task,"read_file",args,"allow",true,new {ok=true},1])!));
        Assert.Equal(8,await conn.ExecuteScalarAsync<int>("SELECT count(DISTINCT seq)::int FROM task_steps WHERE task_id=@task",new{task}));
        Assert.Equal(8,await conn.ExecuteScalarAsync<int>("SELECT (checkpoint->>'stepsUsed')::int FROM tasks WHERE id=@task",new{task}));
    }

}
