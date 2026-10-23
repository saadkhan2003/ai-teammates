using System.Text;
using Amazon.Runtime;
using Amazon.S3;
using Dapper;
using Npgsql;
using Teammates.Api;
using Teammates.Compute;

DefaultTypeMap.MatchNamesWithUnderscores = true;
AppContext.SetSwitch("Npgsql.EnableLegacyTimestampBehavior", true);

if (args.Length > 0 && args[0] == "plugins")
{
    Environment.ExitCode = await PluginCli.Run(args[1..]);
    return;
}

var builder = WebApplication.CreateBuilder(args);
builder.Logging.AddJsonConsole();
builder.Logging.AddFilter("System.Net.Http", LogLevel.Warning);
builder.Logging.AddFilter("System.Net.Http.HttpClient", LogLevel.Warning);
builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 60_000_000);
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
});

var config = builder.Configuration;
var master = KeyEncryption.LoadMasterKey(config["SECRETS_MASTER_KEY_FILE"] ?? "/run/secrets/secrets_master_key");
var connection = new NpgsqlConnectionStringBuilder
{
    Host = config["POSTGRES_HOST"] ?? "postgres",
    Port = int.Parse(config["POSTGRES_PORT"] ?? "5432"),
    Database = config["POSTGRES_DB"] ?? "agent",
    Username = config["POSTGRES_USER"] ?? "agent",
    Password = config["POSTGRES_PASSWORD"] ?? "teammates-dev",
    MaxPoolSize = 16
}.ConnectionString;
var data = NpgsqlDataSource.Create(connection);
var snapshots = new DirectorySnapshotStore(config["SNAPSHOT_DIR"] ?? "/tmp/teammates-snapshots");
var secrets = new BrokerSecretResolver();
using var computeLog = LoggerFactory.Create(logging => logging.AddJsonConsole());
var compute = new DockerComputeProvider(new DockerComputeOptions
{
    DockerHost = config["DOCKER_HOST"] ?? "unix:///var/run/docker.sock",
    ImageRef = config["COMPUTE_IMAGE"] ?? "teammates-computer:dev",
    NetworkName = string.IsNullOrWhiteSpace(config["COMPUTE_NETWORK"]) ? null : config["COMPUTE_NETWORK"],
    SeccompPath = config["SECCOMP_PROFILE"],
    MaxComputers = HostBudget.MaxComputers(HostBudget.ReadMemTotalBytes(), config["MAX_COMPUTERS"]),
    ComputerToken = config["COMPUTER_TOKEN"] ?? "",
    DisplayGeometry = config["DISPLAY_GEOMETRY"] ?? "1920x1200",
    DisplayDepth = config["DISPLAY_DEPTH"] ?? "24",
    IsolationSocket = string.IsNullOrWhiteSpace(config["ISOLATION_SOCKET"]) ? null : config["ISOLATION_SOCKET"],
    IsolationToken = config["ISOLATION_TOKEN"] ?? "",
    CgroupParent = string.IsNullOrWhiteSpace(config["CGROUP_PARENT"]) ? null : config["CGROUP_PARENT"],
    CgroupRoot = string.IsNullOrWhiteSpace(config["CGROUP_ROOT"]) ? "/sys/fs/cgroup" : config["CGROUP_ROOT"]!,
    IdlePower = ComputerPower.ParseMode(config["IDLE_POWER"]),
    IdleSuspend = int.TryParse(config["IDLE_SUSPEND_MINUTES"], out var suspendMinutes) && suspendMinutes >= 0 ? TimeSpan.FromMinutes(suspendMinutes) : TimeSpan.FromMinutes(10),
    IdleHibernate = int.TryParse(config["IDLE_HIBERNATE_MINUTES"], out var hibernateMinutes) && hibernateMinutes > 0 ? TimeSpan.FromMinutes(hibernateMinutes) : TimeSpan.FromMinutes(30),
    ResumeTarget = int.TryParse(config["IDLE_RESUME_TARGET_SECONDS"], out var resumeSeconds) && resumeSeconds > 0 ? TimeSpan.FromSeconds(resumeSeconds) : TimeSpan.FromSeconds(15)
}, secrets, snapshots, computeLog.CreateLogger<DockerComputeProvider>());

