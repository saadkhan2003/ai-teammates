using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Threading.Channels;
using Dapper;
using Microsoft.AspNetCore.Routing;
using Npgsql;

namespace Teammates.Api;

public sealed record PerfEvent(string Source, string Name, double ValueMs, Guid? Owner, string? Route, string Attrs);

/// <summary>Lossy telemetry: Record never waits for IO. Future compute stages can call Record("wake_paused_ms", ms).</summary>
public sealed class PerfRecorder(NpgsqlDataSource data, ILogger<PerfRecorder> logger) : BackgroundService
{
    private readonly Channel<PerfEvent> queue = Channel.CreateBounded<PerfEvent>(new BoundedChannelOptions(4096)
    { FullMode = BoundedChannelFullMode.Wait, SingleReader = true });
    private readonly ConcurrentDictionary<string, Queue<double>> rings = new();
    private readonly ConcurrentDictionary<Guid, (long Minute, int Count)> limits = new();
    public long Dropped => Interlocked.Read(ref dropped);
    private long dropped;

    public void Record(string name, double ms, object? attrs = null) => Enqueue(new("server", name, ms, null, null, JsonSerializer.Serialize(attrs ?? new { })));
    public void Enqueue(PerfEvent item)
    {
        if (!double.IsFinite(item.ValueMs) || item.ValueMs < 0) return;
        if (!queue.Writer.TryWrite(item)) Interlocked.Increment(ref dropped);
    }
    public bool AllowRum(Guid user)
    {
        var minute = DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 60;
        var entry = limits.AddOrUpdate(user, (minute, 1), (_, old) => old.Minute == minute ? (minute, old.Count + 1) : (minute, 1));
        return entry.Count <= 12;
    }
    public void Api(string route, double ms)
    {
        var ring = rings.GetOrAdd(route, _ => new Queue<double>());
        lock (ring) { ring.Enqueue(ms); while (ring.Count > 256) ring.Dequeue(); }
        if (Random.Shared.Next(10) == 0)
            Enqueue(new("server", "api_json_ms", ms, null, route, JsonSerializer.Serialize(new { route })));
    }
    public (double? P50, double? P95, int Count) RouteSnapshot(string route)
    {
        if (!rings.TryGetValue(route, out var ring)) return (null, null, 0);
        double[] values; lock (ring) values = ring.Order().ToArray();
        return (Percentile(values, .5), Percentile(values, .95), values.Length);
    }
    public static double? Percentile(double[] sorted, double p)
    {
        if (sorted.Length == 0) return null;
        var position = (sorted.Length - 1) * p;
        var lo = (int)Math.Floor(position); var hi = (int)Math.Ceiling(position);
        return sorted[lo] + (sorted[hi] - sorted[lo]) * (position - lo);
    }
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(2));
        var nextCleanup = DateTimeOffset.MinValue;
        try
        {
            while (await timer.WaitForNextTickAsync(ct))
            {
                var batch = new List<PerfEvent>(512);
                while (batch.Count < 512 && queue.Reader.TryRead(out var item)) batch.Add(item);
                try
                {
                    await using var conn = await data.OpenConnectionAsync(ct);
                    if (batch.Count > 0)
                    {
                        // One round trip for the batch, bounded in both count and payload size.
                        var json = JsonSerializer.Serialize(batch.Select(e => new { source = e.Source, name = e.Name, value_ms = e.ValueMs, owner_id = e.Owner, route = e.Route, attrs = JsonSerializer.Deserialize<JsonElement>(e.Attrs) }));
                        await conn.ExecuteAsync(new CommandDefinition("""
                            INSERT INTO perf_events(source,name,value_ms,owner_id,route,attrs)
                            SELECT source,name,value_ms,owner_id,route,attrs FROM jsonb_to_recordset(CAST(@json AS jsonb))
                            AS x(source text,name text,value_ms double precision,owner_id uuid,route text,attrs jsonb)
                            """, new { json }, commandTimeout: 5, cancellationToken: ct));
                    }
                    if (DateTimeOffset.UtcNow >= nextCleanup)
                    {
                        await conn.ExecuteAsync(new CommandDefinition("DELETE FROM perf_events WHERE created_at < now() - interval '7 days'", commandTimeout: 10, cancellationToken: ct));
                        var minute = DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 60;
                        foreach (var entry in limits) if (entry.Value.Minute < minute - 1) limits.TryRemove(entry.Key, out _);
                        nextCleanup = DateTimeOffset.UtcNow.AddHours(1);
                    }
                }
                catch (Exception) when (!ct.IsCancellationRequested)
                {
                    Interlocked.Add(ref dropped, batch.Count);
                    logger.LogWarning("Speed telemetry batch unavailable; samples dropped");
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
    }
}

public static class RumValidation
{
    public static readonly HashSet<string> Names = ["echo_ms", "ack_ms", "first_token_screen_ms", "tool_chip_ms", "chat_switch_ms", "lcp_ms", "inp_ms", "cls"];
    public static string? SafeRoute(string? route) => route switch
    {
        "/" or "/settings" or "/login" or "/bots/[id]" or "/bots/{id}" or "/library" or "/routines" => route,
        _ => null
    };
    public static bool TryEvents(JsonElement body, Guid owner, out List<PerfEvent> events)
    {
        events = [];
        if (body.ValueKind != JsonValueKind.Object || !body.TryGetProperty("events", out var list) || list.ValueKind != JsonValueKind.Array || list.GetArrayLength() > 50) return false;
        foreach (var e in list.EnumerateArray())
        {
            if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty("name", out var name) || name.ValueKind != JsonValueKind.String || !Names.Contains(name.GetString()!) ||
                !e.TryGetProperty("value_ms", out var value) || value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var ms) || !double.IsFinite(ms)) return false;
            // Explicit numeric/boolean diagnostic allowlist. Strings, arrays, nested objects and unknown keys may contain content.
            var safe = new Dictionary<string, object>();
            if (e.TryGetProperty("attrs", out var attrs) && attrs.ValueKind == JsonValueKind.Object && attrs.GetRawText().Length <= 1024)
                foreach (var a in attrs.EnumerateObject().Take(8))
                    if (a.Name is "cached" or "proxy" or "sample_rate" or "duration" or "count")
                    {
                        if (a.Value.ValueKind == JsonValueKind.Number && a.Value.TryGetDouble(out var n) && double.IsFinite(n)) safe[a.Name] = Math.Clamp(n, 0, 600000);
                        else if (a.Value.ValueKind is JsonValueKind.True or JsonValueKind.False) safe[a.Name] = a.Value.GetBoolean();
                    }
            var route = e.TryGetProperty("route", out var r) && r.ValueKind == JsonValueKind.String ? SafeRoute(r.GetString()) : null;
            events.Add(new("client", name.GetString()!, Math.Clamp(ms, 0, 600000), owner, route, JsonSerializer.Serialize(safe)));
        }
        return true;
    }
    public static bool SameOrigin(HttpRequest request)
    {
        if (request.Headers["Sec-Fetch-Site"] == "cross-site") return false;
        var origin = request.Headers.Origin.ToString();
        return origin.Length == 0 || Uri.TryCreate(origin, UriKind.Absolute, out var uri) && uri.Authority.Equals(request.Host.Value, StringComparison.OrdinalIgnoreCase);
    }
}

