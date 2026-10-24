using System.Net.Http.Json;
using Dapper;
using Npgsql;

namespace Teammates.Api;

public static class UptimeMath
{
    public const int Days = 90;

    public static string DayState(int up, int degraded, int down)
    {
        var total = up + degraded + down;
        if (total <= 0) return "nodata";
        if (down > 0 && down * 2 >= total) return "down";
        if (down > 0 || degraded > 0) return "degraded";
        return "up";
    }

    public static double? UptimePercent(int up, int degraded, int down)
    {
        var total = up + degraded + down;
        if (total <= 0) return null;
        return (up + degraded) * 100d / total;
    }

    public static (string Indicator, string Description) Banner(IEnumerable<string> statuses)
    {
        var list = statuses.ToList();
        if (list.Count == 0 || list.All(status => status == "nodata")) return ("empty", "No data yet");
        if (list.Any(status => status == "down")) return ("major", "Outage");
        if (list.Any(status => status == "degraded")) return ("minor", "Degraded");
        return ("none", "All systems operational");
    }
}

public static class UptimeCatalog
{
    public static readonly (string Id, string Name, string Description)[] Services =
    [
        ("api", "API", "The application API for sign-in, billing, and settings."),
        ("chat", "Chat/Realtime", "Live delivery of messages between you and your teammates."),
        ("computers", "Bot computers", "Computers teammates use for files and browsing."),
        ("agents", "Coding agents", "Workers that run coding jobs and routines."),
        ("integrations", "Integrations/Connectors", "Connected apps and remote plugins."),
        ("notifications", "Notifications", "System for sending notices to users."),
        ("storage", "Storage", "Database and workspace files."),
    ];
}

public static class UptimeBoard
{
    public static async Task<object> Load(NpgsqlConnection conn)
    {
        var since = DateTime.UtcNow.Date.AddDays(1 - UptimeMath.Days);
        var daily = (await conn.QueryAsync<(string Service, DateTime Day, int Up, int Degraded, int Down)>(
            """
            SELECT service, day::timestamp AS day, up_count AS up, degraded_count AS degraded, down_count AS down
            FROM uptime_daily
            WHERE day >= @since
            """,
            new { since })).ToList();
        var latest = (await conn.QueryAsync<(string Service, string Status)>(
            """
            SELECT DISTINCT ON (service) service, status
            FROM uptime_checks
            ORDER BY service, checked_at DESC
            """)).ToDictionary(row => row.Service, row => row.Status);
        var incidents = (await conn.QueryAsync<(Guid Id, string Service, string Title, string Status, DateTime StartedAt, DateTime? ResolvedAt)>(
            """
            SELECT id, service, title, status, started_at, resolved_at
            FROM uptime_incidents
            ORDER BY started_at DESC
            LIMIT 40
            """)).ToList();
        return Build(daily, latest, incidents);
    }

    public static object Build(
        IReadOnlyList<(string Service, DateTime Day, int Up, int Degraded, int Down)> daily,
        IReadOnlyDictionary<string, string> latest,
        IReadOnlyList<(Guid Id, string Service, string Title, string Status, DateTime StartedAt, DateTime? ResolvedAt)> incidents)
    {
        var today = DateTime.UtcNow.Date;
        var services = UptimeCatalog.Services.Select(service =>
        {
            var days = Enumerable.Range(0, UptimeMath.Days).Select(offset =>
            {
                var day = today.AddDays(offset - (UptimeMath.Days - 1));
                var row = daily.FirstOrDefault(item => item.Service == service.Id && item.Day.Date == day);
                var matched = row.Service == service.Id;
                var up = matched ? row.Up : 0;
                var degraded = matched ? row.Degraded : 0;
                var down = matched ? row.Down : 0;
                var overlapping = incidents.Count(item => item.Service == service.Id && item.StartedAt.Date <= day && (item.ResolvedAt == null || item.ResolvedAt.Value.Date >= day));
                return new
                {
                    date = day.ToString("yyyy-MM-dd"),
                    state = UptimeMath.DayState(up, degraded, down),
                    uptimePercent = UptimeMath.UptimePercent(up, degraded, down),
                    incidents = overlapping,
                };
            }).ToList();
            latest.TryGetValue(service.Id, out var current);
            if (current is not ("up" or "degraded" or "down")) current = "nodata";
            return new
            {
                id = service.Id,
                name = service.Name,
                description = service.Description,
                status = current,
                days,
            };
        }).ToList();
        var banner = UptimeMath.Banner(services.Select(service => service.status));
        return new
        {
            indicator = banner.Indicator,
            description = banner.Description,
            services,
            incidents = incidents.Select(item => new
            {
                id = item.Id,
                service = UptimeCatalog.Services.FirstOrDefault(service => service.Id == item.Service).Name ?? item.Service,
                title = item.Title,
                status = item.Status,
                startedAt = item.StartedAt,
                resolvedAt = item.ResolvedAt,
            }),
        };
    }
}