var s3 = new AmazonS3Client(new BasicAWSCredentials(config["S3_ACCESS_KEY"] ?? "agent", config["S3_SECRET_KEY"] ?? "teammates-dev-s3"), new AmazonS3Config
{
    ServiceURL = config["S3_ENDPOINT"] ?? "http://object-store:8333",
    ForcePathStyle = true,
    AuthenticationRegion = config["S3_REGION"] ?? "us-east-1"
});
var platform = new Platform(data, master, compute, s3, config);
compute.MissingComputer = platform.BeginComputerRecovery;
compute.OnComputerRestored = platform.ResumeRecoveringTasks;
secrets.Platform = platform;
var loginBroker = new LoginBroker();
var loginFlow = new LoginFlow(platform, loginBroker);
var runtime = new Runtime(platform, loginFlow);
builder.Services.AddSingleton(platform);
builder.Services.AddSingleton(new DeviceGate(data));
builder.Services.AddSingleton(loginBroker);
builder.Services.AddSingleton(loginFlow);
builder.Services.AddSingleton(runtime);
builder.Services.AddHostedService<Maintenance>();
builder.Services.AddHostedService<PluginCatalogJob>();

var app = builder.Build();
app.UseExceptionHandler(handler => handler.Run(async ctx =>
{
    var feature = ctx.Features.Get<Microsoft.AspNetCore.Diagnostics.IExceptionHandlerFeature>();
    if (feature?.Error is ComputeException recovering && recovering.IsRecovering)
    {
        ctx.Response.StatusCode = 503;
        await ctx.Response.WriteAsJsonAsync(new { error = ComputeException.RecoveringMessage });
        return;
    }
    if (feature?.Error is ComputeException isolation && isolation.IsIsolationMissing)
    {
        app.Logger.LogError("computer isolation alert: computers will not start");
        ctx.Response.StatusCode = 503;
        await ctx.Response.WriteAsJsonAsync(new
        {
            error = ComputeException.IsolationMissingMessage,
            message = "Computer isolation rules are missing and could not be reinstalled. No computer was started."
        });
        return;
    }
    if (feature?.Error is ComputeException busy && busy.Code == ComputeErrorCode.Conflict && busy.Message.StartsWith("another lifecycle operation"))
    {
        // A start, stop or restore is already running for this computer. The caller should retry shortly.
        ctx.Response.StatusCode = 503;
        ctx.Response.Headers["Retry-After"] = "2";
        await ctx.Response.WriteAsJsonAsync(new { error = "computer_busy" });
        return;
    }
    var message = OutputRedactor.Redact(feature?.Error.Message);
    app.Logger.LogError("request failed {Path} {Message}", ctx.Request.Path, message);
    ctx.Response.StatusCode = 500;
    await ctx.Response.WriteAsJsonAsync(new { error = "Internal error." });
}));
app.Use(async (ctx, next) =>
{
    var started = DateTimeOffset.UtcNow;
    await next();
    Interlocked.Add(ref platform.HttpMicros, (long)(DateTimeOffset.UtcNow - started).TotalMicroseconds);
    Interlocked.Increment(ref platform.HttpCount);
});
app.UseWebSockets();
var ownerPassword = config["OWNER_PASSWORD"];
OwnerPasswordGuard.Ensure(string.Equals(config["REQUIRE_OWNER_PASSWORD"], "true", StringComparison.OrdinalIgnoreCase), ownerPassword);
await platform.MigrateAndSeed(config["OWNER_USERNAME"] ?? "saad", string.IsNullOrWhiteSpace(ownerPassword) ? OwnerPasswordGuard.DevDefault : ownerPassword);
await compute.EnsureDiskToolsAsync(CancellationToken.None);
try
{
    await compute.EnsureComputerIsolationAsync(CancellationToken.None, 20);
}
catch (Exception ex)
{
    app.Logger.LogError("computer isolation alert: computers will not start ({Message})", ex.Message);
}
Routes.Map(app, platform, runtime);
SecurityRoutes.Map(app, platform, loginFlow);
BotMessaging.Map(app, platform);
Devices.Map(app, platform);
Feedback.Map(app, platform);
app.Run();

public sealed class BrokerSecretResolver : IExecSecretResolver
{
    public Platform? Platform { get; set; }

