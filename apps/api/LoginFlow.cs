using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using Teammates.Compute;

namespace Teammates.Api;

public sealed class ToolHalt(string status, string? reason) : Exception(reason)
{
    public string Status { get; } = status;
    public string? Reason { get; } = reason;
}

public sealed class LoginFlow(Platform platform, LoginBroker broker)
{
    private static readonly HashSet<string> Kinds = new(StringComparer.Ordinal) { "username", "email", "password", "otp" };
    private static readonly JsonSerializerOptions Camel = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public async Task ExpirePending()
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        var rows = (await conn.QueryAsync<(Guid Id, Guid? TaskId)>("SELECT id, task_id FROM login_prompts WHERE status='pending' AND expires_at < now()")).ToArray();
        foreach (var row in rows)
        {
            await broker.DropAsync(row.Id);
            await conn.ExecuteAsync("UPDATE login_prompts SET status='expired' WHERE id=@id AND status='pending'", new { id = row.Id });
            if (row.TaskId != null)
            {
                await conn.ExecuteAsync("UPDATE tasks SET status='queued', waiting_reason=NULL, lease_owner=NULL, lease_until=NULL, updated_at=now() WHERE id=@id AND status='waiting_human' AND waiting_reason='login_form'", new { id = row.TaskId });
                platform.Tasks.Pulse();
            }
        }
    }

    public async Task<object> Handle(Guid owner, Guid botId, Guid taskId, JsonElement args, CancellationToken ct)
    {
        if (TryVaultRefs(args, out var refs))
        {
            await FillFromVault(owner, botId, taskId, args, refs, ct);
            return new { status = "filled" };
        }

        var domain = Arg(args, "domain").Trim().ToLowerInvariant();
        var url = Arg(args, "url").Trim();
        if (!LoginDomains.TryMatch(domain, url, out var why))
            throw new ToolHalt("denied", why);

        var row = await Latest(taskId);
        if (row == null)
        {
            await Create(owner, botId, taskId, domain, url, args);
            await Wait(taskId);
            throw new ToolHalt("waiting_human", "login_form");
        }
        if (row.Status == "pending")
        {
            if (row.ExpiresAt <= DateTimeOffset.UtcNow)
            {
                await broker.DropAsync(row.Id);
                await SetStatus(row.Id, "expired");
                return new { status = "expired" };
            }
            await Wait(taskId);
            throw new ToolHalt("waiting_human", "login_form");
        }
        if (row.Status == "submitted")
        {
            var submitted = await broker.TryTakeAsync(row.Id);
            var fields = submitted.Fields;
            if (fields == null)
            {
                await SetStatus(row.Id, "expired");
                return new { status = "expired" };
            }
            try
            {
                var attention = await TypeFields(botId, Arg(args, "targetId"), row.Url, row.Fields, row.SubmitSelector, fields, ct);
                await SetStatus(row.Id, "filled");
                if (attention)
                {
                    await WaitFor(taskId, "captcha_or_mfa");
                    throw new ToolHalt("waiting_human", "captcha_or_mfa");
                }
                return new { status = "filled" };
            }
            finally
            {
                foreach (var field in fields) field.Dispose();
            }
        }
        if (row.Status is "filled" or "expired" or "cancelled")
            return new { status = row.Status };
        throw new ToolHalt("denied", "login_unavailable");
    }

    public async Task<IResult> Accept(HttpContext ctx, Guid user, Guid id)
    {
        var rented = System.Buffers.ArrayPool<byte>.Shared.Rent(LoginBody.MaxBytes);
        try
        {
            var total = 0;
            while (total < rented.Length)
            {
                var read = await ctx.Request.Body.ReadAsync(rented.AsMemory(total, rented.Length - total));
                if (read == 0) break;
                total += read;
            }
            if (total == rented.Length && await ctx.Request.Body.ReadAsync(new byte[1]) > 0)
                return Results.Json(new { error = "body_too_large" }, statusCode: 413);
            if (!LoginBody.TryParse(rented.AsSpan(0, total), out var fields, out var save, out var error))
                return Results.BadRequest(new { error });
            try
            {
                return await AcceptFields(user, id, fields, save);
            }
            finally
            {
                foreach (var field in fields) field.Dispose();
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(rented);
            System.Buffers.ArrayPool<byte>.Shared.Return(rented);
        }
    }

    private async Task<IResult> AcceptFields(Guid user, Guid id, List<SecretField> fields, bool save)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        var row = await conn.QuerySingleOrDefaultAsync<PromptRow>(
            "SELECT id, owner_id, bot_id, task_id, domain, url, fields::text AS fields, submit_selector, status, expires_at FROM login_prompts WHERE id=@id",
            new { id });
        if (row == null || row.Id == Guid.Empty || row.OwnerId != user) return Results.NotFound();
        if (row.Status != "pending") return Results.Json(new { status = row.Status });
        if (row.ExpiresAt <= DateTimeOffset.UtcNow)
        {
            await broker.DropAsync(id);
            await SetStatus(id, "expired");
            return Results.Json(new { error = "expired" }, statusCode: 410);
        }
        await broker.HoldAsync(id, fields, save);
        try
        {
            var refs = save ? await SaveVault(user, row, fields) : new Dictionary<string, string>();
            await conn.ExecuteAsync(
                "UPDATE login_prompts SET status='submitted', vault_refs=@refs::jsonb WHERE id=@id AND status='pending'",
                new { id, refs = JsonSerializer.Serialize(refs) });
            await conn.ExecuteAsync("UPDATE tasks SET status='queued', waiting_reason=NULL, lease_owner=NULL, lease_until=NULL, updated_at=now() WHERE id=@id", new { id = row.TaskId });
            platform.Tasks.Pulse();
            await platform.Audit(user.ToString(), "login.submitted", row.BotId, row.TaskId, new { promptId = id, domain = row.Domain, saveToVault = save });
            return Results.Json(new { status = "accepted" });
        }
        catch (ToolHalt halt)
        {
            await broker.DropAsync(id);
            return Results.Json(new { error = halt.Reason ?? "denied" }, statusCode: 422);
        }
    }

    public async Task<IResult> Cancel(Guid user, Guid id)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        var row = await conn.QuerySingleOrDefaultAsync<(Guid Id, Guid OwnerId, Guid BotId, Guid? TaskId, string Status)>(
            "SELECT id, owner_id, bot_id, task_id, status FROM login_prompts WHERE id=@id", new { id });
        if (row.Id == Guid.Empty || row.OwnerId != user) return Results.NotFound();
        await broker.DropAsync(id);
        await SetStatus(id, "cancelled");
        if (row.TaskId != null)
        {
            await conn.ExecuteAsync("UPDATE tasks SET status='queued', waiting_reason=NULL, lease_owner=NULL, lease_until=NULL, updated_at=now() WHERE id=@id AND status='waiting_human'", new { id = row.TaskId });
            platform.Tasks.Pulse();
        }
        await platform.Audit(user.ToString(), "login.cancelled", row.BotId, row.TaskId, new { promptId = id });
        return Results.Json(new { status = "cancelled" });
    }

    private async Task<Dictionary<string, string>> SaveVault(Guid owner, PromptRow row, IReadOnlyList<SecretField> fields)
    {
        var refs = new Dictionary<string, string>();
        var origin = Origin(row.Url);
        foreach (var field in fields)
        {
            var reference = await Store(owner, row.Domain, origin, field.Kind, field.Value, row.BotId, row.TaskId);
            refs[field.Kind] = reference;
        }
        return refs;
    }

    private async Task<string> Store(Guid owner, string domain, string origin, string kind, byte[] value, Guid botId, Guid? taskId)
    {
        var provider = "login";
        var name = domain.Replace(':', '.') + "." + kind;
        if (!SecretRef.TryParse($"secret://{provider}/{name}", out _, out _))
            throw new ToolHalt("denied", "invalid_ref");
        var type = kind == "password" ? "PASSWORD" : "GENERIC";
        var tools = new[] { "browser.type_secret", "login.fill" };
        var domains = new[] { origin };
        await using var conn = await platform.Data.OpenConnectionAsync();
        var existing = await conn.QuerySingleOrDefaultAsync<(Guid Id, string Type, int KeyVersion)>(
            "SELECT id, type, key_version FROM secrets WHERE owner_user_id=@owner AND provider=@provider AND name=@name AND scope='USER'",
            new { owner, provider, name });
        if (existing.Id == Guid.Empty)
        {
            await platform.InsertSecretBytes(owner, provider, name, type, value, "Saved from a login form", tools, domains, [botId]);
            return $"secret://{provider}/{name}";
        }
        var (cipher, nonce) = KeyEncryption.Encrypt(platform.MasterKey, existing.Id, owner, existing.Type, existing.KeyVersion, value);
        await conn.ExecuteAsync(
            "UPDATE secrets SET ciphertext=@cipher, nonce=@nonce, allowed_tools=@tools, allowed_domains=@domains, allowed_bot_ids=@bots, revoked_at=NULL, updated_at=now() WHERE id=@id",
            new { id = existing.Id, cipher, nonce, tools, domains, bots = new[] { botId } });
        await platform.SecretEvent(existing.Id, "secret.rotated", "login", botId, taskId, "login.fill", origin, "allow", null);
        return $"secret://{provider}/{name}";
    }

    private async Task FillFromVault(Guid owner, Guid botId, Guid taskId, JsonElement args, Dictionary<string, string> refs, CancellationToken ct)
    {
        var domain = Arg(args, "domain");
        var url = Arg(args, "url");
        if (!LoginDomains.TryMatch(domain, url, out var why))
            throw new ToolHalt("denied", why);
        var defined = ParseFields(args);
        var values = new List<SecretField>();
        try
        {
            foreach (var pair in refs)
            {
                var resolved = await platform.ResolveDetailed(owner, pair.Value, "login.fill", botId, Origin(url), taskId, "login");
                if (resolved.Value == null) throw new ToolHalt("denied", resolved.Deny ?? "denied");
                values.Add(new SecretField(pair.Key, resolved.Value));
            }
            var attention = await TypeFields(botId, Arg(args, "targetId"), url, JsonSerializer.Serialize(defined, Camel), Arg(args, "submitSelector"), values, ct);
            if (attention)
            {
                await WaitFor(taskId, "captcha_or_mfa");
                throw new ToolHalt("waiting_human", "captcha_or_mfa");
            }
        }
        finally
        {
            foreach (var field in values) field.Dispose();
        }
    }

    private async Task<bool> TypeFields(Guid botId, string targetId, string url, string fieldsJson, string submit, IReadOnlyList<SecretField> values, CancellationToken ct)
    {
        var defined = JsonSerializer.Deserialize<List<LoginField>>(fieldsJson, Camel) ?? [];
        var placement = await platform.PlacementForBot(botId, ct);
        var expected = Origin(url);
        var inspectSelector = defined.FirstOrDefault(field => !string.IsNullOrWhiteSpace(field.Selector))?.Selector ?? "#password";
        var inspect = await platform.Compute.ControlAsync(placement.Computer, $"/desktops/{placement.Desktop}/browser/inspect", JsonSerializer.Serialize(new { targetId, selector = inspectSelector }), ct);
        using (var doc = JsonDocument.Parse(inspect))
        {
            var origin = doc.RootElement.TryGetProperty("frameOrigin", out var frame) ? frame.GetString() ?? "" : "";
            if (string.IsNullOrWhiteSpace(origin) || !origin.Equals(expected, StringComparison.OrdinalIgnoreCase) || CredentialSites.IsLookAlike(origin))
                throw new ToolHalt("denied", "domain_not_allowed");
        }
        var payload = FillPayload(targetId, expected, submit, defined, values);
        try
        {
            var typed = await platform.Compute.ControlAsync(placement.Computer, $"/desktops/{placement.Desktop}/browser/fill-login", payload, ct);
            using var result = JsonDocument.Parse(typed);
            var ok = result.RootElement.TryGetProperty("ok", out var flag) && flag.ValueKind == JsonValueKind.True;
            if (!ok)
            {
                var reason = result.RootElement.TryGetProperty("reason", out var why) ? why.GetString() : "inject_failed";
                throw new ToolHalt("denied", reason ?? "inject_failed");
            }
            return result.RootElement.TryGetProperty("attention", out var attention) && attention.ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(attention.GetString());
        }
        finally
        {
            CryptographicOperations.ZeroMemory(payload);
        }
    }

    private static byte[] FillPayload(string targetId, string expected, string submit, List<LoginField> defined, IReadOnlyList<SecretField> values)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteString("targetId", targetId);
            writer.WriteString("expectedOrigin", expected);
            writer.WriteString("submitSelector", submit ?? "");
            writer.WriteStartArray("fields");
            var count = 0;
            foreach (var field in defined)
            {
                if (string.IsNullOrWhiteSpace(field.Kind) || string.IsNullOrWhiteSpace(field.Selector)) continue;
                var match = values.FirstOrDefault(item => item.Kind == field.Kind);
                if (match == null || match.Value.Length == 0) continue;
                writer.WriteStartObject();
                writer.WriteString("selector", field.Selector);
                writer.WriteString("kind", field.Kind);
                writer.WriteString("value", match.Value);
                writer.WriteEndObject();
                count++;
            }
            writer.WriteEndArray();
            writer.WriteEndObject();
            if (count == 0) throw new ToolHalt("denied", "missing_field");
        }
        var payload = stream.ToArray();
        if (stream.TryGetBuffer(out var segment)) CryptographicOperations.ZeroMemory(segment);
        return payload;
    }

    private async Task Create(Guid owner, Guid botId, Guid taskId, string domain, string url, JsonElement args)
    {
        var fields = ParseFields(args);
        if (fields.Count == 0) throw new ToolHalt("denied", "missing_field");
        var id = Guid.NewGuid();
        await using var conn = await platform.Data.OpenConnectionAsync();
        await conn.ExecuteAsync(
            """
            INSERT INTO login_prompts (id, owner_id, bot_id, task_id, domain, url, fields, submit_selector, status, expires_at)
            VALUES (@id, @owner, @bot, @task, @domain, @url, @fields::jsonb, @submit, 'pending', now() + interval '5 minutes')
            """,
            new
            {
                id, owner, bot = botId, task = taskId, domain, url,
                fields = JsonSerializer.Serialize(fields, Camel),
                submit = Arg(args, "submitSelector")
            });
        await platform.Publish(new { type = "login_request", id, botId });
        await platform.Audit(owner.ToString(), "login.requested", botId, taskId, new { promptId = id, domain });
    }

    private async Task<PromptRow?> Latest(Guid taskId)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        var row = await conn.QuerySingleOrDefaultAsync<PromptRow>(
            """
            SELECT id, owner_id, bot_id, task_id, domain, url, fields::text AS fields, submit_selector, status, expires_at
            FROM login_prompts WHERE task_id=@task ORDER BY created_at DESC LIMIT 1
            """,
            new { task = taskId });
        return row == null || row.Id == Guid.Empty ? null : row;
    }

    private async Task SetStatus(Guid id, string status)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        await conn.ExecuteAsync(
            "UPDATE login_prompts SET status=@status, filled_at=CASE WHEN @status='filled' THEN now() ELSE filled_at END WHERE id=@id",
            new { id, status });
    }

    private async Task Wait(Guid taskId) => await WaitFor(taskId, "login_form");

    private async Task WaitFor(Guid taskId, string reason)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        await conn.ExecuteAsync("UPDATE tasks SET status='waiting_human', waiting_reason=@reason, lease_owner=NULL, lease_until=NULL, updated_at=now() WHERE id=@id", new { id = taskId, reason });
        await platform.Publish(new { type = "login_request", taskId });
    }

    private static bool TryVaultRefs(JsonElement args, out Dictionary<string, string> refs)
    {
        refs = new Dictionary<string, string>(StringComparer.Ordinal);
        if (!args.TryGetProperty("vaultRefs", out var node) || node.ValueKind != JsonValueKind.Object) return false;
        foreach (var prop in node.EnumerateObject())
        {
            if (!Kinds.Contains(prop.Name) || prop.Value.ValueKind != JsonValueKind.String) continue;
            var reference = prop.Value.GetString() ?? "";
            if (!SecretRef.TryParse(reference, out _, out _)) continue;
            refs[prop.Name] = reference;
        }
        return refs.Count > 0;
    }

    private static List<LoginField> ParseFields(JsonElement args)
    {
        var fields = new List<LoginField>();
        if (!args.TryGetProperty("fields", out var node) || node.ValueKind != JsonValueKind.Array) return fields;
        foreach (var item in node.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) continue;
            var kind = Arg(item, "kind").ToLowerInvariant();
            var selector = Arg(item, "selector");
            var label = Arg(item, "label");
            if (!Kinds.Contains(kind) || selector.Length == 0 || selector.Length > 200) continue;
            if (selector.Contains("password=", StringComparison.OrdinalIgnoreCase)) continue;
            fields.Add(new LoginField(kind, selector, string.IsNullOrWhiteSpace(label) ? kind : label));
        }
        return fields;
    }

    public static string Origin(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return "";
        var port = uri.IsDefaultPort ? "" : ":" + uri.Port;
        return $"{uri.Scheme}://{uri.Host}{port}";
    }

    private static string Arg(JsonElement args, string name) =>
        args.ValueKind == JsonValueKind.Object && args.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";

    private sealed record LoginField(string Kind, string Selector, string Label);

    private sealed class PromptRow
    {
        public Guid Id { get; set; }
        public Guid OwnerId { get; set; }
        public Guid BotId { get; set; }
        public Guid? TaskId { get; set; }
        public string Domain { get; set; } = "";
        public string Url { get; set; } = "";
        public string Fields { get; set; } = "[]";
        public string SubmitSelector { get; set; } = "";
        public string Status { get; set; } = "";
        public DateTimeOffset ExpiresAt { get; set; }
    }
}