public static class UptimeStore
{
    public static async Task Record(NpgsqlConnection conn, string service, string status)
    {
        if (status is not ("up" or "degraded" or "down")) return;
        await conn.ExecuteAsync(
            "INSERT INTO uptime_checks (service, status) VALUES (@service, @status)",
            new { service, status });
        await conn.ExecuteAsync(
            """
            INSERT INTO uptime_daily (service, day, up_count, degraded_count, down_count)
            VALUES (@service, current_date, @up, @degraded, @down)
            ON CONFLICT (service, day) DO UPDATE SET
                up_count = uptime_daily.up_count + EXCLUDED.up_count,
                degraded_count = uptime_daily.degraded_count + EXCLUDED.degraded_count,
                down_count = uptime_daily.down_count + EXCLUDED.down_count
            """,
            new { service, up = status == "up" ? 1 : 0, degraded = status == "degraded" ? 1 : 0, down = status == "down" ? 1 : 0 });
        var open = (await conn.QueryAsync<Guid>(
            "SELECT id FROM uptime_incidents WHERE service=@service AND resolved_at IS NULL",
            new { service })).ToList();
        if (status == "up")
        {
            if (open.Count > 0)
                await conn.ExecuteAsync("UPDATE uptime_incidents SET status='resolved', resolved_at=now() WHERE service=@service AND resolved_at IS NULL", new { service });
            return;
        }
        if (open.Count > 0) return;
        var name = UptimeCatalog.Services.FirstOrDefault(item => item.Id == service).Name ?? service;
        var title = status == "down" ? $"{name} is down" : $"{name} is degraded";
        await conn.ExecuteAsync(
            "INSERT INTO uptime_incidents (service, title, status) VALUES (@service, @title, 'active')",
            new { service, title });
    }

    public static async Task Heartbeat(NpgsqlConnection conn, string name)
    {
        await conn.ExecuteAsync(
            """
            INSERT INTO uptime_heartbeats (name, seen_at) VALUES (@name, now())
            ON CONFLICT (name) DO UPDATE SET seen_at=now()
            """,
            new { name });
    }
}