    public async Task<IReadOnlyDictionary<string, string>> ResolveAsync(ComputerId computerId, IReadOnlyList<SecretEnvBinding> bindings, CancellationToken ct)
    {
        if (Platform == null) throw ComputeException.Internal("secret resolver is not ready");
        await using var conn = await Platform.Data.OpenConnectionAsync(ct);
        var resolved = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var binding in bindings)
        {
            var (owner, bot) = await ActingBot(conn, computerId, binding.GrantId);
            if (owner == null) throw ComputeException.PermissionDenied("secret ref is not granted");
            var bytes = await Platform.Resolve(owner.Value, binding.SecretRef, "setup_env", bot, null, null, "setup_runner");
            if (bytes == null) throw ComputeException.PermissionDenied("secret ref is not granted");
            resolved[binding.EnvName] = Encoding.UTF8.GetString(bytes);
            System.Security.Cryptography.CryptographicOperations.ZeroMemory(bytes);
        }
        return resolved;
    }

    // A computer is shared by every bot of one user, and its id stays the first bot's id
    // after that bot is deleted. GrantId carries the bot that invoked the tool.
    private static async Task<(Guid? Owner, Guid? Bot)> ActingBot(System.Data.IDbConnection conn, ComputerId computerId, string grantId)
    {
        if (Guid.TryParse(grantId, out var grantBot))
        {
            var granted = await conn.ExecuteScalarAsync<Guid?>("SELECT owner_id FROM bots WHERE id=@id", new { id = grantBot });
            if (granted != null) return (granted, grantBot);
        }
        if (!Guid.TryParse(computerId.Value, out var computer)) return (null, null);
        var legacy = await conn.ExecuteScalarAsync<Guid?>("SELECT owner_id FROM bots WHERE id=@id", new { id = computer });
        if (legacy != null) return (legacy, computer);
        var shared = await conn.ExecuteScalarAsync<Guid?>("SELECT user_id FROM user_computers WHERE computer_id=@id", new { id = computer });
        return (shared, null);
    }
}

public sealed class DirectorySnapshotStore(string root) : ISnapshotStore
{
    public async Task SaveAsync(string snapshotId, string name, Stream content, CancellationToken ct)
    {
        var dir = Path.Combine(root, snapshotId);
        Directory.CreateDirectory(dir);
        await using var file = File.Create(Path.Combine(dir, name));
        await content.CopyToAsync(file, ct);
    }

    public Task<Stream> OpenAsync(string snapshotId, string name, CancellationToken ct)
    {
        var path = Path.Combine(root, snapshotId, name);
        if (!File.Exists(path)) throw ComputeException.NotFound("snapshot not found");
        Stream stream = File.OpenRead(path);
        return Task.FromResult(stream);
    }
}

