using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Dapper;
using Npgsql;

namespace Teammates.Api;

public static class DeviceCommandState
{
    public static readonly string[] Terminal = ["completed", "failed", "expired", "cancelled"];
    public static bool CanTransition(string? from, string? to) => (from, to) switch
    {
        ("pending", "sent" or "expired" or "cancelled" or "failed") => true,
        ("sent", "approved" or "denied" or "expired" or "cancelled" or "failed") => true,
        ("approved", "running" or "failed" or "cancelled") => true,
        ("running", "completed" or "failed" or "cancelled") => true,
        _ => false
    };
    public static bool ValidCommand(string? command) => !string.IsNullOrWhiteSpace(command) && command.Length <= 4000;
    public static bool ValidCwd(string? cwd) => cwd == null || (cwd.Length <= 1000 && (Path.IsPathFullyQualified(cwd) || (cwd.Length >= 3 && char.IsAsciiLetter(cwd[0]) && cwd[1] == ':' && (cwd[2] == '\\' || cwd[2] == '/')) || cwd.StartsWith("\\\\", StringComparison.Ordinal)));
    public static int Timeout(int? timeoutSec) => Math.Clamp(timeoutSec ?? 60, 1, 600);
    public static bool ValidIncomingFrame(DeviceFrame f) => f.Type switch
    {
        "hello" => f.Version is { Length: > 0 and <= 40 } && f.Protocol == 1,
        "decision" => f.RequestId != null && (f.Decision is "approved" or "denied") && (f.Reason == null || f.Reason.Length <= 200),
        "result" => f.RequestId != null && f.ExitCode != null && f.Stdout is { Length: <= 65536 } && f.Stderr is { Length: <= 65536 } && f.Truncated != null && f.DurationMs >= 0 && f.TimedOut != null,
        "pong" => true,
        _ => true
    };
    public static bool ValidFrame(ReadOnlySpan<byte> utf8, out JsonDocument? doc)
    {
        doc = null;
        if (utf8.Length == 0 || utf8.Length > 256 * 1024) return false;
        try
        {
            doc = JsonDocument.Parse(utf8.ToArray());
            return doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("type", out var type) && type.ValueKind == JsonValueKind.String;
        }
        catch (JsonException) { return false; }
    }
}

public sealed record DevicePermissions(string Execution, bool RouteTraffic, bool AllowFiles, bool AllowBrowser);
public sealed record DeviceFrame(string Type, string? Version = null, int? Protocol = null, Guid? RequestId = null,
    string? Decision = null, string? Reason = null, int? ExitCode = null, string? Stdout = null, string? Stderr = null,
    bool? Truncated = null, int? DurationMs = null, bool? TimedOut = null, string? Command = null,
    string? Cwd = null, int? TimeoutSec = null, DateTimeOffset? ExpiresAt = null,
    DevicePermissions? Permissions = null, string? Latest = null, string? MinCompatible = null);