public sealed record SpeedTarget(string Key, string Label, string Unit, double? P50, double? P95, string Source);
public static class SpeedTelemetry
{
    public static readonly SpeedTarget[] Targets = [
        new("echo_ms", "Message echo", "ms", 50, 100, "client"), new("ack_ms", "Acknowledgement", "ms", 1000, 1500, "client"),
        new("server_ttft_ms", "Server first token", "ms", 800, 1500, "model_calls"), new("model_total_ms", "Model total", "ms", null, null, "model_calls"),
        new("first_token_screen_ms", "First text on screen", "ms", 1000, 2000, "client"), new("tool_chip_ms", "Tool chip", "ms", 300, 600, "client"),
        new("chat_switch_ms", "Cached chat switch", "ms", 100, 200, "client"), new("sse_fanout_ms", "SSE fan-out", "ms", 100, 250, "server"),
        new("api_json_ms", "API JSON", "ms", 50, 150, "server"), new("wake_paused_ms", "Paused to awake", "ms", 1000, 2000, "server"),
        new("warm_pool_ready_ms", "Warm pool ready", "ms", 3000, 5000, "server"), new("lcp_ms", "Largest contentful paint", "ms", 1500, 2500, "client"),
        new("inp_ms", "Interaction to next paint", "ms", 100, 200, "client"), new("cache_hit_share", "Cache hit share (>70%)", "%", 70, null, "model_calls"),
        new("first_load_js_kb", "First-load JavaScript", "KB gzip", 200, 200, "ci")
    ];
    public const string Query = """
        WITH samples AS (
            SELECT name AS key, value_ms AS value FROM perf_events WHERE created_at >= now() - make_interval(hours => @hours)
            UNION ALL SELECT 'server_ttft_ms', ttft_ms FROM model_calls WHERE created_at >= now() - make_interval(hours => @hours) AND ttft_ms IS NOT NULL
            UNION ALL SELECT 'model_total_ms', total_ms FROM model_calls WHERE created_at >= now() - make_interval(hours => @hours) AND total_ms IS NOT NULL
        ) SELECT key, percentile_cont(0.5) WITHIN GROUP (ORDER BY value) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY value) AS p95, count(*) AS count FROM samples GROUP BY key
        """;
    public static IResult AdminGuard(string? role) => Access.IsStaff(role) ? Results.Ok() : Results.StatusCode(403);
    public static void Map(WebApplication app, Platform platform)
    {
        app.MapPost("/api/rum", async (HttpContext ctx, PerfRecorder recorder) =>
        {
            var user = await Routes.RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!RumValidation.SameOrigin(ctx.Request)) return Results.StatusCode(403);
            if (!recorder.AllowRum(user.Value)) return Results.StatusCode(429);
            const int maxBytes = 32768;
            if (ctx.Request.ContentLength > maxBytes) return Results.StatusCode(413);
            var buffer = new byte[maxBytes + 1]; var length = 0;
            while (length < buffer.Length)
            {
                var read = await ctx.Request.Body.ReadAsync(buffer.AsMemory(length), ctx.RequestAborted);
                if (read == 0) break;
                length += read;
            }
            if (length > maxBytes) return Results.StatusCode(413);
            try
            {
                using var doc = JsonDocument.Parse(buffer.AsMemory(0, length), new JsonDocumentOptions { MaxDepth = 8 });
                if (!RumValidation.TryEvents(doc.RootElement, user.Value, out var events)) return Results.BadRequest(new { error = "invalid_perf_events" });
                foreach (var e in events) recorder.Enqueue(e);
                return Results.Accepted();
            }
            catch (JsonException) { return Results.BadRequest(new { error = "invalid_perf_events" }); }
        });
        app.MapGet("/api/admin/speed", async (HttpContext ctx) =>
        {
            var user = await Routes.RequireUser(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync(ctx.RequestAborted);
            var role = await conn.ExecuteScalarAsync<string>("SELECT role FROM users WHERE id=@id", new { id = user });
            if (!Access.IsStaff(role)) return AdminGuard(role);
            var hours = int.TryParse(ctx.Request.Query["hours"], out var h) ? Math.Clamp(h, 1, 168) : 24;
            var rows = (await conn.QueryAsync<SpeedRow>(Query, new { hours })).ToDictionary(x => x.Key);
            var cache = await conn.QuerySingleAsync<SpeedRow>("""
                SELECT 'cache_hit_share' AS key, 100.0 * sum(cached_tokens) / NULLIF(sum(prompt_tokens),0) AS p50,
                    NULL::double precision AS p95, count(cached_tokens) AS count FROM model_calls
                WHERE created_at >= now() - make_interval(hours => @hours)
                """, new { hours });
            rows[cache.Key] = cache;
            return Results.Json(new { window_hours = hours, generated_at = DateTimeOffset.UtcNow, metrics = Targets.Select(t => {
                rows.TryGetValue(t.Key, out var row);
                return new { key = t.Key, label = t.Label, unit = t.Unit, p50 = row?.P50, p95 = row?.P95, count = row?.Count ?? 0, target_p50 = t.P50, target_p95 = t.P95, source = t.Source };
            }) });
        });
    }
    public sealed class SpeedRow { public string Key { get; set; } = ""; public double? P50 { get; set; } public double? P95 { get; set; } public long Count { get; set; } }
}