public sealed class Maintenance(Platform platform, LoginFlow logins, Runtime runtime, ILogger<Maintenance> logger) : BackgroundService
{
    private int _tick;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await runtime.RecoverOutbound(stoppingToken);
                await using var conn = await platform.Data.OpenConnectionAsync(stoppingToken);
                var stallSeconds = int.TryParse(Environment.GetEnvironmentVariable("STALL_SECONDS"), out var configuredStall) ? Math.Clamp(configuredStall, 30, 86400) : 300;
                var stalled = await conn.QueryAsync<(Guid Id, Guid BotId, string Title, Guid? ConversationId, int Nudges, double IdleSeconds)>("SELECT id,bot_id,title,conversation_id,stall_nudges,extract(epoch from now()-last_progress_at) FROM tasks WHERE status='running' AND lease_until>now() AND blocked_reason IS NULL");
                foreach (var task in stalled)
                {
                    var decision = StallPolicy.Decide(TimeSpan.FromSeconds(task.IdleSeconds), task.Nudges, TimeSpan.FromSeconds(stallSeconds));
                    if (decision == StallDecision.Nudge) await conn.ExecuteAsync("UPDATE tasks SET nudge_pending=true,stall_nudges=stall_nudges+1 WHERE id=@id AND stall_nudges=0", new { id = task.Id });
                    else if (decision == StallDecision.Block)
                    {
                        await conn.ExecuteAsync("UPDATE tasks SET blocked_reason='stalled' WHERE id=@id", new { id = task.Id });
                        if (task.ConversationId != null) await conn.ExecuteAsync("INSERT INTO messages(conversation_id,role,content,task_id) VALUES(@conversation,'assistant',@text,@id)", new { conversation = task.ConversationId, id = task.Id, text = $"I'm stuck on {task.Title}. What should I do?" });
                        var owner = await conn.ExecuteScalarAsync<Guid>("SELECT owner_id FROM bots WHERE id=@id", new { id = task.BotId });
                        await platform.Notify(owner, "task.blocked", "Task is stuck", task.Title);
                        await platform.Publish(new { type = "task", taskId = task.Id, status = "running", blocked = true });
                    }
                }
                var expired = await conn.ExecuteAsync("UPDATE tasks SET status='queued', lease_owner=NULL, lease_until=NULL, waiting_reason='lease_expired', updated_at=now() WHERE status='running' AND lease_until < now()");
                if (expired > 0) platform.Tasks.Pulse();
                await ResumeRecoveredComputers(stoppingToken);
                if (++_tick % 10 == 0) await SampleComputers(stoppingToken);
                if (_tick % 15 == 0)
                {
                    await SuspendIdle(conn, stoppingToken);
                    try { await platform.Compute.EnsureComputerIsolationAsync(stoppingToken); }
                    catch (Exception ex)
                    {
                        logger.LogError("computer isolation alert: {Message}", OutputRedactor.Redact(ex.Message));
                    }
                }
                await RoutineRuns.Tick(platform, conn, DateTimeOffset.UtcNow, async (kind, reference, botId, token) =>
                    kind == "http" ? await WatchHttp(reference, token) : await WatchMemory(conn, botId), stoppingToken);
            }
            catch (Exception ex)
            {
                logger.LogWarning("maintenance skipped {Message}", OutputRedactor.Redact(ex.Message));
            }
            try { await logins.ExpirePending(); }
            catch (Exception ex) { logger.LogDebug("login sweep skipped {Message}", OutputRedactor.Redact(ex.Message)); }
            try { await platform.SweepSecretExpiry(); }
            catch (Exception ex) { logger.LogDebug("secret sweep skipped {Message}", OutputRedactor.Redact(ex.Message)); }
            try { await Task.Delay(TimeSpan.FromSeconds(2), stoppingToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    private static async Task<string?> WatchHttp(string url, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(url)) return null;
        var blocked = await SsrfGuard.ResolveAsync(url, ct);
        if (blocked.Blocked) return null;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(4));
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            using var response = await PluginHttp.Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            var body = await PluginProbe.ReadLimited(response.Content, 8192, timeout.Token);
            return ((int)response.StatusCode).ToString() + "\n" + body;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static async Task<string?> WatchMemory(NpgsqlConnection conn, Guid botId)
    {
        var rows = await conn.QueryAsync<string>("SELECT content FROM memories WHERE bot_id=@id ORDER BY updated_at DESC LIMIT 50", new { id = botId });
        return string.Join('\n', rows.Select(row =>
        {
            var text = row ?? "";
            return text.Length > 500 ? text[..500] : text;
        }));
    }

    private async Task ResumeRecoveredComputers(CancellationToken ct)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var ids = await conn.QueryAsync<Guid>(
            """
            SELECT DISTINCT c.computer_id
            FROM tasks t
            JOIN bots b ON b.id = t.bot_id
            JOIN user_computers c ON c.user_id = b.owner_id
            WHERE t.status = 'waiting_resource' AND t.waiting_reason = 'computer_recovering'
            """);
        foreach (var id in ids)
        {
            var computer = new ComputerId(id.ToString());
            if (platform.Compute.IsComputerReady(computer) && !platform.Compute.IsComputerRestoring(computer))
                await platform.ResumeRecoveringTasks(computer);
            else
                await platform.BeginComputerRecovery(computer, ct);
        }
    }

    private async Task SuspendIdle(NpgsqlConnection conn, CancellationToken ct)
    {
        var busy = (await conn.QueryAsync<Guid>(
            """
            SELECT DISTINCT uc.computer_id FROM user_computers uc
            JOIN bots b ON b.owner_id = uc.user_id
            JOIN tasks t ON t.bot_id = b.id
            WHERE t.status IN ('queued', 'running', 'planning', 'waiting_human', 'waiting_approval', 'waiting_resource')
            UNION
            SELECT t.bot_id FROM tasks t
            WHERE t.status IN ('queued', 'running', 'planning', 'waiting_human', 'waiting_approval', 'waiting_resource')
            """)).Select(id => id.ToString()).ToHashSet();
        await platform.Compute.SuspendIdleAsync(busy, platform.IdleSuspend, ct);
    }

    private async Task SampleComputers(CancellationToken ct)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var ids = (await conn.QueryAsync<Guid>("SELECT computer_id FROM user_computers")).ToArray();
        if (ids.Length == 0) ids = (await conn.QueryAsync<Guid>("SELECT id FROM bots")).ToArray();
        ulong memory = 0;
        var chrome = 0;
        var sampled = 0;
        foreach (var id in ids)
        {
            try
            {
                memory += await platform.Compute.ReadMemoryBytesAsync(new ComputerId(id.ToString()), ct);
                chrome += await platform.Compute.CountChromeAsync(new ComputerId(id.ToString()), ct);
                sampled++;
            }
            catch (Exception ex)
            {
                logger.LogDebug("computer sample skipped {Message}", OutputRedactor.Redact(ex.Message));
            }
        }
        // A recreate or a pause misses one pass. Keep the last good sample so
        // the metrics page does not flash zero between passes.
        if (sampled == 0) return;
        platform.ComputerMemory = memory;
        platform.ChromeProcesses = chrome;
    }
}