public static class UptimeMonitor
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(3) };

    public static async Task Sweep(Platform platform, CancellationToken ct)
    {
        var probes = new (string Service, string Status)[]
        {
            ("api", await ProbeApi(platform, ct)),
            ("chat", await ProbeChat(platform, ct)),
            ("computers", await ProbeComputers(platform, ct)),
            ("agents", await ProbeAgents(platform, ct)),
            ("integrations", await ProbeIntegrations(platform, ct)),
            ("notifications", await ProbeNotifications(platform, ct)),
            ("storage", await ProbeStorage(platform, ct)),
        };
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        foreach (var probe in probes)
            await UptimeStore.Record(conn, probe.Service, probe.Status);
    }

    private static async Task<string> ProbeApi(Platform platform, CancellationToken ct)
    {
        try
        {
            var url = HealthUrl();
            using var response = await Http.GetAsync(url, ct);
            if (!response.IsSuccessStatusCode) return "down";
            var body = await response.Content.ReadFromJsonAsync<HealthBody>(ct);
            return body?.Ok == true ? "up" : "down";
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            try
            {
                await using var conn = await platform.Data.OpenConnectionAsync(ct);
                return await conn.ExecuteScalarAsync<int>("SELECT 1") == 1 ? "up" : "down";
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch
            {
                return "down";
            }
        }
    }

    private static async Task<string> ProbeChat(Platform platform, CancellationToken ct)
    {
        var id = Guid.NewGuid();
        var channel = System.Threading.Channels.Channel.CreateBounded<string>(1);
        platform.Sinks[id] = channel;
        try
        {
            await platform.Publish(new { type = "uptime.probe", id });
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(1));
            var frame = await channel.Reader.ReadAsync(timeout.Token);
            return frame.Contains("uptime.probe", StringComparison.Ordinal) ? "up" : "down";
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return "down";
        }
        finally
        {
            platform.Sinks.TryRemove(id, out _);
        }
    }

    private static async Task<string> ProbeComputers(Platform platform, CancellationToken ct)
    {
        try
        {
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var count = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM user_computers");
            if (count == 0) return "nodata";
            var report = await platform.Compute.HealthCheckAsync(ct);
            return report.Healthy ? "up" : "down";
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return "down";
        }
    }

    private static async Task<string> ProbeAgents(Platform platform, CancellationToken ct)
    {
        try
        {
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var seen = await conn.ExecuteScalarAsync<DateTime?>("SELECT seen_at FROM uptime_heartbeats WHERE name='worker'");
            if (seen == null) return "nodata";
            var age = DateTime.UtcNow - DateTime.SpecifyKind(seen.Value, DateTimeKind.Utc);
            if (age > TimeSpan.FromMinutes(2)) return "down";
            var stuck = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM tasks WHERE status='running' AND lease_until < now() - interval '1 minute'");
            return stuck > 0 ? "degraded" : "up";
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return "nodata";
        }
    }

    private static async Task<string> ProbeIntegrations(Platform platform, CancellationToken ct)
    {
        try
        {
            try { await PluginCatalog.ProbeHealth(platform.Data, 1, ct); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch { /* a failed probe is recorded on the catalog row when the call itself succeeds */ }
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var rows = (await conn.QueryAsync<(string? Status, DateTime? CheckedAt)>(
                """
                SELECT health_status AS status, health_checked_at AS checked_at
                FROM plugin_catalog
                WHERE transport='remote' AND NOT blocked AND coalesce(manifest->>'remoteUrl','') <> ''
                """)).ToList();
            var known = rows.Where(row => row.CheckedAt != null).ToList();
            if (known.Count == 0) return "nodata";
            var unhealthy = known.Count(row => string.Equals(row.Status, "unhealthy", StringComparison.OrdinalIgnoreCase));
            if (unhealthy == 0) return "up";
            if (unhealthy == known.Count) return "down";
            return "degraded";
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return "nodata";
        }
    }

    private static async Task<string> ProbeNotifications(Platform platform, CancellationToken ct)
    {
        try
        {
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            await using var tx = await conn.BeginTransactionAsync(ct);
            var id = await conn.ExecuteScalarAsync<Guid?>(
                """
                INSERT INTO notifications (user_id, kind, title, body)
                SELECT id, 'uptime', 'probe', 'probe' FROM users ORDER BY created_at LIMIT 1
                RETURNING id
                """,
                transaction: tx);
            if (id == null)
            {
                await tx.RollbackAsync(ct);
                return "nodata";
            }
            await conn.ExecuteAsync("DELETE FROM notifications WHERE id=@id", new { id }, tx);
            await tx.CommitAsync(ct);
            return "up";
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return "down";
        }
    }

    private static async Task<string> ProbeStorage(Platform platform, CancellationToken ct)
    {
        try
        {
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            var size = await conn.ExecuteScalarAsync<long>("SELECT pg_database_size(current_database())");
            if (size < 0) return "down";
            var root = "/data/workspace";
            if (!Directory.Exists(root)) return "degraded";
            var probe = Path.Combine(root, ".uptime-probe");
            await File.WriteAllTextAsync(probe, "ok", ct);
            File.Delete(probe);
            return "up";
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return "down";
        }
    }

    private static string HealthUrl()
    {
        var raw = Environment.GetEnvironmentVariable("ASPNETCORE_URLS") ?? "http://127.0.0.1:8080";
        var first = raw.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault() ?? "http://127.0.0.1:8080";
        first = first.Replace("0.0.0.0", "127.0.0.1", StringComparison.Ordinal).Replace("+", "127.0.0.1", StringComparison.Ordinal).Replace("*", "127.0.0.1", StringComparison.Ordinal);
        return first.TrimEnd('/') + "/health";
    }

    private sealed class HealthBody
    {
        public bool Ok { get; set; }
    }
}