public sealed class DeviceHub(NpgsqlDataSource data, Platform platform) : BackgroundService
{
    private readonly System.Collections.Concurrent.ConcurrentDictionary<Guid, WebSocket> _sockets = new();
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public bool IsOnline(Guid deviceId) => _sockets.TryGetValue(deviceId, out var ws) && ws.State == WebSocketState.Open;
    public async Task<bool> SendAsync(Guid deviceId, object frame, CancellationToken ct = default)
    {
        if (!_sockets.TryGetValue(deviceId, out var ws) || ws.State != WebSocketState.Open) return false;
        try
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(frame, Json);
            await ws.SendAsync(bytes, WebSocketMessageType.Text, true, ct);
            return true;
        }
        catch { Drop(deviceId, ws); return false; }
    }
    public async Task Connect(HttpContext ctx, Guid id)
    {
        var header = ctx.Request.Headers.Authorization.ToString();
        if (!header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) || header.Length > 100) { ctx.Response.StatusCode = 401; return; }
        await using var conn = await data.OpenConnectionAsync(ctx.RequestAborted);
        var row = await conn.QuerySingleOrDefaultAsync<DeviceConnection>("""SELECT d.owner_id AS OwnerId,d.execution AS Execution,d.route_traffic AS RouteTraffic,d.allow_files AS AllowFiles,d.allow_browser AS AllowBrowser FROM devices d WHERE d.id=@id AND d.token_hash=@hash""", new { id, hash = DeviceCredentials.Hash(header[7..]) });
        if (row == null) { ctx.Response.StatusCode = 401; return; }
        if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = 400; return; }
        using var socket = await ctx.WebSockets.AcceptWebSocketAsync();
        _sockets.AddOrUpdate(id, socket, (_, previous) => { try { previous.Abort(); } catch { } return socket; });
        await conn.ExecuteAsync("UPDATE devices SET last_seen=now() WHERE id=@id", new { id });
        await SendAsync(id, new { type="welcome", permissions = new DevicePermissions(row.Execution,row.RouteTraffic,row.AllowFiles,row.AllowBrowser), latest="0.4.0", minCompatible="0.4.0" }, ctx.RequestAborted);
        var buffer = new byte[16 * 1024];
        try
        {
            while (socket.State == WebSocketState.Open && !ctx.RequestAborted.IsCancellationRequested)
            {
                using var ms = new MemoryStream(); WebSocketReceiveResult result;
                do
                {
                    result = await socket.ReceiveAsync(buffer, ctx.RequestAborted);
                    if (result.MessageType == WebSocketMessageType.Close) return;
                    if (result.MessageType != WebSocketMessageType.Text || ms.Length + result.Count > 256 * 1024) { await socket.CloseAsync(WebSocketCloseStatus.MessageTooBig,"invalid frame",CancellationToken.None); return; }
                    ms.Write(buffer,0,result.Count);
                } while (!result.EndOfMessage);
                if (!DeviceCommandState.ValidFrame(ms.GetBuffer().AsSpan(0,(int)ms.Length),out var doc) || doc == null) { await socket.CloseAsync(WebSocketCloseStatus.InvalidPayloadData,"invalid frame",CancellationToken.None); return; }
                using (doc)
                {
                    DeviceFrame? frame;
                    try { frame = JsonSerializer.Deserialize<DeviceFrame>(doc.RootElement.GetRawText(), Json); }
                    catch (JsonException) { await socket.CloseAsync(WebSocketCloseStatus.InvalidPayloadData,"invalid frame",CancellationToken.None); return; }
                    if (frame == null || !DeviceCommandState.ValidIncomingFrame(frame) || !await HandleFrame(id,row.OwnerId,frame,ctx.RequestAborted)) { await socket.CloseAsync(WebSocketCloseStatus.PolicyViolation,"invalid frame",CancellationToken.None); return; }
                }
            }
        }
        catch (OperationCanceledException) { }
        catch (WebSocketException) { }
        finally { Drop(id,socket); }
    }
    private async Task<bool> HandleFrame(Guid deviceId, Guid ownerId, DeviceFrame f, CancellationToken ct)
    {
        await using var conn = await data.OpenConnectionAsync(ct);
        if (await conn.ExecuteAsync("UPDATE devices SET last_seen=now() WHERE id=@deviceId", new { deviceId }) == 0) return false;
        if (f.Type is not ("hello" or "decision" or "result" or "pong")) return true;
        if (f.Type is "hello" or "pong") return true;
        if (f.Type == "decision" && f.RequestId is Guid did && f.Decision is "approved" or "denied")
        {
            var target = f.Decision == "approved" ? "approved" : "denied";
            var changed = await conn.ExecuteAsync("UPDATE device_commands SET status=@target,decision_reason=@reason,decided_at=now() WHERE id=@did AND device_id=@deviceId AND status='sent'", new { target, reason = f.Reason, did, deviceId });
            if (changed == 0) return false;
            await platform.Audit("device:"+deviceId,"device.command_decided",null,null,new { deviceId, requestId=did, decision=target });
            return true;
        }
        if (f.Type == "result" && f.RequestId is Guid rid && f.ExitCode != null && f.Stdout is { Length: <= 65536 } && f.Stderr is { Length: <= 65536 } && f.Truncated != null && f.DurationMs >= 0 && f.TimedOut != null)
        {
            var changed = await conn.ExecuteAsync("UPDATE device_commands SET status='running' WHERE id=@rid AND device_id=@deviceId AND status='approved'", new { rid,deviceId });
            if (changed == 0) return false;
            await conn.ExecuteAsync("UPDATE device_commands SET status='completed',exit_code=@exitCode,stdout=@stdout,stderr=@stderr,truncated=@truncated,timed_out=@timedOut,duration_ms=@durationMs,finished_at=now() WHERE id=@rid AND device_id=@deviceId AND status='running'", new { rid,deviceId,f.ExitCode,f.Stdout,f.Stderr,f.Truncated,f.TimedOut,f.DurationMs });
            await platform.Audit("device:"+deviceId,"device.command_finished",null,null,new { deviceId, requestId=rid, exitCode=f.ExitCode, durationMs=f.DurationMs, timedOut=f.TimedOut });
            return true;
        }
        return false;
    }
    public void Revoke(Guid id) { if (_sockets.TryRemove(id,out var ws)) { try { ws.Abort(); } catch { } _ = FailCommands(id); } }
    private void Drop(Guid id, WebSocket ws) { if (_sockets.TryGetValue(id,out var current) && ReferenceEquals(current,ws)) { _sockets.TryRemove(id,out _); _ = FailAfterGrace(id); } }
    private async Task FailAfterGrace(Guid id) { await Task.Delay(TimeSpan.FromSeconds(90)); await FailCommands(id); }
    private async Task FailCommands(Guid id) { try { await using var c=await data.OpenConnectionAsync(); await c.ExecuteAsync("UPDATE device_commands SET status='failed',finished_at=now() WHERE device_id=@id AND status IN ('sent','approved','running')",new{id}); } catch { } }
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested) { try { await using var c=await data.OpenConnectionAsync(stoppingToken); await c.ExecuteAsync("UPDATE device_commands SET status='expired',finished_at=now() WHERE status IN ('pending','sent') AND expires_at<=now()"); } catch { } await Task.Delay(TimeSpan.FromSeconds(10),stoppingToken); }
    }
    private sealed record DeviceConnection(Guid OwnerId,string Execution,bool RouteTraffic,bool AllowFiles,bool AllowBrowser);
}

