using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Amazon.S3;
using Amazon.S3.Model;
using Dapper;
using Npgsql;
using Teammates.Compute;

namespace Teammates.Api;

public sealed class Platform
{
    private readonly LoginRateLimiter _loginLimits = new();
    public LoginRateLimiter PublicShareLimits { get; } = new();
    public NpgsqlDataSource Data { get; }
    public IOneTimeTicketStore Tickets { get; }
    public byte[] MasterKey { get; }
    public DockerComputeProvider Compute { get; }
    public IAmazonS3 S3 { get; }
    public string Bucket { get; }
    public string WorkerToken { get; }
    public string MetricsToken { get; }
    public string ComputerToken { get; }
    public bool TestHooks { get; }
    public string OpenRouterBase { get; }
    public string LlmProvider { get; }
    public const string DefaultRealModel = "anthropic/claude-haiku-5.5";
    public string ModelName { get; }
    public IConfiguration Configuration { get; }
    public IConfiguration Config => Configuration;
    public int MaxParallel { get; }
    public int MaxAutoResumesPerHour { get; }
    public int CodingRounds { get; }
    public int CodingRoundsCumulative { get; }
    public int ChatRounds { get; }
    public int StallSoftSeconds { get; }
    public int StallHardSeconds { get; }
    public bool PauseOnBudget { get; }
    public TimeSpan IdleSuspend { get; }
    public string BootId { get; } = Guid.NewGuid().ToString("n");
    public TaskSignal Tasks { get; } = new();
    public SseLog Events { get; } = new();
    public long HttpMicros;
    public long HttpCount;
    public ulong ComputerMemory;
    public int ChromeProcesses;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(60) };
    private readonly IdempotencyStore _unused = new();

    public Platform(NpgsqlDataSource data, byte[] masterKey, DockerComputeProvider compute, IAmazonS3 s3, IConfiguration config)
    {
        Data = data;
        Tickets = new PostgresOneTimeTicketStore(data);
        MasterKey = masterKey;
        Compute = compute;
        S3 = s3;
        Configuration = config;
        Bucket = config["S3_BUCKET"] ?? "artifacts";
        WorkerToken = config["WORKER_TOKEN"] ?? "";
        MetricsToken = config["METRICS_TOKEN"] ?? "";
        ComputerToken = config["COMPUTER_TOKEN"] ?? "";
        TestHooks = string.Equals(config["ENABLE_TEST_HOOKS"], "true", StringComparison.OrdinalIgnoreCase);
        OpenRouterBase = (config["OPENROUTER_BASE_URL"] ?? "http://mock-openrouter:8090/api/v1").TrimEnd('/');
        LlmProvider = config["LLM_PROVIDER"] ?? "mock";
        ModelName = PlannerModel(config["LLM_PROVIDER"], config["MODEL_PLANNER"]);
        MaxParallel = int.TryParse(config["MAX_PARALLEL_TASKS_PER_USER"], out var max) ? max : 6;
        MaxAutoResumesPerHour = ConfigInt(config, "Resume:MaxAutoResumesPerHour", 5, 1, 20);
        CodingRounds = ConfigInt(config, "RunBudget:CodingRounds", 12, 1, 100);
        CodingRoundsCumulative = ConfigInt(config, "RunBudget:CodingRoundsCumulative", 60, CodingRounds, 500);
        ChatRounds = ConfigInt(config, "RunBudget:ChatRounds", 12, 1, 500);
        StallSoftSeconds = ConfigInt(config, "STALL_SOFT_SECONDS", 180, 30, 86400);
        StallHardSeconds = Math.Max(StallSoftSeconds + 1, ConfigInt(config, "STALL_HARD_SECONDS", 600, 31, 172800));
        PauseOnBudget = !bool.TryParse(config["RunBudget:PauseOnBudget"], out var pause) || pause;
        IdleSuspend = int.TryParse(config["IDLE_SUSPEND_MINUTES"], out var idleMinutes) && idleMinutes >= 0
            ? TimeSpan.FromMinutes(idleMinutes)
            : TimeSpan.FromMinutes(10);
        _ = _unused;
    }

    public static string PlannerModel(string? provider, string? configuredModel) =>
        !string.IsNullOrWhiteSpace(configuredModel) ? configuredModel
            : string.IsNullOrWhiteSpace(provider) || string.Equals(provider, "mock", StringComparison.OrdinalIgnoreCase)
                ? "mock/planner" : DefaultRealModel;

    private static int ConfigInt(IConfiguration config, string key, int fallback, int min, int max) =>
        int.TryParse(config[key], out var value) ? Math.Clamp(value, min, max) : fallback;

    public async Task MigrateAndSeed(string ownerUser, string ownerPassword)
    {
        // Several API instances can start at once against one database; the first takes the lock and the rest wait for it.
        await using var lockConn = await Data.OpenConnectionAsync();
        await lockConn.ExecuteAsync("SELECT pg_advisory_lock(840020)");
        try { await MigrateAndSeedLocked(ownerUser, ownerPassword); }
        finally { await lockConn.ExecuteAsync("SELECT pg_advisory_unlock(840020)"); }
    }

    public static readonly string[] MigrationFiles =
    [
        "001_init.sql",
        "002_reactions.sql",
        "003_v02.sql",
        "004_resources.sql",
        "005_plugins.sql",
        "006_security.sql",
        "007_credential_grants.sql",
        "008_plugin_catalog.sql",
        "009_v03.sql",
        "010_provider.sql",
        "011_devices.sql",
        "012_reliability.sql",
        "013_feedback.sql",
        "014_avatar.sql",
        "015_bot_messaging.sql",
        "016_chat_actions.sql",
        "017_primary.sql",
        "018_bio.sql",
        "019_coding_work.sql",
        "020_coding_items.sql",
        "021_routine_timezone.sql",
        "022_routines_v2.sql",
        "023_routine_test.sql",
        "024_library.sql",
        "025_library_actions.sql",
        "026_library_shares.sql",
        "027_memory_notes.sql",
        "028_long_run_resume.sql",
        "029_resume_timing.sql",
        "030_tool_dedupe.sql",
        "031_pause_on_budget.sql",
        "032_transcript_archive.sql",
        "033_watchdog.sql",
        "034_approval_rules.sql",
        "035_approval_rules_upgrade.sql",
        "036_rule_scope.sql",
        "037_device_commands.sql",
        "038_computer_windows.sql",
        "039_desktop_lease.sql",
        "040_tickets_state.sql",
        "041_skill_library.sql",
        "042_video_analyses.sql",
        "053_pages.sql",
    ];

    private async Task MigrateAndSeedLocked(string ownerUser, string ownerPassword)
    {
        var sql = await File.ReadAllTextAsync("/migrations/" + MigrationFiles[0]);
        await using var conn = await Data.OpenConnectionAsync();
        var applied = await conn.ExecuteScalarAsync<bool>("SELECT to_regclass('public.schema_migrations') IS NOT NULL");
        if (!applied) await conn.ExecuteAsync(sql);
        await conn.ExecuteAsync("INSERT INTO schema_migrations (id) VALUES ('001') ON CONFLICT DO NOTHING");
        foreach (var file in MigrationFiles.Skip(1))
        {
            var mid = file[..3];
            if (await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM schema_migrations WHERE id=@mid", new { mid }) != 0) continue;
            await using var tx = await conn.BeginTransactionAsync();
            await conn.ExecuteAsync(await File.ReadAllTextAsync("/migrations/" + file), transaction: tx);
            await conn.ExecuteAsync("INSERT INTO schema_migrations (id) VALUES (@mid) ON CONFLICT DO NOTHING", new { mid }, tx);
            await tx.CommitAsync();
        }
        var count = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM users");
        if (count == 0)
        {
            await conn.ExecuteAsync(
                "INSERT INTO users (username, password_hash, role, status, display_name) VALUES (@u, @p, 'owner', 'active', @u)",
                new { u = ownerUser, p = Passwords.Hash(ownerPassword) });
        }
        await conn.ExecuteAsync(
            """
            UPDATE users SET role='owner'
            WHERE id = (SELECT id FROM users ORDER BY created_at LIMIT 1)
              AND NOT EXISTS (SELECT 1 FROM users WHERE role='owner')
            """);
        await conn.ExecuteAsync(
            """
            INSERT INTO user_quotas (user_id)
            SELECT id FROM users
            ON CONFLICT DO NOTHING
            """);
        for (var attempt = 0; attempt < 20; attempt++)
        {
            try
            {
                await S3.PutBucketAsync(new PutBucketRequest { BucketName = Bucket });
                break;
            }
            catch (AmazonS3Exception ex) when (ex.ErrorCode is "BucketAlreadyOwnedByYou" or "BucketAlreadyExists") { break; }
            catch { await Task.Delay(1000); }
        }
    }

    public async Task<Guid?> UserForSession(string? token)
    {
        if (string.IsNullOrWhiteSpace(token)) return null;
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();
        await using var conn = await Data.OpenConnectionAsync();
        return await conn.ExecuteScalarAsync<Guid?>("SELECT user_id FROM sessions WHERE token_hash=@h AND expires_at > now()", new { h = hash });
    }

    public async Task<bool> LoginBlocked(string ip, bool testLogin = false)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(ip.Length <= 128 ? ip : ip[..128]));
        await using var conn = await Data.OpenConnectionAsync();
        var limits = LoginRateLimiter.LimitsFor(TestHooks && testLogin);
        return await conn.ExecuteScalarAsync<bool>("SELECT count(*) FILTER (WHERE failed) >= @failures OR count(*) >= @attempts FROM login_rate_events WHERE ip_hash=@hash AND created_at > clock_timestamp() - interval '10 minutes'", new { hash, failures = limits.Failures, attempts = limits.Attempts });
    }

    public async Task<long> NoteLoginAttempt(string ip)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(ip.Length <= 128 ? ip : ip[..128]));
        await using var conn = await Data.OpenConnectionAsync();
        var id = await conn.ExecuteScalarAsync<long>("INSERT INTO login_rate_events (ip_hash, failed) VALUES (@hash,false) RETURNING id", new { hash });
        await conn.ExecuteAsync("DELETE FROM login_rate_events WHERE created_at < clock_timestamp() - interval '1 day'");
        return id;
    }

    public async Task NoteLoginFailure(string ip, long attemptId)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(ip.Length <= 128 ? ip : ip[..128]));
        await using var conn = await Data.OpenConnectionAsync();
        await conn.ExecuteAsync("UPDATE login_rate_events SET failed=true WHERE id=@attemptId AND ip_hash=@hash", new { hash, attemptId });
    }

    public async Task<string> CreateSession(Guid userId)
    {
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();
        await using var conn = await Data.OpenConnectionAsync();
        await conn.ExecuteAsync("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (@u, @h, now() + interval '14 days')", new { u = userId, h = hash });
        return token;
    }

    public async Task Audit(string actor, string action, Guid? botId, Guid? taskId, object detail)
    {
        var detailJson = Dlp.Redact(JsonSerializer.Serialize(detail));
        await using var conn = await Data.OpenConnectionAsync();
        await using var tx = await conn.BeginTransactionAsync();
        await conn.ExecuteAsync("SELECT pg_advisory_xact_lock(840021)", transaction: tx);
        var prev = await conn.ExecuteScalarAsync<string>("SELECT row_hash FROM audit_chain_head WHERE id=1", transaction: tx) ?? AuditChain.Genesis;
        var id = await conn.ExecuteScalarAsync<long>("SELECT nextval('audit_events_id_seq')", transaction: tx);
        var at = AuditChain.Stamp(DateTime.UtcNow);
        var bot = botId?.ToString();
        var task = taskId?.ToString();
        var canon = AuditChain.Canonical(id, at, actor, action, bot, task, detailJson, prev);
        var hash = AuditChain.Hash(id, at, actor, action, bot, task, detailJson, prev);
        await conn.ExecuteAsync(
            """
            INSERT INTO audit_events (id, at, actor, action, bot_id, task_id, detail, detail_canonical, prev_hash, row_hash, chain_canonical)
            VALUES (@id, @at, @actor, @action, @bot, @task, @detail::jsonb, @detail, @prev, @hash, @canon)
            """,
            new { id, at, actor, action, bot = botId, task = taskId, detail = detailJson, prev, hash, canon }, tx);
        await conn.ExecuteAsync("UPDATE audit_chain_head SET row_hash=@hash WHERE id=1", new { hash }, tx);
        await tx.CommitAsync();
    }

    public async Task SecretEvent(Guid? secretId, string evt, string actor, Guid? botId, Guid? taskId, string? tool, string? destination, string decision, string? reason)
    {
        await using var conn = await Data.OpenConnectionAsync();
        await conn.ExecuteAsync(
            """
            INSERT INTO secret_usage_events (secret_id, event, actor, bot_id, task_id, tool, destination, decision, reason_code)
            VALUES (@id, @evt, @actor, @bot, @task, @tool, @dest, @decision, @reason)
            """,
            new { id = secretId, evt, actor, bot = botId, task = taskId, tool, dest = destination, decision, reason });
    }

    public async Task<(bool Ok, int? Limit, string? Error)> ProbeOpenRouter(string value)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, OpenRouterBase + "/key");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", value);
        try
        {
            using var response = await _http.SendAsync(request);
            if (!response.IsSuccessStatusCode) return (false, null, "invalid");
            return ProviderWire.ReadKey(await response.Content.ReadAsStringAsync());
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            return (false, null, "unreachable");
        }
    }

    public static string? Mask(string type, string value) =>
        type is "API_KEY" or "TOKEN" && value.Length >= 16 ? value[^4..] : null;

    public async Task<Guid> InsertSecret(Guid owner, string provider, string name, string type, string value, string description, string[] tools, string[] domains, DateTimeOffset? expires, string validation, Guid[]? allowedBots = null)
    {
        var plain = Encoding.UTF8.GetBytes(value);
        try
        {
            await using var conn = await Data.OpenConnectionAsync();
            var existing = await conn.ExecuteScalarAsync<Guid?>(
                "SELECT id FROM secrets WHERE owner_user_id=@owner AND scope='USER' AND provider=@provider AND name=@name",
                new { owner, provider, name });
            var bots = allowedBots is { Length: > 0 } ? allowedBots : null;
            if (existing is Guid id)
            {
                var (cipher, nonce) = KeyEncryption.Encrypt(MasterKey, id, owner, type, KeyEncryption.KeyVersion, plain);
                await conn.ExecuteAsync(
                    """
                    UPDATE secrets
                    SET description=@description, type=@type, ciphertext=@cipher, nonce=@nonce, key_version=@version,
                        masked_suffix=@mask, allowed_tools=@tools, allowed_domains=@domains, allowed_bot_ids=@bots,
                        validation_status=@validation, expires_at=@expires, revoked_at=NULL, updated_at=now()
                    WHERE id=@id
                    """,
                    new { id, description, type, cipher, nonce, version = KeyEncryption.KeyVersion, mask = Mask(type, value), tools, domains, bots, validation, expires });
                await SecretEvent(id, "secret.rotated", owner.ToString(), null, null, null, null, "allow", null);
                return id;
            }
            var created = Guid.NewGuid();
            var (freshCipher, freshNonce) = KeyEncryption.Encrypt(MasterKey, created, owner, type, KeyEncryption.KeyVersion, plain);
            await conn.ExecuteAsync(
                """
                INSERT INTO secrets (id, owner_user_id, name, provider, description, type, scope, ciphertext, nonce, key_version, masked_suffix, allowed_tools, allowed_domains, allowed_bot_ids, validation_status, expires_at)
                VALUES (@id, @owner, @name, @provider, @description, @type, 'USER', @cipher, @nonce, @version, @mask, @tools, @domains, @bots, @validation, @expires)
                """,
                new
                {
                    id = created, owner, name, provider, description, type, cipher = freshCipher, nonce = freshNonce,
                    version = KeyEncryption.KeyVersion,
                    mask = Mask(type, value),
                    tools, domains, bots, validation, expires
                });
            await SecretEvent(created, "secret.created", owner.ToString(), null, null, null, null, "allow", null);
            return created;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plain);
        }
    }

    public async Task InsertSecretBytes(Guid owner, string provider, string name, string type, byte[] value, string description, string[] tools, string[] domains, Guid[]? allowedBots)
    {
        var id = Guid.NewGuid();
        var (cipher, nonce) = KeyEncryption.Encrypt(MasterKey, id, owner, type, KeyEncryption.KeyVersion, value);
        await using var conn = await Data.OpenConnectionAsync();
        await conn.ExecuteAsync(
            """
            INSERT INTO secrets (id, owner_user_id, name, provider, description, type, scope, ciphertext, nonce, key_version, masked_suffix, allowed_tools, allowed_domains, allowed_bot_ids, validation_status)
            VALUES (@id, @owner, @name, @provider, @description, @type, 'USER', @cipher, @nonce, @version, NULL, @tools, @domains, @bots, 'unknown')
            """,
            new
            {
                id, owner, name, provider, description, type, cipher, nonce,
                version = KeyEncryption.KeyVersion,
                tools, domains, bots = allowedBots is { Length: > 0 } ? allowedBots : null
            });
        await SecretEvent(id, "secret.created", owner.ToString(), null, null, null, null, "allow", null);
    }

    public async Task<Dictionary<string, object?>?> SecretMeta(Guid owner, Guid id)
    {
        await using var conn = await Data.OpenConnectionAsync();
        var row = await conn.QuerySingleOrDefaultAsync(
            """
            SELECT id, name, provider, description, type, scope, masked_suffix, allowed_tools, allowed_domains, allowed_bot_ids, validation_status, created_at, updated_at, last_used_at, rotated_at, expires_at, revoked_at
            FROM secrets WHERE id=@id AND owner_user_id=@owner
            """,
            new { id, owner });
        return row == null ? null : ToDict(row);
    }

    public async Task<byte[]?> Resolve(Guid owner, string reference, string tool, Guid? botId, string? destination, Guid? taskId, string actor)
    {
        var detailed = await ResolveDetailed(owner, reference, tool, botId, destination, taskId, actor);
        return detailed.Value;
    }

    public async Task<(byte[]? Value, string? Deny)> ResolveDetailed(Guid owner, string reference, string tool, Guid? botId, string? destination, Guid? taskId, string actor)
    {
        if (!SecretRef.TryParse(reference, out var provider, out var name))
        {
            await SecretEvent(null, "secret.denied", actor, botId, taskId, tool, destination, "deny", "invalid_ref");
            return (null, "invalid_ref");
        }
        await using var conn = await Data.OpenConnectionAsync();
        var row = await conn.QuerySingleOrDefaultAsync<(Guid Id, string Type, int KeyVersion, byte[] Ciphertext, byte[] Nonce, string[] AllowedTools, string[] AllowedDomains, Guid[]? AllowedBots, DateTimeOffset? Expires, DateTimeOffset? Revoked)>(
            """
            SELECT id, type, key_version, ciphertext, nonce, allowed_tools, allowed_domains, allowed_bot_ids, expires_at, revoked_at
            FROM secrets WHERE owner_user_id=@owner AND provider=@provider AND name=@name AND scope='USER'
            """,
            new { owner, provider, name });
        if (row.Id == Guid.Empty)
        {
            await SecretEvent(null, "secret.denied", actor, botId, taskId, tool, destination, "deny", "not_found");
            return (null, "not_found");
        }
        string? deny = null;
        if (row.Revoked != null) deny = "revoked";
        else if (row.Expires != null && row.Expires < DateTimeOffset.UtcNow) deny = "expired";
        else if (row.AllowedTools.Length > 0 && !row.AllowedTools.Contains(tool)) deny = "tool_not_allowed";
        else if (row.AllowedBots is { Length: > 0 } && tool is not ("secret.test" or "model_gateway") && (botId == null || !row.AllowedBots.Contains(botId.Value))) deny = "bot_not_allowed";
        else if (!string.IsNullOrWhiteSpace(destination) && !DomainRules.Allows(row.AllowedDomains, destination)) deny = "domain_not_allowed";
        if (deny != null)
        {
            await SecretEvent(row.Id, "secret.denied", actor, botId, taskId, tool, destination, "deny", deny);
            if (deny == "expired")
                await conn.ExecuteAsync("UPDATE secrets SET validation_status='expired' WHERE id=@id", new { id = row.Id });
            return (null, deny);
        }
        try
        {
            var value = KeyEncryption.Decrypt(MasterKey, row.Id, owner, row.Type, row.KeyVersion, row.Ciphertext, row.Nonce);
            await conn.ExecuteAsync("UPDATE secrets SET last_used_at=now(), validation_status='valid' WHERE id=@id", new { id = row.Id });
            await SecretEvent(row.Id, "secret.used", actor, botId, taskId, tool, destination, "allow", null);
            return (value, null);
        }
        catch (CryptographicException)
        {
            await SecretEvent(row.Id, "secret.denied", actor, botId, taskId, tool, destination, "deny", "corrupted_ciphertext");
            return (null, "corrupted_ciphertext");
        }
    }

    public async Task<(ComputerId Computer, string Desktop)> PlacementForBot(Guid botId, CancellationToken ct = default)
    {
        await using var conn = await Data.OpenConnectionAsync(ct);
        var link = await conn.QuerySingleOrDefaultAsync<(Guid ComputerId, Guid DesktopBotId, DateTime CreatedAt)>(
            """
            SELECT c.computer_id, c.desktop_bot_id, c.created_at
            FROM bots b
            JOIN user_computers c ON c.user_id = b.owner_id
            WHERE b.id = @id
            """,
            new { id = botId });
        if (link.ComputerId == Guid.Empty)
            return (new ComputerId(botId.ToString()), botId.ToString());
        var created = await conn.ExecuteScalarAsync<DateTime>("SELECT created_at FROM bots WHERE id=@id", new { id = botId });
        var shared = created >= link.CreatedAt.AddSeconds(-2) || botId == link.DesktopBotId || botId == link.ComputerId;
        if (!shared)
            return (new ComputerId(botId.ToString()), botId.ToString());
        return (new ComputerId(link.ComputerId.ToString()), link.DesktopBotId.ToString());
    }

    public async Task Notify(Guid userId, string kind, string title, string body)
    {
        var text = body.Length > 240 ? body[..240] : body;
        await using var conn = await Data.OpenConnectionAsync();
        var enabled = await conn.ExecuteScalarAsync<bool?>(
            """
            SELECT bool_and(notifications_enabled) FROM bots WHERE owner_id=@id
            """,
            new { id = userId });
        if (enabled == false) return;
        await conn.ExecuteAsync(
            "INSERT INTO notifications (user_id, kind, title, body) VALUES (@user, @kind, @title, @body)",
            new { user = userId, kind, title, body = text });
    }

    public async Task SweepSecretExpiry()
    {
        await using var conn = await Data.OpenConnectionAsync();
        await conn.ExecuteAsync(
            """
            UPDATE secrets SET validation_status='expired', updated_at=now()
            WHERE expires_at IS NOT NULL AND expires_at < now() AND revoked_at IS NULL AND validation_status <> 'expired'
            """);
    }

    public async Task<bool> BeginComputerRecovery(ComputerId id, CancellationToken ct)
    {
        if (!Guid.TryParse(id.Value, out var computerId)) return false;
        await using var conn = await Data.OpenConnectionAsync(ct);
        var owner = await conn.ExecuteScalarAsync<Guid?>("SELECT user_id FROM user_computers WHERE computer_id=@id", new { id = computerId });
        if (owner == null) return false;
        var name = await conn.ExecuteScalarAsync<string>(
            """
            SELECT b.name FROM bots b
            JOIN user_computers c ON c.desktop_bot_id = b.id
            WHERE c.computer_id = @id
            """,
            new { id = computerId });
        await conn.ExecuteAsync("UPDATE user_computers SET status='recovering' WHERE computer_id=@id", new { id = computerId });
        _ = ObserveRestore(Compute.RestoreComputerAsync(id, owner.Value.ToString(), null, false, name, CancellationToken.None));
        return true;
    }

    public async Task ResumeRecoveringTasks(ComputerId id)
    {
        if (!Guid.TryParse(id.Value, out var computerId)) return;
        await using var conn = await Data.OpenConnectionAsync();
        var resumed = await conn.ExecuteAsync(
            """
            UPDATE tasks t
            SET status='queued', waiting_reason='computer_recovered', lease_owner=NULL, lease_until=NULL, updated_at=now()
            FROM bots b
            JOIN user_computers c ON c.user_id = b.owner_id
            WHERE t.bot_id = b.id
              AND t.status = 'waiting_resource'
              AND t.waiting_reason = 'computer_recovering'
              AND c.computer_id = @id
              AND (
                b.created_at >= c.created_at - interval '2 seconds'
                OR b.id = c.desktop_bot_id
                OR b.id = c.computer_id
              )
            """,
            new { id = computerId });
        await conn.ExecuteAsync("UPDATE user_computers SET status='running' WHERE computer_id=@id", new { id = computerId });
        if (resumed > 0) Tasks.Pulse();
    }

    private static async Task ObserveRestore(Task restore)
    {
        try { await restore; }
        catch (Exception) { /* DockerComputeProvider logs the failed restore. */ }
    }

    public Task Publish(object payload)
    {
        var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        var frame = Events.Append(json).Format();
        foreach (var sink in Sinks.Values)
            sink.Writer.TryWrite(frame);
        return Task.CompletedTask;
    }

    public System.Threading.Channels.Channel<string> Listen()
    {
        var channel = System.Threading.Channels.Channel.CreateUnbounded<string>();
        Sinks[Guid.NewGuid()] = channel;
        return channel;
    }

    public readonly System.Collections.Concurrent.ConcurrentDictionary<Guid, System.Threading.Channels.Channel<string>> Sinks = new();

    public static Dictionary<string, object?> ToDict(object row)
    {
        var dict = new Dictionary<string, object?>();
        foreach (var prop in (IDictionary<string, object>)row)
            dict[SnakeToCamel(prop.Key)] = prop.Value is DateTime dt ? DateTime.SpecifyKind(dt, DateTimeKind.Utc) : prop.Value;
        return dict;
    }

    private static string SnakeToCamel(string key)
    {
        var parts = key.Split('_');
        return parts[0] + string.Concat(parts.Skip(1).Select(part => part.Length == 0 ? "" : char.ToUpperInvariant(part[0]) + part[1..]));
    }
}
