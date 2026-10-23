using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Amazon.S3.Model;
using Dapper;
using Npgsql;
using Teammates.Compute;

namespace Teammates.Api;

public sealed class Runtime(Platform platform, LoginFlow logins)
{
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(90) };

    public async Task<IResult> Model(JsonElement body, CancellationToken ct)
    {
        var taskId = body.GetProperty("taskId").GetGuid();
        var botId = body.GetProperty("botId").GetGuid();
        var owner = await OwnerOf(botId);
        var messages = body.GetProperty("messages");
        var secret = await platform.Resolve(owner, "secret://openrouter/default", "model_gateway", botId, null, taskId, "model_gateway");
        if (secret == null)
            return Results.Json(new { status = "waiting_resource", reason = "connect_openrouter" });
        var key = Encoding.UTF8.GetString(secret);
        CryptographicOperations.ZeroMemory(secret);
        var redacted = RedactMessages(messages, key);
        var payload = ProviderWire.Completion(platform.ModelName, redacted, await ToolsFor(botId, ct));
        using var request = new HttpRequestMessage(HttpMethod.Post, platform.OpenRouterBase + "/chat/completions");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        request.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
        var started = DateTimeOffset.UtcNow;
        using var response = await _http.SendAsync(request, ct);
        var raw = await response.Content.ReadAsStringAsync(ct);
        key = "";
        if (!response.IsSuccessStatusCode)
        {
            await StoreModel(owner, botId, taskId, redacted, false, (int)(DateTimeOffset.UtcNow - started).TotalMilliseconds, default);
            return Results.Json(new { status = "error", error = "provider rejected the request" });
        }
        using var doc = JsonDocument.Parse(raw);
        var message = doc.RootElement.GetProperty("choices")[0].GetProperty("message");
        var normalized = ProviderWire.Normalize(message);
        var normalizedText = OutputRedactor.Redact(normalized.GetRawText(), []);
        await StoreModel(owner, botId, taskId, redacted, true, (int)(DateTimeOffset.UtcNow - started).TotalMilliseconds, ProviderWire.ReadUsage(doc.RootElement));
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        await conn.ExecuteAsync("UPDATE tasks SET model_calls = model_calls + 1, updated_at=now() WHERE id=@id", new { id = taskId });
        return Results.Text("{\"status\":\"ok\",\"message\":" + normalizedText + "}", "application/json");
    }

    public async Task<IResult> Authorize(JsonElement body, CancellationToken ct)
    {
        var taskId = body.GetProperty("taskId").GetGuid();
        var botId = body.GetProperty("botId").GetGuid();
        if (!await HoldsLease(taskId, EpochOf(body), ct)) return Results.StatusCode(409);
        var tool = body.GetProperty("tool").GetString() ?? "";
        var args = body.GetProperty("args");
        if (tool == "update_routine" && await BotMessaging.UpdateBlocked(platform, await OwnerOf(botId), botId, taskId, args, ct) is { } blocked)
            return Results.Json(new { decision = "deny", ok = false, reason = blocked, riskClass = ActionClasses.BotManage });
        var gated = await Gate(botId, taskId, tool, args, false, ct);
        if (gated.Decision == PolicyEngine.Deny)
        {
            await platform.Audit("policy", "tool.denied", botId, taskId, new { tool, reason = gated.Reason, riskClass = gated.RiskClass });
            return Results.Json(new { decision = "deny", ok = false, reason = gated.Reason, riskClass = gated.RiskClass });
        }
        if (gated.Decision == PolicyEngine.Ask && !await ConsumeApproval(taskId, tool))
        {
            if (!await CreateApproval(botId, taskId, tool, TargetOf(args), args, gated.Summary, gated.RiskClass, gated.Summary, EpochOf(body), ct))
                return Results.StatusCode(409);
            return Results.Json(new { decision = "ask", status = "waiting_approval", riskClass = gated.RiskClass, summary = gated.Summary });
        }
        if (tool == "browser_open" && Uri.TryCreate(Arg(args, "url"), UriKind.Absolute, out var uri))
        {
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            await conn.ExecuteAsync("INSERT INTO task_browser_origins (task_id, origin) VALUES (@task, @origin) ON CONFLICT DO NOTHING", new { task = taskId, origin = uri.GetLeftPart(UriPartial.Authority) });
        }
        return Results.Json(new { decision = "allow" });
    }

    public async Task<IResult> Execute(JsonElement body, CancellationToken ct)
    {
        var taskId = body.GetProperty("taskId").GetGuid();
        var botId = body.GetProperty("botId").GetGuid();
        var tool = body.GetProperty("tool").GetString() ?? "";
        // Reactions are recorded after a task has finished. They do not drive the computer.
        if (tool != "react_to_message" && !await HoldsLease(taskId, EpochOf(body), ct)) return Results.StatusCode(409);
        var args = body.GetProperty("args");
        var invalid = ToolSchema.Validate(tool, args);
        if (invalid != null)
        {
            await Step(taskId, tool, args, "invalid", false, new { reason = invalid });
            return Results.Json(new { ok = false, status = "invalid", reason = invalid });
        }
        var owner = await OwnerOf(botId);
        if (tool == "update_routine" && await BotMessaging.UpdateBlocked(platform, owner, botId, taskId, args, ct) is { } blocked)
        {
            await Step(taskId, tool, args, "deny", false, new { reason = blocked, riskClass = ActionClasses.BotManage });
            return Results.Json(new { ok = false, status = "denied", reason = blocked, riskClass = ActionClasses.BotManage });
        }
        var gated = await Gate(botId, taskId, tool, args, false, ct);
        var decision = gated.Decision;
        if (decision == PolicyEngine.Deny)
        {
            if (Arg(args, "command").Contains("secret://", StringComparison.Ordinal) || Arg(args, "secret_ref").Length > 0)
                await platform.SecretEvent(null, "secret.denied", "policy", botId, taskId, tool, Arg(args, "url"), "deny", gated.Reason);
            await platform.Audit("policy", "tool.denied", botId, taskId, new { tool, reason = gated.Reason, riskClass = gated.RiskClass });
            await Step(taskId, tool, args, decision, false, new { reason = gated.Reason, riskClass = gated.RiskClass });
            return Results.Json(new { ok = false, status = "denied", reason = gated.Reason, riskClass = gated.RiskClass });
        }
        if (decision == PolicyEngine.Ask && !await ConsumeApproval(taskId, tool))
        {
            if (!await CreateApproval(botId, taskId, tool, TargetOf(args), args, gated.Summary, gated.RiskClass, gated.Summary, EpochOf(body), ct))
                return Results.StatusCode(409);
            return Results.Json(new { ok = false, status = "waiting_approval", riskClass = gated.RiskClass, summary = gated.Summary });
        }
        if (decision == PolicyEngine.Ask) decision = PolicyEngine.Allow;
        try
        {
            var output = await Dispatch(owner, botId, taskId, tool, args, ct);
            if (tool.StartsWith("computer_", StringComparison.Ordinal) || tool.StartsWith("record_", StringComparison.Ordinal))
            {
                using var result = JsonDocument.Parse(JsonSerializer.Serialize(output));
                if (result.RootElement.TryGetProperty("ok", out var success) && success.ValueKind == JsonValueKind.False)
                {
                    await Step(taskId, tool, args, decision, false, output);
                    return Results.Json(output);
                }
            }
            if (tool == "react_to_message")
            {
                var json = JsonSerializer.Serialize(output);
                using var parsed = JsonDocument.Parse(json);
                var ok = parsed.RootElement.TryGetProperty("ok", out var flag) && flag.ValueKind == JsonValueKind.True;
                await Step(taskId, tool, args, decision, ok, output);
                return Results.Json(output);
            }
            await Step(taskId, tool, args, decision, true, output);
            return Results.Json(new { ok = true, output });
        }
        catch (ToolHalt halt)
        {
            await Step(taskId, tool, args, decision, false, new { halt.Status, halt.Reason });
            return Results.Json(new { ok = false, status = halt.Status, reason = halt.Reason });
        }
        catch (ComputeException ex) when (ex.IsRecovering)
        {
            return Results.Json(new { error = ComputeException.RecoveringMessage }, statusCode: 503);
        }
        catch (ComputeException ex) when (ex.Code == ComputeErrorCode.PermissionDenied)
        {
            await Step(taskId, tool, args, decision, false, new { reason = ex.Message });
            return Results.Json(new { ok = false, status = "denied", reason = ex.Message });
        }
    }

    public async Task<IResult> Observe(JsonElement body, CancellationToken ct)
    {
        var taskId = body.GetProperty("taskId").GetGuid();
        var botId = body.GetProperty("botId").GetGuid();
        var epoch = EpochOf(body);
        if (!await HoldsLease(taskId, epoch, ct)) return Results.StatusCode(409);
        var tool = body.GetProperty("tool").GetString() ?? "browser";
        var output = body.GetProperty("output");
        var redacted = InjectionFilter.ScrubJson(output.GetRawText());
        await Step(taskId, tool, body.TryGetProperty("args", out var args) ? args : default, PolicyEngine.Allow, true, JsonDocument.Parse(redacted).RootElement);
        if (output.TryGetProperty("targetId", out var target) && target.GetString() is { Length: > 0 } targetId)
        {
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            await conn.ExecuteAsync(
                """
                INSERT INTO browser_pages (bot_id, task_id, target_id, url, title, updated_at)
                VALUES (@bot, @task, @target, @url, @title, now())
                ON CONFLICT (bot_id, target_id) DO UPDATE SET url=EXCLUDED.url, title=EXCLUDED.title, task_id=EXCLUDED.task_id, updated_at=now()
                """,
                new
                {
                    bot = botId,
                    task = taskId,
                    target = targetId,
                    url = output.TryGetProperty("url", out var url) ? url.GetString() : "",
                    title = output.TryGetProperty("title", out var title) ? title.GetString() : ""
                });
        }
        var attention = output.TryGetProperty("attention", out var flag) && flag.ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(flag.GetString());
        if (attention)
        {
            if (!await SetTask(taskId, "waiting_human", "captcha_or_mfa", clearLease: true, epoch, ct))
                return Results.StatusCode(409);
            return Results.Json(new { status = "needs_human", reason = "captcha_or_mfa" });
        }
        return Results.Json(new { status = "ok" });
    }

    private async Task<object> Dispatch(Guid owner, Guid botId, Guid taskId, string tool, JsonElement args, CancellationToken ct)
    {
        if (BotMessaging.IsTool(tool)) return await BotMessaging.Run(platform, owner, botId, taskId, tool, args, ct);
        var placement = await platform.PlacementForBot(botId, ct);
        var computer = placement.Computer;
        switch (tool)
        {
            case "computer_screenshot":
            case "computer_click":
            case "computer_type":
            case "computer_key":
            case "computer_scroll":
            case "record_start":
            case "record_stop":
                return await ComputerTools.Run(platform, botId, taskId, computer, placement.Desktop, tool, args, ct);
            case "write_file":
                await Run(computer, botId, ["python3", "-c", BotFs.Script("write_file(sys.argv[1], sys.argv[2])"), Arg(args, "path"), Arg(args, "content")], null, ct);
                return new { ok = true, path = Arg(args, "path") };
            case "read_file":
            {
                var (code, stdout, _) = await Run(computer, botId, ["python3", "-c", BotFs.Script("read_file(sys.argv[1])"), Arg(args, "path")], null, ct);
                if (code == 2) return new { ok = false, reason = "not_found", path = Arg(args, "path") };
                if (code != 0) return new { ok = false, reason = "read_failed", path = Arg(args, "path") };
                return new { path = Arg(args, "path"), content = OutputRedactor.Redact(stdout) };
            }
            case "edit_file":
                await Run(computer, botId, ["python3", "-c", BotFs.Script("edit_file(sys.argv[1], sys.argv[2], sys.argv[3])"), Arg(args, "path"), Arg(args, "search"), Arg(args, "replace")], null, ct);
                return new { ok = true, path = Arg(args, "path") };
            case "delete_file":
                return await DeleteFile(owner, botId, taskId, computer, args, ct);
            case "plan_set":
            case "plan_update":
            case "git_status":
            case "git_diff":
            case "git_commit":
            case "run_tests":
            case "create_pr":
            case "watch_ci":
            case "spawn_child_task":
            case "child_status":
                return await CodingTools.Run(platform, botId, taskId, tool, args,
                    argv => Run(computer, botId, argv, null, ct), ct);
            case "shell":
            {
                var command = Arg(args, "command");
                var (code, stdout, stderr) = await Run(computer, botId, BotFs.ShellArgs(command), null, ct);
                return new { exitCode = code, stdout = OutputRedactor.Redact(stdout), stderr = OutputRedactor.Redact(stderr) };
            }
            case "setup_env":
                return await Setup(owner, botId, taskId, computer, args, ct);
            case "type_secret":
                return await TypeSecret(owner, botId, taskId, computer, args, ct);
            case "ask_user":
                return await AskUser(botId, taskId, args);
            case "save_memory":
                return await SaveMemory(botId, taskId, Arg(args, "content"), Arg(args, "source"));
            case "forget_memory":
                return await ForgetMemory(botId, taskId, Arg(args, "content"));
            case "search_memory":
                return await SearchMemory(botId, Arg(args, "query"));
            case "save_artifact":
                return await SaveArtifact(botId, taskId, computer, Arg(args, "name"), Arg(args, "path"), ct);
            case "request_secret":
                return await RequestSecret(owner, botId, taskId, args);
            case "request_login":
                return await logins.Handle(owner, botId, taskId, args, ct);
            case "search_tools":
                return await PluginCatalog.SearchTools(platform, botId, Arg(args, "query"), ct);
            case "load_tool":
                return await PluginCatalog.LoadTool(platform, botId, Arg(args, "name"), ct);
            case "send_message":
                return await OutboundLog.Run(platform, owner, botId, taskId, tool, ActionClasses.SendMessage, args, () => SendMessage(botId, taskId, args), ct);
            case "external_post":
                return await OutboundLog.Run(platform, owner, botId, taskId, tool, ActionClasses.ExternalPost, args, () => Task.FromResult<object>(new { delivered = false, held = true }), ct);
            case "react_to_message":
                return await Reactions.BotTool(platform, botId, Arg(args, "message_id").Length > 0 ? Arg(args, "message_id") : Arg(args, "messageId"), Arg(args, "emoji"));
            default:
                if (PluginIds.IsPluginTool(tool))
                    return await PluginCatalog.InvokeEnabled(platform, owner, botId, taskId, tool, args, ct);
                throw new ToolHalt("denied", "unknown tool");
        }
    }

    private async Task<object> Setup(Guid owner, Guid botId, Guid taskId, ComputerId computer, JsonElement args, CancellationToken ct)
    {
        var reference = Arg(args, "secret_ref");
        var command = Arg(args, "command");
        var envName = Arg(args, "env_name");
        if (command.Contains("secret://", StringComparison.Ordinal))
            throw new ToolHalt("denied", "denied_by_policy");
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var domains = await conn.QuerySingleOrDefaultAsync<string[]>("SELECT allowed_domains FROM secrets WHERE owner_user_id=@owner AND provider=@p AND name=@n", new { owner, p = SecretRef.TryParse(reference, out var p, out var n) ? p : "", n }) ?? [];
        if (domains.Length == 0 && (command.Contains("http://", StringComparison.Ordinal) || command.Contains("https://", StringComparison.Ordinal)))
            throw new ToolHalt("denied", "domain_not_allowed");
        var resolved = await platform.ResolveDetailed(owner, reference, "setup_env", botId, null, taskId, "setup_runner");
        if (resolved.Value == null) throw new ToolHalt("denied", resolved.Deny ?? "denied");
        var secret = resolved.Value;
        var value = Encoding.UTF8.GetString(secret);
        CryptographicOperations.ZeroMemory(secret);
        if (command.Contains(value, StringComparison.Ordinal))
        {
            value = "";
            throw new ToolHalt("denied", "command contains a resolved secret");
        }
        var (code, stdout, stderr) = await Run(computer, botId, BotFs.ShellArgs(command), new Dictionary<string, string> { [envName] = value }, ct, [new SecretEnvBinding(envName, reference, botId.ToString())]);
        value = "";
        return new { exitCode = code, stdout, stderr };
    }

    private async Task<object> TypeSecret(Guid owner, Guid botId, Guid taskId, ComputerId computer, JsonElement args, CancellationToken ct)
    {
        var reference = Arg(args, "secret_ref");
        var selector = Arg(args, "selector");
        if (string.IsNullOrWhiteSpace(selector)) selector = "#password";
        var target = Arg(args, "targetId");
        var desktop = (await platform.PlacementForBot(botId, ct)).Desktop;
        var inspectBody = JsonSerializer.Serialize(new { targetId = target, selector });
        var inspect = await platform.Compute.ControlAsync(computer, $"/desktops/{desktop}/browser/inspect", inspectBody, ct);
        using var doc = JsonDocument.Parse(inspect);
        var origin = doc.RootElement.TryGetProperty("frameOrigin", out var frame) ? frame.GetString() ?? "" : "";
        if (!doc.RootElement.TryGetProperty("elementOk", out var ok) || ok.ValueKind != JsonValueKind.True)
            throw new ToolHalt("denied", "element_invalid");
        var resolved = await platform.ResolveDetailed(owner, reference, "browser.type_secret", botId, origin, taskId, "browser");
        if (resolved.Value == null) throw new ToolHalt("denied", resolved.Deny ?? "denied");
        var secret = resolved.Value;
        var value = Encoding.UTF8.GetString(secret);
        CryptographicOperations.ZeroMemory(secret);
        var payload = JsonSerializer.Serialize(new { targetId = target, selector, value, expectedOrigin = origin });
        value = "";
        var typed = await platform.Compute.ControlAsync(computer, $"/desktops/{desktop}/browser/type-secret", payload, ct);
        using var result = JsonDocument.Parse(typed);
        var success = result.RootElement.TryGetProperty("ok", out var flag) && flag.ValueKind == JsonValueKind.True;
        if (!success)
        {
            var reason = result.RootElement.TryGetProperty("reason", out var why) ? why.GetString() : "inject_failed";
            throw new ToolHalt("denied", reason ?? "inject_failed");
        }
        return new { ok = true };
    }

    private async Task<object> SaveMemory(Guid botId, Guid taskId, string content, string source)
    {
        if (Dlp.HasStrict(content) || content.Contains("secret://", StringComparison.Ordinal))
            throw new ToolHalt("denied", "credential_shaped_memory");
        var vector = Embedder.VectorLiteral(content);
        await using var conn = await platform.Data.OpenConnectionAsync();
        var id = await conn.ExecuteScalarAsync<Guid>(
            "INSERT INTO memories (bot_id, content, source, importance, embedding) VALUES (@bot, @content, @source, 0.6, @emb::vector) RETURNING id",
            new { bot = botId, content, source = await MemoryProvenance(conn, taskId, source), emb = vector });
        await PostNotice(botId, taskId, "saved", content);
        return new { id, saved = true };
    }

    /// <summary>Where a remembered fact came from: the user's chat message or the peer thread message, else the agent itself.</summary>
    private static async Task<string> MemoryProvenance(Npgsql.NpgsqlConnection conn, Guid taskId, string claimed)
    {
        var peer = await conn.ExecuteScalarAsync<Guid?>("SELECT id FROM bot_thread_messages WHERE delivered_task_id=@t ORDER BY seq LIMIT 1", new { t = taskId });
        if (peer != null) return "message:" + peer.Value;
        var message = await conn.ExecuteScalarAsync<Guid?>("SELECT source_message_id FROM tasks WHERE id=@t", new { t = taskId });
        if (message != null) return "message:" + message.Value;
        return string.IsNullOrWhiteSpace(claimed) ? "agent" : claimed;
    }

    private async Task<object> ForgetMemory(Guid botId, Guid taskId, string content)
    {
        if (string.IsNullOrWhiteSpace(content)) throw new ToolHalt("denied", "forget_memory needs the fact");
        await using var conn = await platform.Data.OpenConnectionAsync();
        var removed = await conn.ExecuteAsync("DELETE FROM memories WHERE bot_id=@bot AND content=@content", new { bot = botId, content });
        if (removed == 0) throw new ToolHalt("denied", "memory not found");
        await PostNotice(botId, taskId, "forgot", content);
        return new { ok = true, forgotten = true };
    }

    private async Task PostNotice(Guid botId, Guid taskId, string action, string content)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        var conversation = await conn.ExecuteScalarAsync<Guid?>("SELECT conversation_id FROM tasks WHERE id=@id", new { id = taskId });
        if (conversation == null) return;
        var body = JsonSerializer.Serialize(new { type = "memory", action, content });
        await conn.ExecuteAsync(
            "INSERT INTO messages (conversation_id, role, kind, content, task_id) VALUES (@conversation, 'assistant', 'memory', @content, @task)",
            new { conversation, content = body, task = taskId });
        await platform.Publish(new { type = "task", taskId, botId });
    }

    private async Task<object> AskUser(Guid botId, Guid taskId, JsonElement args)
    {
        var prompt = Arg(args, "prompt").Trim();
        if (prompt.Length == 0) prompt = Arg(args, "question").Trim();
        if (prompt.Length == 0) throw new ToolHalt("invalid", "ask_user requires prompt");
        if (prompt.Length > 280) prompt = prompt[..280];
        var options = ReadOptions(args);
        if (options.Count is < 1 or > 6) throw new ToolHalt("invalid", "ask_user options needs at least 1 item");
        var multiple = Flag(args, "multiple") || Flag(args, "multi");
        var allowCustom = Flag(args, "allow_custom") || Flag(args, "allowCustom");
        await using var conn = await platform.Data.OpenConnectionAsync();
        var existing = await conn.QuerySingleOrDefaultAsync<(Guid Id, string Content)>(
            "SELECT id, content FROM messages WHERE task_id=@task AND kind='question' ORDER BY created_at DESC LIMIT 1",
            new { task = taskId });
        if (existing.Id != Guid.Empty && !string.IsNullOrWhiteSpace(existing.Content))
        {
            var prior = ReadAnswer(existing.Content);
            if (prior.Length > 0) return new { ok = true, answer = string.Join(", ", prior) };
            throw new ToolHalt("needs_human", "ask_user");
        }
        var card = JsonSerializer.Serialize(new
        {
            type = "question",
            prompt,
            options = options.Select(option => new { label = option.Label, style = option.Style }).ToArray(),
            multiple,
            allow_custom = allowCustom,
            answer = (string[]?)null
        });
        var conversation = await conn.ExecuteScalarAsync<Guid?>("SELECT conversation_id FROM tasks WHERE id=@id", new { id = taskId });
        if (conversation == null) throw new ToolHalt("denied", "task has no conversation");
        await conn.ExecuteAsync(
            "INSERT INTO messages (conversation_id, role, kind, content, task_id) VALUES (@conversation, 'assistant', 'question', @content, @task)",
            new { conversation, content = card, task = taskId });
        await platform.Publish(new { type = "task", taskId, botId });
        throw new ToolHalt("needs_human", "ask_user");
    }

    public async Task<IResult> AnswerQuestion(Guid owner, Guid messageId, JsonElement body)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        var row = await conn.QuerySingleOrDefaultAsync<(Guid Id, string Content, Guid? TaskId, string Kind)>(
            """
            SELECT m.id, m.content, m.task_id, m.kind
            FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            JOIN bots b ON b.id = c.bot_id
            WHERE m.id=@id AND b.owner_id=@owner
            """,
            new { id = messageId, owner });
        if (row.Id == Guid.Empty) return Results.NotFound();
        if (row.Kind != "question") return Results.BadRequest(new { error = "not a question" });
        if (ReadAnswer(row.Content).Length > 0) return Results.Json(new { error = "already answered" }, statusCode: 409);
        using var doc = JsonDocument.Parse(row.Content);
        var root = doc.RootElement;
        var labels = new List<string>();
        if (root.TryGetProperty("options", out var options) && options.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in options.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.String) labels.Add(item.GetString() ?? "");
                else if (item.ValueKind == JsonValueKind.Object && item.TryGetProperty("label", out var label) && label.ValueKind == JsonValueKind.String)
                    labels.Add(label.GetString() ?? "");
            }
        }
        var allowCustom = Flag(root, "allow_custom") || Flag(root, "allowCustom");
        var multiple = Flag(root, "multiple") || Flag(root, "multi");
        var choices = new List<string>();
        if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("choices", out var chosen) && chosen.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in chosen.EnumerateArray())
                if (item.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(item.GetString()))
                    choices.Add(item.GetString()!.Trim());
        }
        if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("choice", out var one) && one.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(one.GetString()))
            choices.Add(one.GetString()!.Trim());
        var custom = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("custom", out var customEl) && customEl.ValueKind == JsonValueKind.String
            ? (customEl.GetString() ?? "").Trim()
            : "";
        if (custom.Length > 280) custom = custom[..280];
        if (!multiple && choices.Count > 1) return Results.BadRequest(new { error = "pick one option" });
        foreach (var choice in choices)
            if (!labels.Contains(choice)) return Results.BadRequest(new { error = "unknown option" });
        if (custom.Length > 0 && !allowCustom) return Results.BadRequest(new { error = "custom answers are closed" });
        var answer = new List<string>(choices);
        if (custom.Length > 0) answer.Add(custom);
        if (!multiple && answer.Count != 1) return Results.BadRequest(new { error = "pick one option" });
        if (answer.Count == 0) return Results.BadRequest(new { error = "choose an option" });
        var node = JsonNode.Parse(row.Content)!.AsObject();
        var array = new JsonArray();
        foreach (var item in answer) array.Add(item);
        node["answer"] = array;
        var updated = node.ToJsonString();
        var text = string.Join(", ", answer);
        await using var tx = await conn.BeginTransactionAsync();
        var changed = await conn.ExecuteAsync("UPDATE messages SET content=@content WHERE id=@id AND content=@previous", new { id = messageId, content = updated, previous = row.Content }, tx);
        if (changed == 0)
        {
            await tx.RollbackAsync();
            return Results.Json(new { error = "already answered" }, statusCode: 409);
        }
        if (row.TaskId != null)
        {
            var calls = await conn.ExecuteScalarAsync<string?>("SELECT tool_calls::text FROM task_transcript WHERE task_id=@id AND role='assistant' ORDER BY seq DESC LIMIT 1", new { id = row.TaskId }, tx);
            var callId = ProviderWire.AskToolCallId(calls);
            if (!string.IsNullOrEmpty(callId))
            {
                var exists = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM task_transcript WHERE task_id=@id AND tool_call_id=@callId", new { id = row.TaskId, callId }, tx);
                if (exists == 0)
                {
                    var seq = await conn.ExecuteScalarAsync<int>("SELECT coalesce(max(seq), -1) + 1 FROM task_transcript WHERE task_id=@id", new { id = row.TaskId }, tx);
                    await conn.ExecuteAsync(
                        "INSERT INTO task_transcript (task_id, seq, role, content, tool_call_id, name) VALUES (@id, @seq, 'tool', @content, @callId, 'ask_user')",
                        new { id = row.TaskId, seq, callId, content = JsonSerializer.Serialize(new { ok = true, answer = text }) }, tx);
                }
            }
            var queued = await conn.ExecuteAsync(
                "UPDATE tasks SET status='queued', waiting_reason=NULL, lease_owner=NULL, lease_until=NULL, updated_at=now() WHERE id=@id AND status IN ('waiting_human', 'running')",
                new { id = row.TaskId }, tx);
            if (queued > 0) platform.Tasks.Pulse();
        }
        await tx.CommitAsync();
        await platform.Publish(new { type = "task", taskId = row.TaskId });
        return Results.Json(new { ok = true, answer = text });
    }

    private static string[] ReadAnswer(string content)
    {
        try
        {
            using var doc = JsonDocument.Parse(content);
            if (!doc.RootElement.TryGetProperty("answer", out var answer) || answer.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
                return [];
            if (answer.ValueKind == JsonValueKind.String)
                return string.IsNullOrWhiteSpace(answer.GetString()) ? [] : [answer.GetString()!.Trim()];
            if (answer.ValueKind == JsonValueKind.Array)
                return answer.EnumerateArray().Select(item => item.ValueKind == JsonValueKind.String ? item.GetString() ?? "" : "").Where(item => item.Length > 0).ToArray();
        }
        catch (JsonException)
        {
        }
        return [];
    }

    private static List<(string Label, string Style)> ReadOptions(JsonElement args)
    {
        if (args.ValueKind != JsonValueKind.Object || !args.TryGetProperty("options", out var options)) return [];
        if (options.ValueKind == JsonValueKind.String)
        {
            try
            {
                using var parsed = JsonDocument.Parse(string.IsNullOrWhiteSpace(options.GetString()) ? "[]" : options.GetString()!);
                return ReadOptionArray(args, parsed.RootElement);
            }
            catch (JsonException)
            {
                return [];
            }
        }
        return ReadOptionArray(args, options);
    }

    private static List<(string Label, string Style)> ReadOptionArray(JsonElement args, JsonElement options)
    {
        var styles = new List<string>();
        if (args.ValueKind == JsonValueKind.Object && args.TryGetProperty("styles", out var styleEl) && styleEl.ValueKind == JsonValueKind.Array)
            foreach (var item in styleEl.EnumerateArray())
                if (item.ValueKind == JsonValueKind.String) styles.Add(item.GetString() ?? "primary");
        var result = new List<(string Label, string Style)>();
        if (options.ValueKind != JsonValueKind.Array) return result;
        var index = 0;
        foreach (var item in options.EnumerateArray())
        {
            var style = index < styles.Count && styles[index].Equals("danger", StringComparison.OrdinalIgnoreCase) ? "danger" : "primary";
            var label = "";
            if (item.ValueKind == JsonValueKind.String) label = item.GetString() ?? "";
            else if (item.ValueKind == JsonValueKind.Object)
            {
                if (item.TryGetProperty("label", out var name) && name.ValueKind == JsonValueKind.String) label = name.GetString() ?? "";
                if (item.TryGetProperty("style", out var own) && own.ValueKind == JsonValueKind.String && own.GetString()!.Equals("danger", StringComparison.OrdinalIgnoreCase))
                    style = "danger";
            }
            label = label.Trim();
            if (label.Length > 0) result.Add((label, style));
            index++;
            if (result.Count == 6) break;
        }
        return result;
    }

    private static bool Flag(JsonElement args, string name)
    {
        if (args.ValueKind != JsonValueKind.Object || !args.TryGetProperty(name, out var value)) return false;
        if (value.ValueKind == JsonValueKind.True) return true;
        if (value.ValueKind == JsonValueKind.String)
        {
            var text = value.GetString() ?? "";
            return text.Equals("true", StringComparison.OrdinalIgnoreCase) || text == "1";
        }
        return false;
    }

    private async Task<object> SearchMemory(Guid botId, string query)
    {
        var vector = Embedder.VectorLiteral(query);
        await using var conn = await platform.Data.OpenConnectionAsync();
        var rows = await conn.QueryAsync(
            """
            SELECT content FROM memories
            WHERE bot_id=@bot
            ORDER BY ts_rank(to_tsvector('english', content), plainto_tsquery('english', @q)) DESC,
                     embedding <=> @emb::vector
            LIMIT 5
            """,
            new { bot = botId, q = query, emb = vector });
        return new { matches = rows.Select(row => (string)((IDictionary<string, object>)row)["content"]).ToArray() };
    }

    private async Task<object> SaveArtifact(Guid botId, Guid taskId, ComputerId computer, string name, string path, CancellationToken ct)
    {
        var (code, stdout, _) = await Run(computer, botId, ["python3", "-c", BotFs.Script("read_artifact(sys.argv[1])"), path], null, ct);
        if (code != 0) throw new ToolHalt("denied", "artifact unreadable");
        var bytes = Convert.FromBase64String(stdout.Trim());
        var text = OutputRedactor.Redact(Encoding.UTF8.GetString(bytes));
        var stored = Encoding.UTF8.GetBytes(text);
        var key = $"artifacts/{botId}/{Guid.NewGuid():n}/{name}";
        await platform.S3.PutObjectAsync(new PutObjectRequest { BucketName = platform.Bucket, Key = key, InputStream = new MemoryStream(stored), ContentType = "text/plain" }, ct);
        var sha = Convert.ToHexString(SHA256.HashData(stored)).ToLowerInvariant();
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var id = await conn.ExecuteScalarAsync<Guid>(
            "INSERT INTO artifacts (bot_id, task_id, name, mime, size_bytes, sha256, object_key) VALUES (@bot, @task, @name, 'text/plain', @size, @sha, @key) RETURNING id",
            new { bot = botId, task = taskId, name, size = stored.Length, sha, key });
        return new { id, name };
    }

    private async Task<object> RequestSecret(Guid owner, Guid botId, Guid taskId, JsonElement args)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        var id = await conn.ExecuteScalarAsync<Guid>(
            """
            INSERT INTO secret_requests (owner_user_id, bot_id, task_id, suggested_ref, type, reason, allowed_tools, allowed_domains)
            VALUES (@owner, @bot, @task, @reference, @type, @reason, @tools, @domains) RETURNING id
            """,
            new
            {
                owner, bot = botId, task = taskId,
                reference = Arg(args, "suggested_ref"),
                type = string.IsNullOrWhiteSpace(Arg(args, "type")) ? "GENERIC" : Arg(args, "type"),
                reason = Arg(args, "reason"),
                tools = new[] { Arg(args, "tool") },
                domains = Array.Empty<string>()
            });
        await platform.Publish(new { type = "secret_request", id });
        return new { status = "pending", requestId = id, secret_ref = Arg(args, "suggested_ref") };
    }

    public Task<(int Code, string Stdout, string Stderr)> Run(ComputerId id, Guid botId, IReadOnlyList<string> argv, IReadOnlyDictionary<string, string>? env, CancellationToken ct, IReadOnlyList<SecretEnvBinding>? secrets = null) =>
        RunConfined(id, botId, argv, env, secrets, TimeSpan.FromSeconds(40), 1_000_000, ct);

    private async Task<(int Code, string Stdout, string Stderr)> RunConfined(ComputerId id, Guid botId, IReadOnlyList<string> argv, IReadOnlyDictionary<string, string>? env, IReadOnlyList<SecretEnvBinding>? secrets, TimeSpan timeout, ulong maxOutput, CancellationToken ct)
    {
        var spec = await BotFs.ConfinedAsync(platform.Compute, id, botId, argv, env, secrets, timeout, maxOutput, ct);
        return await BotFs.Capture(platform.Compute, spec, ct);
    }

    private async Task<PolicyDecision> Gate(Guid botId, Guid taskId, string tool, JsonElement args, bool approved, CancellationToken ct)
    {
        var owner = await OwnerOf(botId);
        var seen = await Seen(taskId);
        var policy = await SecurityRoutes.Load(platform, owner);
        var rules = await SecurityRoutes.DenyRules(platform);
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var instruction = await conn.ExecuteScalarAsync<string>("SELECT instruction FROM tasks WHERE id=@id", new { id = taskId });
        var grants = (await conn.QueryAsync<string>("SELECT domain FROM credential_domain_grants WHERE owner_id=@owner", new { owner })).ToHashSet(StringComparer.OrdinalIgnoreCase);
        PluginCallHint? hint = null;
        if (PluginIds.IsPluginTool(tool)) hint = await PluginCatalog.Hint(platform, botId, tool, ct);
        var peerOrigin = await conn.ExecuteScalarAsync<bool>("SELECT (t.origin_thread_id IS NOT NULL OR t.origin_depth > 0 OR t.kind IN ('peer','peer_reply','peer_notice')) FROM tasks t WHERE t.id=@id", new { id = taskId });
        var decision = PolicyGate.Evaluate(tool, args, seen, policy, rules, instruction, approved, grants, hint, peerOrigin);
        if (decision.Decision != PolicyEngine.Deny && await TypeSecretOffDomain(conn, owner, tool, args))
            decision = decision with { Decision = PolicyEngine.Deny, Reason = "domain_not_allowed" };
        if (!policy.ModelAssist || ActionClassifier.IsBuiltIn(tool) || decision.HardDeny || decision.Decision == PolicyEngine.Deny)
            return decision;
        var label = await ClassifyWithModel(owner, botId, taskId, tool, args, ct);
        return PolicyGate.WithModelLabel(decision, label, policy);
    }

    private static async Task<bool> TypeSecretOffDomain(System.Data.IDbConnection conn, Guid owner, string tool, JsonElement args)
    {
        if (tool is not ("type_secret" or "browser.type_secret")) return false;
        var reference = Arg(args, "secret_ref");
        if (reference.Length == 0) reference = Arg(args, "secretRef");
        if (!SecretRef.TryParse(reference, out var provider, out var name)) return true;
        var domains = await conn.QuerySingleOrDefaultAsync<string[]>(
            "SELECT allowed_domains FROM secrets WHERE owner_user_id=@owner AND provider=@provider AND name=@name AND scope='USER'",
            new { owner, provider, name });
        if (domains == null) return true;
        return !DomainRules.Allows(domains, Arg(args, "url"));
    }

    private async Task<string?> ClassifyWithModel(Guid owner, Guid botId, Guid taskId, string tool, JsonElement args, CancellationToken ct)
    {
        var secret = await platform.Resolve(owner, "secret://openrouter/default", "model_gateway", botId, null, taskId, "policy");
        if (secret == null) return null;
        var key = Encoding.UTF8.GetString(secret);
        CryptographicOperations.ZeroMemory(secret);
        var keys = args.ValueKind == JsonValueKind.Object ? string.Join(',', args.EnumerateObject().Select(prop => prop.Name)) : "";
        var prompt = Dlp.Redact($"Classify this tool call. Reply with one of: read, write, send_message, payment, sign, delete, credential_use, external_post. Tool {tool}. Argument names {keys}.");
        try
        {
            var payload = JsonSerializer.Serialize(new
            {
                model = platform.ModelName,
                messages = new[] { new { role = "user", content = prompt } }
            });
            using var request = new HttpRequestMessage(HttpMethod.Post, platform.OpenRouterBase + "/chat/completions");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
            request.Content = new StringContent(payload, Encoding.UTF8, "application/json");
            using var response = await _http.SendAsync(request, ct);
            var raw = await response.Content.ReadAsStringAsync(ct);
            if (!response.IsSuccessStatusCode) return null;
            using var doc = JsonDocument.Parse(raw);
            var content = doc.RootElement.GetProperty("choices")[0].GetProperty("message").GetProperty("content").GetString();
            return Dlp.Redact(content);
        }
        catch
        {
            return null;
        }
        finally
        {
            key = "";
        }
    }

    private async Task<object> SendMessage(Guid botId, Guid taskId, JsonElement args)
    {
        var text = Dlp.Redact(Arg(args, "text"));
        await using var conn = await platform.Data.OpenConnectionAsync();
        var conversation = await conn.ExecuteScalarAsync<Guid>("SELECT conversation_id FROM tasks WHERE id=@id", new { id = taskId });
        await conn.ExecuteAsync("INSERT INTO messages (conversation_id, role, content) VALUES (@conversation, 'assistant', @text)", new { conversation, text });
        return new { sent = true, to = Dlp.Redact(Arg(args, "to")) };
    }

    private static string TargetOf(JsonElement args)
    {
        foreach (var name in new[] { "path", "url", "command", "to", "domain", "name" })
        {
            var value = Arg(args, name);
            if (value.Length > 0) return Dlp.Redact(value.Length > 180 ? value[..180] : value);
        }
        return "";
    }

    private async Task<bool> ConsumeApproval(Guid taskId, string tool)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        var id = await conn.ExecuteScalarAsync<Guid?>("SELECT id FROM approvals WHERE task_id=@task AND action=@tool AND status='approved' AND consumed_at IS NULL ORDER BY decided_at LIMIT 1", new { task = taskId, tool });
        if (id == null) return false;
        await conn.ExecuteAsync("UPDATE approvals SET consumed_at=now() WHERE id=@id", new { id });
        return true;
    }

    private async Task<bool> CreateApproval(Guid botId, Guid taskId, string tool, string target, JsonElement args, string reason, string riskClass, string summary, int epoch, CancellationToken ct)
    {
        if (!await HoldsLease(taskId, epoch, ct)) return false;
        var proposed = InjectionFilter.ScrubJson(args.ValueKind == JsonValueKind.Undefined ? "{}" : args.GetRawText());
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        await conn.ExecuteAsync(
            "INSERT INTO approvals (bot_id, task_id, action, target, proposed, reason, risk_class, summary) VALUES (@bot, @task, @tool, @target, @proposed::jsonb, @reason, @risk, @summary)",
            new { bot = botId, task = taskId, tool, target, proposed, reason, risk = riskClass, summary });
        var owner = await conn.ExecuteScalarAsync<Guid?>("SELECT owner_id FROM bots WHERE id=@id", new { id = botId });
        if (owner != null) await platform.Notify(owner.Value, "approval", "Approval needed", $"{tool} {target}".Trim());
        if (!await SetTask(taskId, "waiting_approval", tool, clearLease: true, epoch, ct))
            return false;
        await platform.Publish(new { type = "approval", taskId });
        try { await BotMessaging.OnApprovalCreated(platform, taskId, summary); }
        catch (Exception) { /* thread notices are best effort; the approval already exists */ }
        return true;
    }

    private async Task<bool> HoldsLease(Guid taskId, int epoch, CancellationToken ct)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var n = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM tasks WHERE id=@id AND status='running' AND lease_epoch=@epoch", new { id = taskId, epoch });
        return n == 1;
    }

    private static int EpochOf(JsonElement body) => body.TryGetProperty("epoch", out var epoch) && epoch.TryGetInt32(out var value) ? value : -1;

    private async Task<bool> SetTask(Guid taskId, string status, string? reason, bool clearLease, int epoch, CancellationToken ct)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var n = await conn.ExecuteAsync(
            clearLease
                ? "UPDATE tasks SET status=@status, waiting_reason=@reason, lease_owner=NULL, lease_until=NULL, updated_at=now() WHERE id=@id AND status='running' AND lease_epoch=@epoch"
                : "UPDATE tasks SET status=@status, waiting_reason=@reason, updated_at=now() WHERE id=@id AND status='running' AND lease_epoch=@epoch",
            new { id = taskId, status, reason, epoch });
        return n > 0;
    }

    private async Task Step(Guid taskId, string tool, JsonElement args, string policy, bool ok, object result)
    {
        var json = result is JsonElement element ? element.GetRawText() : JsonSerializer.Serialize(result);
        json = InjectionFilter.ScrubJson(json);
        await using var conn = await platform.Data.OpenConnectionAsync();
        var seq = await conn.ExecuteScalarAsync<int>("SELECT coalesce(max(seq),0)+1 FROM task_steps WHERE task_id=@id", new { id = taskId });
        var safeArgs = InjectionFilter.ScrubJson(args.ValueKind == JsonValueKind.Undefined ? "{}" : args.GetRawText());
        await conn.ExecuteAsync(
            "INSERT INTO task_steps (task_id, seq, tool, args, result, policy, ok, finished_at) VALUES (@task, @seq, @tool, @args::jsonb, @result::jsonb, @policy, @ok, now())",
            new { task = taskId, seq, tool, args = safeArgs, result = json, policy, ok });
        await conn.ExecuteAsync("UPDATE tasks SET last_progress_at=now(), blocked_reason=NULL, tests_passed_at=CASE WHEN @tool IN ('write_file','edit_file','delete_file') AND @ok THEN NULL ELSE tests_passed_at END WHERE id=@task", new { task = taskId, tool, ok });
    }

    public async Task RecoverOutbound(CancellationToken ct)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var rows = (await conn.QueryAsync<(string Key, Guid? Owner, Guid? Bot, Guid? TaskId, string Kind, string Tool, string Status, string Request)>(
            """
            SELECT idempotency_key, owner_user_id, bot_id, task_id, kind, tool, status, request::text
            FROM outbound_actions
            WHERE coalesce(request->>'surfaced','') <> 'true'
              AND (
                status = 'failed'
                OR (status = 'pending' AND created_at < now() - interval '90 seconds')
              )
            ORDER BY created_at
            LIMIT 4
            """)).ToList();
        foreach (var row in rows)
        {
            try
            {
                var current = await OutboundLog.ReadClaim(conn, row.Key);
                var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                if (current.Status is not ("pending" or "failed") || !OutboundRecovery.ClaimStale(current.Claim, platform.BootId, now))
                    continue;
                var stamp = platform.BootId + ":" + now;
                if (!await OutboundLog.TryClaim(conn, row.Key, current.Claim, stamp, ct))
                    continue;
                if (row.Kind == "delete")
                {
                    await SettleDelete(conn, row.Key, stamp, row.Bot, OutboundRecovery.PathOf(row.Request), null, ct);
                    continue;
                }
                var evidence = await Evidence(conn, row.Kind, row.TaskId, row.Request);
                var plan = OutboundRecovery.PlanAction(row.Kind, evidence);
                if (plan == "leave")
                {
                    await OutboundLog.ReleaseClaim(conn, row.Key, stamp);
                    continue;
                }
                if (plan == "complete")
                {
                    await OutboundLog.FinishKey(conn, row.Key, JsonSerializer.Serialize(new { ok = true, reconciled = "already_done" }));
                    continue;
                }
                if (plan == "retry")
                {
                    await RetrySafe(conn, row.Key, row.Kind, row.TaskId, row.Request);
                    continue;
                }
                await MarkUnconfirmed(conn, row.Key, row.Tool);
            }
            catch (Exception)
            {
                // The next tick claims again once this boot's stamp is stale.
            }
        }
    }

    private static async Task<string> Evidence(NpgsqlConnection conn, string kind, Guid? taskId, string request)
    {
        if (kind == "send")
        {
            var text = OutboundRecovery.TextOf(request, "text");
            if (taskId == null || string.IsNullOrEmpty(text)) return "unknown";
            var found = await conn.ExecuteScalarAsync<int>(
                """
                SELECT count(*) FROM messages m
                JOIN tasks t ON t.conversation_id = m.conversation_id
                WHERE t.id=@task AND m.role='assistant' AND m.content=@text
                """,
                new { task = taskId, text });
            return found > 0 ? "happened" : "missing";
        }
        if (kind == "post") return "missing";
        return "unknown";
    }

    private async Task RetrySafe(NpgsqlConnection conn, string key, string kind, Guid? taskId, string request)
    {
        if (kind == "send")
        {
            var text = Dlp.Redact(OutboundRecovery.TextOf(request, "text") ?? "");
            var to = Dlp.Redact(OutboundRecovery.TextOf(request, "to") ?? "");
            if (taskId == null || text.Length == 0)
            {
                await MarkUnconfirmed(conn, key, "send_message");
                return;
            }
            var again = await conn.ExecuteScalarAsync<int>(
                "SELECT count(*) FROM messages m JOIN tasks t ON t.conversation_id = m.conversation_id WHERE t.id=@task AND m.role='assistant' AND m.content=@text",
                new { task = taskId, text });
            if (again == 0)
            {
                var conversation = await conn.ExecuteScalarAsync<Guid?>("SELECT conversation_id FROM tasks WHERE id=@id", new { id = taskId });
                if (conversation == null)
                {
                    await MarkUnconfirmed(conn, key, "send_message");
                    return;
                }
                await conn.ExecuteAsync("INSERT INTO messages (conversation_id, role, content) VALUES (@conversation, 'assistant', @text)", new { conversation, text });
            }
            await OutboundLog.FinishKey(conn, key, JsonSerializer.Serialize(new { sent = true, to, reconciled = again > 0 ? "already_done" : "retried" }));
            return;
        }
        if (kind == "post")
        {
            await OutboundLog.FinishKey(conn, key, JsonSerializer.Serialize(new { delivered = false, held = true, reconciled = "recorded" }));
            return;
        }
        await MarkUnconfirmed(conn, key, kind);
    }

    private async Task MarkUnconfirmed(NpgsqlConnection conn, string key, string tool)
    {
        var owner = await conn.ExecuteScalarAsync<Guid?>("SELECT owner_user_id FROM outbound_actions WHERE idempotency_key=@key", new { key });
        await OutboundLog.Surface(conn, key);
        if (owner != null)
            await platform.Notify(owner.Value, "outbound.unconfirmed", "Outbound action was not confirmed", tool + " was not sent again");
    }

    private async Task<object> DeleteFile(Guid owner, Guid botId, Guid taskId, ComputerId computer, JsonElement args, CancellationToken ct)
    {
        var request = args.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null ? "{}" : Dlp.Redact(args.GetRawText());
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var begun = await OutboundLog.Begin(conn, owner, botId, taskId, "delete_file", ActionClasses.Delete, request, ct);
        if (begun.Action == "replay")
            return ReplayOf(begun.ResultJson);
        if (begun.Status == "failed")
            return new { replayed = true, status = "already_sent" };
        var key = OutboundLog.Key(taskId, "delete_file", request);
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var current = await OutboundLog.ReadClaim(conn, key);
        if (begun.Action != "execute" && !OutboundRecovery.ClaimStale(current.Claim, platform.BootId, now))
            return new { replayed = true, status = "already_sent" };
        var stamp = platform.BootId + ":" + now;
        if (!await OutboundLog.TryClaim(conn, key, current.Claim, stamp, ct))
            return new { replayed = true, status = "already_sent" };
        return await SettleDelete(conn, key, stamp, botId, Arg(args, "path"), computer, ct);
    }

    private async Task<object> SettleDelete(NpgsqlConnection conn, string key, string stamp, Guid? botId, string? path, ComputerId? known, CancellationToken ct)
    {
        if (botId == null || string.IsNullOrEmpty(path))
        {
            await MarkUnconfirmed(conn, key, "delete_file");
            return new { ok = false, reason = "not_a_file", path = path ?? "" };
        }
        string disk;
        ComputerId computer;
        try
        {
            computer = known ?? (await platform.PlacementForBot(botId.Value, ct)).Computer;
            var (code, stdout, _) = await Run(computer, botId.Value, ["python3", "-c", BotFs.Script("stat_file(sys.argv[1])"), path], null, ct);
            disk = code switch { 0 => "present", 2 => "absent", 3 => "directory", _ => "unavailable" };
            var word = (stdout ?? "").Trim();
            if (word is "present" or "absent" or "directory") disk = word;
        }
        catch (Exception)
        {
            return new { ok = false, reason = "computer_unavailable", path };
        }
        var plan = OutboundRecovery.Plan(disk, claimed: true);
        if (plan == "leave")
            return new { replayed = true, status = "already_sent" };
        if (plan == "mark")
        {
            await MarkUnconfirmed(conn, key, "delete_file");
            return new { ok = false, reason = "not_a_file", path };
        }
        if (plan == "unlink")
        {
            try
            {
                await Run(computer, botId.Value, ["python3", "-c", BotFs.Script("delete_file(sys.argv[1])"), path], null, ct);
            }
            catch (Exception)
            {
                await OutboundLog.ReleaseClaim(conn, key, stamp);
                throw;
            }
        }
        var output = new { ok = true, path, reconciled = plan == "unlink" ? "unlinked" : "already_gone" };
        await OutboundLog.FinishKey(conn, key, JsonSerializer.Serialize(output));
        return output;
    }

    private static object ReplayOf(string? json)
    {
        JsonElement output = default;
        if (!string.IsNullOrEmpty(json))
        {
            using var doc = JsonDocument.Parse(json);
            output = doc.RootElement.Clone();
        }
        return new { replayed = true, output };
    }

    private async Task StoreModel(Guid owner, Guid botId, Guid taskId, JsonElement prompt, bool ok, int latency, TokenUsage usage)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        await conn.ExecuteAsync(
            "INSERT INTO model_requests (owner_id, bot_id, task_id, provider, model, prompt_json) VALUES (@owner, @bot, @task, @provider, @model, @prompt::jsonb)",
            new { owner, bot = botId, task = taskId, provider = platform.LlmProvider, model = platform.ModelName, prompt = prompt.GetRawText() });
        await conn.ExecuteAsync(
            "INSERT INTO model_calls (bot_id, task_id, owner_id, role, provider, model, latency_ms, prompt_tokens, completion_tokens, ok, cost_usd) VALUES (@bot, @task, @owner, 'planner', @provider, @model, @latency, @promptTokens, @completionTokens, @ok, @cost)",
            new { bot = botId, task = taskId, owner, provider = platform.LlmProvider, model = platform.ModelName, latency, promptTokens = usage.PromptTokens, completionTokens = usage.CompletionTokens, ok, cost = usage.CostUsd });
    }

    private async Task<Guid> OwnerOf(Guid botId)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        return await conn.ExecuteScalarAsync<Guid>("SELECT owner_id FROM bots WHERE id=@id", new { id = botId });
    }

    private async Task<HashSet<string>> Seen(Guid taskId)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        var rows = await conn.QueryAsync<string>("SELECT origin FROM task_browser_origins WHERE task_id=@id", new { id = taskId });
        return rows.ToHashSet(StringComparer.OrdinalIgnoreCase);
    }

    private static JsonElement RedactMessages(JsonElement messages, string key)
    {
        var copy = JsonSerializer.Deserialize<JsonElement>(messages.GetRawText());
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartArray();
            foreach (var message in copy.EnumerateArray())
            {
                writer.WriteStartObject();
                foreach (var prop in message.EnumerateObject())
                {
                    if (prop.Name is "content" && prop.Value.ValueKind == JsonValueKind.String)
                        writer.WriteString(prop.Name, InjectionFilter.Strip(Dlp.Redact(OutputRedactor.Redact(prop.Value.GetString(), [key]))));
                    else
                        prop.WriteTo(writer);
                }
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
        }
        return JsonDocument.Parse(stream.ToArray()).RootElement;
    }

    private async Task<object[]> ToolsFor(Guid botId, CancellationToken ct)
    {
        var builtin = ToolDefinitions();
        var extra = await PluginCatalog.ModelTools(platform, botId, PluginLimits.MaxModelTools, ct);
        if (extra.Length == 0) return builtin;
        var merged = new object[builtin.Length + extra.Length];
        builtin.CopyTo(merged, 0);
        extra.CopyTo(merged, builtin.Length);
        return merged;
    }

    private static object[] ToolDefinitions() => ToolSchema.ForModel();

    private static string Arg(JsonElement args, string name) =>
        args.ValueKind == JsonValueKind.Object && args.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";

}