public static class DeviceCommandRoutes
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public sealed record Request(string? Command, string? Cwd, int? TimeoutSec);
    public static void Map(WebApplication app, Platform platform, DeviceHub hub)
    {
        app.MapGet("/api/devices/{id:guid}/connect", (HttpContext ctx, Guid id) => hub.Connect(ctx,id));
        async Task<Guid?> Owner(HttpContext ctx) { ctx.Request.Cookies.TryGetValue("teammates_session",out var token); var user=await platform.UserForSession(token); if(user==null)return null; await using var c=await platform.Data.OpenConnectionAsync(); return DeviceCredentials.OwnerOnly(await c.ExecuteScalarAsync<string>("SELECT role FROM users WHERE id=@user",new{user}))?user:null; }
        app.MapPost("/api/devices/{id:guid}/commands", async (HttpContext ctx, Guid id, Request body) =>
        {
            var owner=await Owner(ctx); if(owner==null)return Results.StatusCode(403);
            if(!DeviceCommandState.ValidCommand(body.Command)||!DeviceCommandState.ValidCwd(body.Cwd))return Results.BadRequest(new{error="Invalid command or working directory."});
            await using var c=await platform.Data.OpenConnectionAsync();
            var device=await c.QuerySingleOrDefaultAsync<(string Execution,Guid OwnerId)>("SELECT execution,owner_id AS OwnerId FROM devices WHERE id=@id",new{id}); if(device==default||device.OwnerId!=owner)return Results.NotFound();
            if(device.Execution=="off"||!hub.IsOnline(id))return Results.Conflict(new{error="Device execution is disabled or device is offline."});
            var cmdId=Guid.NewGuid(); var expiry=DateTimeOffset.UtcNow.AddSeconds(120); var timeout=DeviceCommandState.Timeout(body.TimeoutSec);
            await c.ExecuteAsync("INSERT INTO device_commands(id,device_id,owner_id,command,cwd,timeout_sec,requested_by,expires_at) VALUES(@cmdId,@id,@owner,@command,@cwd,@timeout,@requestedBy,@expiry)",new{cmdId,id,owner,command=body.Command!.Trim(),cwd=body.Cwd,timeout,requestedBy=owner.ToString(),expiry});
            await c.ExecuteAsync("UPDATE device_commands SET status='sent',sent_at=now() WHERE id=@cmdId AND status='pending'",new{cmdId});
            var sent=await hub.SendAsync(id,new{type="command",requestId=cmdId,command=body.Command!.Trim(),cwd=body.Cwd,timeoutSec=timeout,expiresAt=expiry},ctx.RequestAborted);
            if(!sent){await c.ExecuteAsync("UPDATE device_commands SET status='failed',finished_at=now() WHERE id=@cmdId",new{cmdId});return Results.Conflict();}
            await platform.Audit(owner.ToString()!,"device.command_requested",null,null,new{deviceId=id,requestId=cmdId});
            return Results.Json(new{id=cmdId,status="sent"},statusCode:202);
        });
        app.MapGet("/api/devices/{id:guid}/commands", async (HttpContext ctx,Guid id)=>{var owner=await Owner(ctx);if(owner==null)return Results.StatusCode(403);await using var c=await platform.Data.OpenConnectionAsync();if(await c.ExecuteScalarAsync<int>("SELECT count(*) FROM devices WHERE id=@id AND owner_id=@owner",new{id,owner})==0)return Results.NotFound();return Results.Json(await c.QueryAsync("SELECT id,command,cwd,timeout_sec AS \"timeoutSec\",status,decision_reason AS \"decisionReason\",exit_code AS \"exitCode\",left(stdout,2048) AS stdout,left(stderr,2048) AS stderr,truncated,timed_out AS \"timedOut\",duration_ms AS \"durationMs\",requested_by AS \"requestedBy\",created_at AS \"createdAt\",sent_at AS \"sentAt\",decided_at AS \"decidedAt\",finished_at AS \"finishedAt\",expires_at AS \"expiresAt\" FROM device_commands WHERE device_id=@id AND owner_id=@owner ORDER BY created_at DESC LIMIT 50",new{id,owner}));});
        app.MapGet("/api/devices/{id:guid}/commands/{rid:guid}",async(HttpContext ctx,Guid id,Guid rid)=>{var owner=await Owner(ctx);if(owner==null)return Results.StatusCode(403);await using var c=await platform.Data.OpenConnectionAsync();var row=await c.QuerySingleOrDefaultAsync("SELECT id,command,cwd,timeout_sec AS \"timeoutSec\",status,decision_reason AS \"decisionReason\",exit_code AS \"exitCode\",stdout,stderr,truncated,timed_out AS \"timedOut\",duration_ms AS \"durationMs\",requested_by AS \"requestedBy\",created_at AS \"createdAt\",sent_at AS \"sentAt\",decided_at AS \"decidedAt\",finished_at AS \"finishedAt\",expires_at AS \"expiresAt\" FROM device_commands WHERE id=@rid AND device_id=@id AND owner_id=@owner",new{id,rid,owner});return row==null?Results.NotFound():Results.Json(row);});
        app.MapPost("/api/devices/{id:guid}/commands/{rid:guid}/cancel",async(HttpContext ctx,Guid id,Guid rid)=>{var owner=await Owner(ctx);if(owner==null)return Results.StatusCode(403);await using var c=await platform.Data.OpenConnectionAsync();var status=await c.QuerySingleOrDefaultAsync<string>("SELECT status FROM device_commands WHERE id=@rid AND device_id=@id AND owner_id=@owner",new{id,rid,owner});if(status==null)return Results.NotFound();if(!DeviceCommandState.CanTransition(status,"cancelled"))return Results.Conflict();await c.ExecuteAsync("UPDATE device_commands SET status='cancelled',finished_at=now() WHERE id=@rid",new{rid});await hub.SendAsync(id,new{type="cancel",requestId=rid},ctx.RequestAborted);return Results.Json(new{id=rid,status="cancelled"});});
    }
}
