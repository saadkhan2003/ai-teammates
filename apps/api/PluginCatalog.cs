using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using Npgsql;
using Teammates.Compute;

namespace Teammates.Api;

public sealed record ProbeResult(string Kind, int ToolCount, string Detail, IReadOnlyList<PluginToolDef> Tools)
{
    public static ProbeResult Ok(IReadOnlyList<PluginToolDef> tools) => new("ok", tools.Count, "tools=" + tools.Count, tools);
    public static ProbeResult Unauthorized() => new("unauthorized", 0, "remote returned 401 or 403", []);
    public static ProbeResult Failed(string detail) => new("failed", 0, detail, []);
}

public static class PluginHttp
{
    public static HttpClient Client { get; } = new(new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        ConnectTimeout = TimeSpan.FromSeconds(4),
        PooledConnectionLifetime = TimeSpan.FromSeconds(30),
        MaxConnectionsPerServer = 8
    })
    { Timeout = TimeSpan.FromSeconds(45) };
}

public static class PluginProbe
{
    public static async Task<ProbeResult> RemoteTools(string url, CancellationToken ct)
    {
        var blocked = await SsrfGuard.ResolveAsync(url, ct);
        if (blocked.Blocked) return ProbeResult.Failed(blocked.Reason);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(PluginLimits.ProbeTimeoutSeconds));
        try
        {
            var init = await Send(url, """{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"teammates","version":"0.2"}}}""", null, timeout.Token);
            if (init.Status is 401 or 403) return ProbeResult.Unauthorized();
            if (init.Status is >= 300 and < 400) return ProbeResult.Failed("redirect");
            if (init.Status < 200 || init.Status >= 300) return ProbeResult.Failed("http_" + init.Status);
            var list = await Send(url, """{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}""", init.Session, timeout.Token);
            if (list.Status is 401 or 403) return ProbeResult.Unauthorized();
            if (list.Status is >= 300 and < 400) return ProbeResult.Failed("redirect");
            if (list.Status < 200 || list.Status >= 300) return ProbeResult.Failed("http_" + list.Status);
            var tools = ReadTools(list.Body);
            return tools == null ? ProbeResult.Failed("no_tool_list") : ProbeResult.Ok(tools);
        }
        catch (OperationCanceledException)
        {
            return ProbeResult.Failed("timeout");
        }
        catch (HttpRequestException)
        {
            return ProbeResult.Failed("connect");
        }
        catch (InvalidOperationException ex) when (ex.Message == "too_large")
        {
            return ProbeResult.Failed("too_large");
        }
    }

    public static async Task<string> ReadLimited(HttpContent content, int max, CancellationToken ct)
    {
        await using var stream = await content.ReadAsStreamAsync(ct);
        var buffer = new byte[8192];
        using var memory = new MemoryStream();
        while (memory.Length <= max)
        {
            var read = await stream.ReadAsync(buffer, ct);
            if (read == 0) break;
            var room = max + 1 - (int)memory.Length;
            memory.Write(buffer, 0, Math.Min(read, room));
            if (memory.Length > max) break;
        }
        if (memory.Length > max) throw new InvalidOperationException("too_large");
        return Encoding.UTF8.GetString(memory.ToArray());
    }

    private static List<PluginToolDef>? ReadTools(string body)
    {
        var json = body;
        if (body.Contains("data:", StringComparison.Ordinal))
        {
            foreach (var line in body.Split('\n'))
            {
                var trimmed = line.Trim();
                if (!trimmed.StartsWith("data:", StringComparison.Ordinal)) continue;
                var payload = trimmed[5..].Trim();
                if (payload.StartsWith('{')) { json = payload; break; }
            }
        }
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.TryGetProperty("error", out _)) return null;
            JsonElement tools;
            if (root.TryGetProperty("result", out var result) && result.ValueKind == JsonValueKind.Object && result.TryGetProperty("tools", out tools))
                return Map(tools);
            if (root.TryGetProperty("tools", out tools))
                return Map(tools);
            return null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static List<PluginToolDef> Map(JsonElement tools)
    {
        var list = new List<PluginToolDef>();
        if (tools.ValueKind != JsonValueKind.Array) return list;
        foreach (var tool in tools.EnumerateArray())
        {
            if (tool.ValueKind != JsonValueKind.Object) continue;
            var name = tool.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() ?? "" : "";
            if (name.Length == 0 || name.Length > 80) continue;
            var description = tool.TryGetProperty("description", out var d) && d.ValueKind == JsonValueKind.String ? d.GetString() ?? "" : "";
            if (description.Length > 400) description = description[..400];
            var action = PluginRisk.Derive(name, description, "GET");
            list.Add(new PluginToolDef(name, description, "", "", PluginRisk.Level(action), action));
            if (list.Count >= PluginLimits.MaxOperations) break;
        }
        return list;
    }

    private static async Task<(int Status, string Body, string? Session)> Send(string url, string json, string? session, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, url);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        request.Headers.UserAgent.ParseAdd("teammates/0.2");
        if (!string.IsNullOrEmpty(session)) request.Headers.TryAddWithoutValidation("Mcp-Session-Id", session);
        request.Content = new StringContent(json, Encoding.UTF8, "application/json");
        using var response = await PluginHttp.Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        var body = await ReadLimited(response.Content, 262_144, ct);
        string? next = null;
        if (response.Headers.TryGetValues("Mcp-Session-Id", out var values))
            next = values.FirstOrDefault();
        return ((int)response.StatusCode, body, next);
    }

    public static async Task<(bool Ok, string Detail)> Ping(string url, CancellationToken ct)
    {
        var blocked = await SsrfGuard.ResolveAsync(url, ct);
        if (blocked.Blocked) return (false, blocked.Reason);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(3));
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.UserAgent.ParseAdd("teammates/0.3");
        using var response = await PluginHttp.Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        var code = (int)response.StatusCode;
        return (code > 0 && code < 500, "status=" + code);
    }
}

public static class PluginCatalog
{
    public const string RegistrySource = "mcp-registry";

    public static void Map(WebApplication app, Platform platform)
    {
        app.MapGet("/api/plugins/catalog", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var query = ctx.Request.Query["q"].ToString();
            var category = ctx.Request.Query["category"].ToString();
            var label = ctx.Request.Query["label"].ToString();
            var offset = int.TryParse(ctx.Request.Query["offset"], out var skip) && skip > 0 ? skip : 0;
            await using var conn = await platform.Data.OpenConnectionAsync();
            var page = await Search(conn, query, category, label, offset, PluginLimits.CatalogPageSize);
            var stats = await Stats(conn);
            var categories = (await conn.QueryAsync<string>("SELECT category FROM plugin_catalog WHERE category <> '' GROUP BY category ORDER BY count(*) DESC LIMIT 12")).ToArray();
            return Results.Json(new { items = page.Items, total = page.Total, stats, categories });
        });

        app.MapGet("/api/plugins/enables", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync(
                """
                SELECT e.plugin_id, e.bot_id, e.enabled
                FROM plugin_bot_enable e
                JOIN plugins p ON p.id = e.plugin_id
                WHERE p.owner_user_id=@id
                """,
                new { id = user });
            return Results.Json(rows.Select(Platform.ToDict));
        });

        app.MapGet("/api/plugins/stats", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            return Results.Json(await Stats(conn));
        });

        app.MapPost("/api/plugins/install", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var catalogId = Text(body, "catalogId");
            if (catalogId.Length == 0) return Results.BadRequest(new { error = "catalogId is required" });
            await using var conn = await platform.Data.OpenConnectionAsync();
            var row = await conn.QuerySingleOrDefaultAsync<(string Id, string Name, string Kind, string Transport, string Auth, string Category, string Risk, string Trust, string Label, string Manifest, string Source, string Version, string Publisher, bool Blocked)>(
                """
                SELECT id, name, kind, transport, auth_type, category, risk, trust, label, manifest::text, source_url, version, publisher, blocked
                FROM plugin_catalog WHERE id=@id
                """,
                new { id = catalogId });
            if (row.Id == null) return Results.NotFound();
            if (row.Blocked) return Results.Json(new { error = "blocked" }, statusCode: 403);
            var label = PluginLabels.CheckLabels.Contains(row.Label) ? row.Label : "listed";
            var id = await conn.ExecuteScalarAsync<Guid?>(
                """
                INSERT INTO plugins (owner_user_id, name, kind, transport, manifest, auth_type, category, risk, trust, label, status, base_url, catalog_id, publisher, source_url, version)
                VALUES (@owner, @name, @kind, @transport, CAST(@manifest AS jsonb), @auth, @category, @risk, @trust, @label, 'installed', @source, @catalog, @publisher, @source, @version)
                ON CONFLICT (owner_user_id, catalog_id) WHERE catalog_id IS NOT NULL DO NOTHING
                RETURNING id
                """,
                new
                {
                    owner = user,
                    name = row.Name,
                    kind = row.Kind,
                    transport = row.Transport,
                    manifest = string.IsNullOrWhiteSpace(row.Manifest) ? "{}" : row.Manifest,
                    auth = row.Auth,
                    category = row.Category,
                    risk = row.Risk,
                    trust = row.Trust,
                    label,
                    source = row.Source,
                    catalog = row.Id,
                    publisher = row.Publisher,
                    version = row.Version
                });
            if (id == null)
                id = await conn.ExecuteScalarAsync<Guid>("SELECT id FROM plugins WHERE owner_user_id=@owner AND catalog_id=@catalog", new { owner = user, catalog = row.Id });
            await platform.Audit("user:" + user, "plugin.install", null, null, new { catalogId = row.Id, installId = id });
            return Results.Json(new { id, catalogId = row.Id, status = "installed" });
        });

        app.MapPut("/api/plugins/{id:guid}/bots/{botId:guid}", async (HttpContext ctx, Guid id, Guid botId, JsonElement body) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var enabled = !body.TryGetProperty("enabled", out var flag) || flag.ValueKind != JsonValueKind.False;
            await using var conn = await platform.Data.OpenConnectionAsync();
            var owns = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM plugins WHERE id=@id AND owner_user_id=@owner", new { id, owner = user });
            if (owns == 0) return Results.NotFound();
            var bot = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM bots WHERE id=@id AND owner_id=@owner", new { id = botId, owner = user });
            if (bot == 0) return Results.BadRequest(new { error = "unknown bot" });
            await conn.ExecuteAsync(
                """
                INSERT INTO plugin_bot_enable (plugin_id, bot_id, enabled) VALUES (@plugin, @bot, @enabled)
                ON CONFLICT (plugin_id, bot_id) DO UPDATE SET enabled=EXCLUDED.enabled
                """,
                new { plugin = id, bot = botId, enabled });
            return Results.Json(new { ok = true, enabled });
        });

        app.MapPost("/api/plugins/{id:guid}/connect", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var apiKey = Text(body, "apiKey");
            if (apiKey.Length == 0 || apiKey.Length > 4000) return Results.BadRequest(new { error = "apiKey is required" });
            await using var conn = await platform.Data.OpenConnectionAsync();
            var row = await conn.QuerySingleOrDefaultAsync<(Guid Id, string? Catalog, string Auth, string? Manifest)>(
                "SELECT id, catalog_id, auth_type, manifest::text FROM plugins WHERE id=@id AND owner_user_id=@owner",
                new { id, owner = user });
            if (row.Id == Guid.Empty) return Results.NotFound();
            var tools = await ModelToolNames(conn, row.Id, row.Catalog);
            var domains = await DomainsFor(conn, row.Catalog);
            var secretId = await platform.InsertSecret(user.Value, "plugin", row.Id.ToString("N"), "PLUGIN_CREDENTIAL", apiKey, "Plugin credential", tools, domains, null, "unknown");
            apiKey = "";
            await conn.ExecuteAsync("UPDATE plugins SET secret_id=@secret WHERE id=@id AND owner_user_id=@owner", new { secret = secretId, id, owner = user });
            var masked = await conn.ExecuteScalarAsync<string>("SELECT masked_suffix FROM secrets WHERE id=@id", new { id = secretId }) ?? "";
            await platform.Audit("user:" + user, "plugin.connect", null, null, new { installId = id, secretId, auth = "api_key" });
            return Results.Json(new { connected = true, secretId, masked });
        });

        app.MapPost("/api/plugins/{id:guid}/oauth/start", async (HttpContext ctx, Guid id) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var manifest = await conn.ExecuteScalarAsync<string>("SELECT manifest::text FROM plugins WHERE id=@id AND owner_user_id=@owner", new { id, owner = user });
            if (manifest == null) return Results.NotFound();
            var authorize = OauthField(manifest, "oauthAuthorize");
            if (authorize.Length == 0 || !AuthorizeUrlAllowed(authorize, platform.TestHooks))
                return Results.BadRequest(new { error = "oauth_not_configured" });
            var state = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
            await conn.ExecuteAsync(
                "INSERT INTO plugin_oauth_states (state, owner_user_id, plugin_id, expires_at) VALUES (@state, @owner, @plugin, now() + interval '10 minutes')",
                new { state, owner = user, plugin = id });
            var redirect = $"{ctx.Request.Scheme}://{ctx.Request.Host}/api/plugins/oauth/callback";
            var url = authorize + (authorize.Contains('?', StringComparison.Ordinal) ? "&" : "?")
                + "response_type=code&state=" + Uri.EscapeDataString(state)
                + "&redirect_uri=" + Uri.EscapeDataString(redirect);
            return Results.Json(new { url });
        });

        app.MapGet("/internal/test/oauth/authorize", async (HttpContext ctx) =>
        {
            if (!platform.TestHooks) return Results.NotFound();
            var state = ctx.Request.Query["state"].ToString();
            var redirect = ctx.Request.Query["redirect_uri"].ToString();
            if (state.Length == 0 || !Uri.TryCreate(redirect, UriKind.Absolute, out var target)) return Results.BadRequest();
            if (!target.AbsolutePath.Equals("/api/plugins/oauth/callback", StringComparison.Ordinal)) return Results.BadRequest();
            var host = target.IdnHost;
            var loopback = host.Equals("localhost", StringComparison.OrdinalIgnoreCase) || (IPAddress.TryParse(host, out var ip) && IPAddress.IsLoopback(ip));
            if (!loopback) return Results.BadRequest();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var exists = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM plugin_oauth_states WHERE state=@state AND expires_at > now()", new { state });
            if (exists == 0) return Results.BadRequest();
            var issued = MockOauth.Issue(state, redirect);
            var joiner = redirect.Contains('?', StringComparison.Ordinal) ? "&" : "?";
            return Results.Redirect(redirect + joiner + "code=" + Uri.EscapeDataString(issued) + "&state=" + Uri.EscapeDataString(state));
        });

        app.MapGet("/api/plugins/oauth/callback", async (HttpContext ctx) =>
        {
            var code = ctx.Request.Query["code"].ToString();
            var state = ctx.Request.Query["state"].ToString();
            if (code.Length == 0 || state.Length == 0) return Results.Redirect("/settings/plugins?connected=0");
            await using var conn = await platform.Data.OpenConnectionAsync();
            var row = await conn.QuerySingleOrDefaultAsync<(Guid Owner, Guid Plugin, string Manifest)>(
                """
                SELECT s.owner_user_id, s.plugin_id, p.manifest::text
                FROM plugin_oauth_states s
                JOIN plugins p ON p.id = s.plugin_id
                WHERE s.state=@state AND s.expires_at > now()
                """,
                new { state });
            await conn.ExecuteAsync("DELETE FROM plugin_oauth_states WHERE state=@state", new { state });
            if (row.Owner == Guid.Empty) return Results.Redirect("/settings/plugins?connected=0");
            var tokenUrl = OauthField(row.Manifest, "oauthToken");
            var redirect = $"{ctx.Request.Scheme}://{ctx.Request.Host}/api/plugins/oauth/callback";
            string token;
            if (platform.TestHooks && tokenUrl == MockOauth.TokenUrl)
            {
                token = MockOauth.Exchange(code, redirect) ?? "";
                if (token.Length == 0) return Results.Redirect("/settings/plugins?connected=0");
            }
            else
            {
            var blocked = tokenUrl.Length == 0 || (await SsrfGuard.ResolveAsync(tokenUrl, ctx.RequestAborted)).Blocked;
            if (blocked) return Results.Redirect("/settings/plugins?connected=0");
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, tokenUrl);
                request.Content = new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["grant_type"] = "authorization_code",
                    ["code"] = code,
                    ["redirect_uri"] = redirect
                });
                using var response = await PluginHttp.Client.SendAsync(request, ctx.RequestAborted);
                var raw = await PluginProbe.ReadLimited(response.Content, 65_536, ctx.RequestAborted);
                if (!response.IsSuccessStatusCode) return Results.Redirect("/settings/plugins?connected=0");
                using var doc = JsonDocument.Parse(raw);
                token = doc.RootElement.TryGetProperty("access_token", out var access) ? access.GetString() ?? "" : "";
            }
            catch (Exception)
            {
                return Results.Redirect("/settings/plugins?connected=0");
            }
            }
            if (token.Length == 0) return Results.Redirect("/settings/plugins?connected=0");
            var tools = await ModelToolNames(conn, row.Plugin, await conn.ExecuteScalarAsync<string>("SELECT catalog_id FROM plugins WHERE id=@id", new { id = row.Plugin }));
            var domains = await DomainsFor(conn, await conn.ExecuteScalarAsync<string>("SELECT catalog_id FROM plugins WHERE id=@id", new { id = row.Plugin }));
            var secretId = await platform.InsertSecret(row.Owner, "plugin", row.Plugin.ToString("N"), "PLUGIN_CREDENTIAL", token, "Plugin OAuth token", tools, domains, null, "unknown");
            token = "";
            await conn.ExecuteAsync("UPDATE plugins SET secret_id=@secret, auth_type='oauth' WHERE id=@id", new { secret = secretId, id = row.Plugin });
            await platform.Audit("user:" + row.Owner, "plugin.connect", null, null, new { installId = row.Plugin, secretId, auth = "oauth" });
            return Results.Redirect("/settings/plugins?connected=1");
        });

        app.MapPost("/api/plugins/{id:guid}/call", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var botText = Text(body, "botId");
            if (!Guid.TryParse(botText, out var botId)) return Results.BadRequest(new { error = "botId is required" });
            var tool = Text(body, "tool");
            var args = body.TryGetProperty("args", out var argsEl) && argsEl.ValueKind == JsonValueKind.Object ? argsEl : JsonDocument.Parse("{}").RootElement;
            await using var conn = await platform.Data.OpenConnectionAsync();
            var owned = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM bots WHERE id=@id AND owner_id=@owner", new { id = botId, owner = user });
            if (owned == 0) return Results.NotFound();
            return await Call(platform, user.Value, botId, null, id, tool, args, ctx.RequestAborted);
        });

        app.MapPost("/api/plugins/openapi", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var name = Text(body, "name");
            OpenApiGeneration generated;
            if (body.TryGetProperty("spec", out var spec) && spec.ValueKind == JsonValueKind.String)
                generated = OpenApiSpec.Generate(spec.GetString() ?? "", Text(body, "sourceUrl"), name);
            else if (Text(body, "url").Length > 0)
                generated = await GenerateFromUrl(Text(body, "url"), name, ctx.RequestAborted);
            else
                return Results.BadRequest(new { error = "spec or url is required" });
            if (!generated.Ok || generated.Manifest == null) return Results.BadRequest(new { error = generated.Error });
            await using var conn = await platform.Data.OpenConnectionAsync();
            await Upsert(conn, generated.Manifest);
            return Results.Json(Public(generated.Manifest));
        });

        app.MapPost("/api/admin/plugins", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!Access.IsStaff(await Role(platform, user.Value))) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            var manifest = FromAdmin(body);
            var validation = PluginManifestRules.Validate(manifest);
            if (!validation.Ok) return Results.BadRequest(new { error = validation.Error });
            var check = PluginManifestRules.InitialCheck(manifest, validation);
            manifest = manifest with { Label = check.Label, CheckStatus = check.Status, CheckDetail = check.Detail };
            await using var conn = await platform.Data.OpenConnectionAsync();
            await Upsert(conn, manifest);
            await platform.Audit("user:" + user, "plugin.catalog", null, null, new { id = manifest.Id, label = manifest.Label });
            return Results.Json(Public(manifest));
        });

        app.MapPost("/api/admin/plugins/{id}/block", async (HttpContext ctx, string id, JsonElement body) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!Access.IsStaff(await Role(platform, user.Value))) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            var blocked = !body.TryGetProperty("blocked", out var flag) || flag.ValueKind != JsonValueKind.False;
            var reason = Text(body, "reason");
            if (reason.Length > 200) reason = reason[..200];
            await using var conn = await platform.Data.OpenConnectionAsync();
            var n = await conn.ExecuteAsync("UPDATE plugin_catalog SET blocked=@blocked, blocked_reason=@reason, updated_at=now() WHERE id=@id", new { id, blocked, reason });
            if (n == 0) return Results.NotFound();
            await platform.Audit("user:" + user, "plugin.block", null, null, new { id, blocked });
            return Results.Json(new { ok = true, blocked });
        });

        app.MapPost("/api/admin/plugins/jobs", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!Access.IsStaff(await Role(platform, user.Value))) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            var kind = Text(body, "kind");
            if (kind is not ("import" or "check" or "health")) return Results.BadRequest(new { error = "kind must be import, check, or health" });
            await using var conn = await platform.Data.OpenConnectionAsync();
            var id = await conn.ExecuteScalarAsync<long>("INSERT INTO plugin_jobs (kind, status) VALUES (@kind, 'queued') RETURNING id", new { kind });
            return Results.Json(new { id, kind, status = "queued" });
        });

        app.MapGet("/internal/bots/{id:guid}/plugin-tools", async (HttpContext ctx, Guid id) =>
        {
            if (!Worker(ctx, platform)) return Results.Unauthorized();
            var flat = new List<object>();
            foreach (var tool in await EnabledLines(platform, id, ctx.RequestAborted))
                flat.Add(new { name = tool.Name, description = tool.Description, riskLabel = tool.Label });
            return Results.Json(new { tools = flat });
        });

        app.MapGet("/internal/test/plugin-audit", async (HttpContext ctx) =>
        {
            if (!platform.TestHooks || !Worker(ctx, platform)) return Results.NotFound();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var rows = await conn.QueryAsync("SELECT action, detail::text AS detail FROM audit_events WHERE action LIKE 'plugin.%' ORDER BY id DESC LIMIT 20");
            return Results.Json(rows.Select(Platform.ToDict));
        });
    }

    public static async Task<IResult> Call(Platform platform, Guid owner, Guid botId, Guid? taskId, Guid installId, string tool, JsonElement args, CancellationToken ct)
    {
        var loaded = await LoadCall(platform, owner, botId, installId, tool, ct);
        if (loaded.Error != null) 
        {
            await platform.Audit("plugin", "plugin.denied", botId, taskId, new { tool, reason = loaded.Error });
            return Results.Json(new { ok = false, status = "denied", reason = loaded.Error });
        }
        var hint = new PluginCallHint(loaded.ActionClass, loaded.Description, loaded.Method, loaded.RiskLabel);
        var policy = await SecurityRoutes.Load(platform, owner);
        var rules = await SecurityRoutes.DenyRules(platform);
        var decision = PolicyGate.Evaluate(loaded.ModelName, args, new HashSet<string>(), policy, rules, null, false, null, hint);
        if (decision.Decision == PolicyEngine.Deny)
        {
            await platform.Audit("plugin", "plugin.denied", botId, taskId, new { tool = loaded.ModelName, reason = decision.Reason, riskClass = decision.RiskClass });
            return Results.Json(new { ok = false, status = "denied", reason = decision.Reason, riskClass = decision.RiskClass });
        }
        if (decision.Decision == PolicyEngine.Ask)
        {
            await platform.Audit("plugin", "plugin.ask", botId, taskId, new { tool = loaded.ModelName, riskClass = decision.RiskClass, summary = decision.Summary });
            return Results.Json(new { ok = false, status = "waiting_approval", decision = "ask", riskClass = decision.RiskClass, summary = decision.Summary });
        }
        try
        {
            var output = await Invoke(platform, owner, botId, taskId, loaded, args, ct);
            await platform.Audit("plugin", "plugin.call", botId, taskId, new { tool = loaded.ModelName, riskClass = decision.RiskClass, catalogId = loaded.CatalogId });
            return Results.Json(new { ok = true, output, riskClass = decision.RiskClass });
        }
        catch (ToolHalt halt)
        {
            await platform.Audit("plugin", "plugin.denied", botId, taskId, new { tool = loaded.ModelName, reason = halt.Reason });
            return Results.Json(new { ok = false, status = halt.Status, reason = halt.Reason });
        }
    }

    public static async Task<object> InvokeEnabled(Platform platform, Guid owner, Guid botId, Guid taskId, string modelName, JsonElement args, CancellationToken ct)
    {
        var loaded = await LoadByModelName(platform, owner, botId, modelName, ct);
        if (loaded.Error != null)
        {
            await platform.Audit("plugin", "plugin.denied", botId, taskId, new { tool = modelName, reason = loaded.Error });
            throw new ToolHalt("denied", loaded.Error);
        }
        var output = await Invoke(platform, owner, botId, taskId, loaded, args, ct);
        await platform.Audit("plugin", "plugin.call", botId, taskId, new { tool = modelName, catalogId = loaded.CatalogId });
        return output;
    }

    public static async Task<PluginCallHint?> Hint(Platform platform, Guid botId, string modelName, CancellationToken ct)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var owner = await conn.ExecuteScalarAsync<Guid?>("SELECT owner_id FROM bots WHERE id=@id", new { id = botId });
        if (owner == null) return null;
        var loaded = await LoadByModelName(platform, owner.Value, botId, modelName, ct);
        if (loaded.Error != null) return new PluginCallHint(PluginRisk.Derive(modelName, "", ""), "", "");
        return new PluginCallHint(loaded.ActionClass, loaded.Description, loaded.Method, loaded.RiskLabel);
    }

    public static async Task<object[]> ModelTools(Platform platform, Guid botId, int cap, CancellationToken ct)
    {
        try
        {
            _ = cap;
            var lines = await EnabledLines(platform, botId, ct, 40);
            if (lines.Count == 0) return [];
            var total = await EnabledCount(platform, botId, ct);
            var index = ToolIndex.Compact(lines, total);
            return
            [
                MetaTool("search_tools", "Search the plugin tool index. Returns names and one-line descriptions, not full schemas.\n" + index, ("query", "string", "Words to match")),
                MetaTool("load_tool", "Load the full JSON schema for one plugin tool from the index.", ("name", "string", "Tool name from the index"))
            ];
        }
        catch (PostgresException)
        {
            return [];
        }
    }

    public static async Task<IReadOnlyList<ToolLine>> EnabledLines(Platform platform, Guid botId, CancellationToken ct, int limit = 0)
    {
        var lines = new List<ToolLine>();
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var rows = await conn.QueryAsync<(Guid Id, string Tools)>(
            """
            SELECT p.id, c.tools::text
            FROM plugin_bot_enable e
            JOIN plugins p ON p.id = e.plugin_id
            JOIN plugin_catalog c ON c.id = p.catalog_id
            WHERE e.bot_id=@bot AND e.enabled AND NOT c.blocked
              AND c.check_status <> 'failed'
              AND coalesce(c.health_status, 'unknown') <> 'unhealthy'
            ORDER BY p.created_at
            """,
            new { bot = botId });
        foreach (var row in rows)
        {
            foreach (var tool in PluginManifestJson.ReadTools(row.Tools))
            {
                var action = string.IsNullOrEmpty(tool.ActionClass) ? PluginRisk.Derive(tool.Name, tool.Description, tool.Method) : tool.ActionClass;
                var label = PluginRiskLabels.Apply(action, tool.RiskLabel.Length > 0 ? tool.RiskLabel : PluginRiskLabels.FromAction(action));
                lines.Add(new ToolLine(PluginIds.ModelTool(row.Id, tool.Name), tool.Description, PluginRiskLabels.FromAction(label)));
                if (limit > 0 && lines.Count >= limit) return lines;
            }
        }
        return lines;
    }

    private static async Task<int> EnabledCount(Platform platform, Guid botId, CancellationToken ct)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        return await conn.ExecuteScalarAsync<int>(
            """
            SELECT count(*)
            FROM plugin_bot_enable e
            JOIN plugins p ON p.id = e.plugin_id
            JOIN plugin_catalog c ON c.id = p.catalog_id
            CROSS JOIN LATERAL jsonb_array_elements(c.tools) tool
            WHERE e.bot_id=@bot AND e.enabled AND NOT c.blocked
              AND c.check_status <> 'failed'
              AND coalesce(c.health_status, 'unknown') <> 'unhealthy'
            """,
            new { bot = botId });
    }

    public static async Task<object> SearchTools(Platform platform, Guid botId, string query, CancellationToken ct)
    {
        var needle = (query ?? "").Trim();
        var like = "%" + needle.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var rows = await conn.QueryAsync<(Guid Id, string Name, string Description, string Action, string Label)>(
            """
            SELECT p.id, tool->>'name', coalesce(tool->>'description',''), coalesce(tool->>'actionClass',''), coalesce(tool->>'riskLabel','')
            FROM plugin_bot_enable e
            JOIN plugins p ON p.id = e.plugin_id
            JOIN plugin_catalog c ON c.id = p.catalog_id
            CROSS JOIN LATERAL jsonb_array_elements(c.tools) tool
            WHERE e.bot_id=@bot AND e.enabled AND NOT c.blocked
              AND c.check_status <> 'failed'
              AND coalesce(c.health_status, 'unknown') <> 'unhealthy'
              AND (@needle = '' OR tool->>'name' ILIKE @like OR tool->>'description' ILIKE @like)
            ORDER BY p.created_at
            LIMIT 8
            """,
            new { bot = botId, needle, like });
        var hits = new List<ToolLine>();
        foreach (var row in rows)
        {
            var action = string.IsNullOrEmpty(row.Action) ? PluginRisk.Derive(row.Name, row.Description, "") : row.Action;
            var label = PluginRiskLabels.FromAction(PluginRiskLabels.Apply(action, row.Label));
            hits.Add(new ToolLine(PluginIds.ModelTool(row.Id, row.Name), row.Description, label));
        }
        return new { tools = hits.Select(hit => new { name = hit.Name, description = hit.Description, riskLabel = hit.Label }).ToArray() };
    }

    public static async Task<object> LoadTool(Platform platform, Guid botId, string name, CancellationToken ct)
    {
        var loaded = await LoadByModelName(platform, await OwnerOfBot(platform, botId, ct), botId, name, ct);
        if (loaded.Error != null) return new { ok = false, reason = loaded.Error };
        return new { ok = true, schema = ToolIndex.Schema(loaded.ModelName, loaded.Description, loaded.Method, loaded.Path) };
    }

    private static async Task<Guid> OwnerOfBot(Platform platform, Guid botId, CancellationToken ct)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        return await conn.ExecuteScalarAsync<Guid>("SELECT owner_id FROM bots WHERE id=@id", new { id = botId });
    }

    private static Dictionary<string, object> MetaTool(string name, string description, params (string Name, string Type, string Description)[] fields)
    {
        var properties = new Dictionary<string, object>();
        var required = new List<string>();
        foreach (var field in fields)
        {
            var schema = new Dictionary<string, object> { ["type"] = field.Type, ["description"] = field.Description };
            if (field.Type == "array") schema["items"] = new Dictionary<string, string> { ["type"] = "string" };
            properties[field.Name] = schema;
            required.Add(field.Name);
        }
        return new Dictionary<string, object>
        {
            ["type"] = "function",
            ["function"] = new Dictionary<string, object>
            {
                ["name"] = name,
                ["description"] = description,
                ["parameters"] = new Dictionary<string, object> { ["type"] = "object", ["properties"] = properties, ["required"] = required }
            }
        };
    }

    public static async Task<int> ImportRegistry(NpgsqlConnection conn, string registryBase, bool fresh, int maxPages, CancellationToken ct)
    {
        if (fresh)
            await conn.ExecuteAsync("UPDATE plugin_import_state SET cursor='', pages=0, updated_at=now() WHERE source=@source", new { source = RegistrySource });
        var cursor = await conn.ExecuteScalarAsync<string>("SELECT cursor FROM plugin_import_state WHERE source=@source", new { source = RegistrySource }) ?? "";
        var pages = 0;
        var imported = 0;
        while (pages < maxPages)
        {
            ct.ThrowIfCancellationRequested();
            var url = registryBase.TrimEnd('/') + "/v0.1/servers?limit=100";
            if (cursor.Length > 0) url += "&cursor=" + Uri.EscapeDataString(cursor);
            var json = await GetWithRetry(url, ct);
            var page = McpRegistry.Parse(json);
            var manifests = McpRegistry.Dedupe(page.Entries);
            if (manifests.Count > 0)
            {
                await using var tx = await conn.BeginTransactionAsync(ct);
                foreach (var manifest in manifests)
                    await Upsert(conn, manifest, tx);
                await tx.CommitAsync(ct);
                imported += manifests.Count;
            }
            pages++;
            cursor = page.NextCursor;
            await conn.ExecuteAsync(
                """
                INSERT INTO plugin_import_state (source, cursor, pages, updated_at) VALUES (@source, @cursor, @pages, now())
                ON CONFLICT (source) DO UPDATE SET cursor=EXCLUDED.cursor, pages=plugin_import_state.pages + 1, updated_at=now()
                """,
                new { source = RegistrySource, cursor, pages = 1 });
            if (cursor.Length == 0 || page.Entries.Count == 0) break;
        }
        return imported;
    }

    public static async Task<int> CheckPending(NpgsqlDataSource data, int limit, int concurrency, CancellationToken ct)
    {
        await using var conn = await data.OpenConnectionAsync(ct);
        var rows = (await conn.QueryAsync<(string Id, string Remote)>(
            """
            SELECT id, manifest->>'remoteUrl' AS remote
            FROM plugin_catalog
            WHERE check_status='pending' AND transport='remote' AND auth_type='none' AND NOT blocked
              AND coalesce(manifest->>'remoteUrl','') <> ''
            ORDER BY imported_at
            LIMIT @limit
            """,
            new { limit })).ToList();
        var done = 0;
        using var gate = new SemaphoreSlim(Math.Max(1, concurrency));
        var tasks = rows.Select(async row =>
        {
            await gate.WaitAsync(ct);
            try
            {
                ProbeResult probe;
                try
                {
                    probe = await PluginProbe.RemoteTools(row.Remote, ct);
                }
                catch (Exception) when (!ct.IsCancellationRequested)
                {
                    probe = ProbeResult.Failed("probe_error");
                }
                try
                {
                    await using var update = await data.OpenConnectionAsync(ct);
                    await ApplyProbe(update, row.Id, probe);
                }
                catch (PostgresException)
                {
                    await using var update = await data.OpenConnectionAsync(ct);
                    await ApplyProbe(update, row.Id, ProbeResult.Failed("invalid_tool_json"));
                }
                Interlocked.Increment(ref done);
            }
            finally
            {
                gate.Release();
            }
        });
        await Task.WhenAll(tasks);
        return done;
    }

    public static async Task<int> ProbeHealth(NpgsqlDataSource data, int limit, CancellationToken ct)
    {
        await using var conn = await data.OpenConnectionAsync(ct);
        var rows = (await conn.QueryAsync<(string Id, string Remote)>(
            """
            SELECT id, manifest->>'remoteUrl'
            FROM plugin_catalog
            WHERE transport='remote' AND NOT blocked
              AND coalesce(manifest->>'remoteUrl','') <> ''
              AND (health_checked_at IS NULL OR health_checked_at < now() - interval '12 hours')
            ORDER BY health_checked_at NULLS FIRST
            LIMIT @limit
            """,
            new { limit })).ToList();
        var done = 0;
        foreach (var row in rows)
        {
            ct.ThrowIfCancellationRequested();
            string status;
            string detail;
            try
            {
                var ping = await PluginProbe.Ping(row.Remote, ct);
                status = ping.Ok ? "healthy" : "unhealthy";
                detail = ping.Detail;
            }
            catch (Exception) when (!ct.IsCancellationRequested)
            {
                status = "unhealthy";
                detail = "probe_error";
            }
            if (detail.Length > 200) detail = detail[..200];
            await using var update = await data.OpenConnectionAsync(ct);
            await update.ExecuteAsync(
                """
                UPDATE plugin_catalog
                SET health_status=@status, health_detail=@detail, health_checked_at=now(), updated_at=now()
                WHERE id=@id
                """,
                new { id = row.Id, status, detail });
            done++;
        }
        return done;
    }

    public static async Task ApplyProbe(NpgsqlConnection conn, string id, ProbeResult probe)
    {
        var (label, status, detail) = probe.Kind switch
        {
            "ok" => ("auto-checked", "passed", probe.Detail),
            "unauthorized" => ("needs-auth", "needs-auth", probe.Detail),
            _ => ("failed", "failed", probe.Detail)
        };
        var tools = probe.Tools.Count > 0 ? PluginManifestJson.Tools(probe.Tools) : null;
        var risk = probe.Tools.Count > 0 ? PluginRisk.Highest(probe.Tools.Select(tool => tool.Risk)) : null;
        await conn.ExecuteAsync(
            """
            UPDATE plugin_catalog SET
                label=@label,
                check_status=@status,
                check_detail=@detail,
                checked_at=now(),
                updated_at=now(),
                tools=COALESCE(CAST(@tools AS jsonb), tools),
                risk=COALESCE(@risk, risk)
            WHERE id=@id AND check_status='pending'
            """,
            new { id, label, status, detail, tools, risk });
    }

    public static async Task Upsert(NpgsqlConnection conn, PluginManifest manifest, NpgsqlTransaction? tx = null)
    {
        await conn.ExecuteAsync(
            """
            INSERT INTO plugin_catalog (
                id, name, publisher, source_url, version, kind, transport, auth_type, category, risk, trust,
                label, check_status, check_detail, tools, manifest, dedupe_key)
            VALUES (
                @id, @name, @publisher, @source, @version, @kind, @transport, @auth, @category, @risk, @trust,
                @label, @status, @detail, CAST(@tools AS jsonb), CAST(@manifest AS jsonb), @dedupe)
            ON CONFLICT (dedupe_key) DO UPDATE SET
                name=EXCLUDED.name,
                publisher=EXCLUDED.publisher,
                source_url=EXCLUDED.source_url,
                version=EXCLUDED.version,
                kind=EXCLUDED.kind,
                transport=EXCLUDED.transport,
                auth_type=EXCLUDED.auth_type,
                category=EXCLUDED.category,
                trust=EXCLUDED.trust,
                manifest=EXCLUDED.manifest,
                tools=CASE WHEN plugin_catalog.check_status='passed' THEN plugin_catalog.tools ELSE EXCLUDED.tools END,
                risk=CASE WHEN plugin_catalog.check_status='passed' THEN plugin_catalog.risk ELSE EXCLUDED.risk END,
                label=CASE WHEN plugin_catalog.check_status IN ('passed','needs-auth') AND EXCLUDED.check_status='pending' THEN plugin_catalog.label ELSE EXCLUDED.label END,
                check_status=CASE WHEN plugin_catalog.check_status IN ('passed','needs-auth') AND EXCLUDED.check_status='pending' THEN plugin_catalog.check_status ELSE EXCLUDED.check_status END,
                check_detail=CASE WHEN plugin_catalog.check_status IN ('passed','needs-auth') AND EXCLUDED.check_status='pending' THEN plugin_catalog.check_detail ELSE EXCLUDED.check_detail END,
                updated_at=now()
            """,
            new
            {
                id = manifest.Id,
                name = manifest.Name,
                publisher = manifest.Publisher,
                source = manifest.SourceUrl,
                version = manifest.Version,
                kind = manifest.Kind,
                transport = manifest.Transport,
                auth = manifest.AuthType,
                category = manifest.Category,
                risk = manifest.Risk,
                trust = manifest.Trust,
                label = manifest.Label,
                status = manifest.CheckStatus,
                detail = manifest.CheckDetail,
                tools = PluginManifestJson.Tools(manifest.Tools),
                manifest = PluginManifestJson.Document(manifest),
                dedupe = manifest.DedupeKey
            },
            tx);
    }

    public static async Task<Dictionary<string, int>> Stats(NpgsqlConnection conn)
    {
        var rows = await conn.QueryAsync<(string Label, string CheckStatus)>("SELECT label, check_status FROM plugin_catalog");
        return new Dictionary<string, int>(CatalogStats.Count(rows));
    }

    private static async Task<string> GetWithRetry(string url, CancellationToken ct)
    {
        Exception? last = null;
        for (var attempt = 0; attempt < 4; attempt++)
        {
            ct.ThrowIfCancellationRequested();
            var blocked = await SsrfGuard.ResolveAsync(url, ct);
            if (blocked.Blocked && blocked.Reason != "dns")
                throw new InvalidOperationException("registry url blocked: " + blocked.Reason);
            if (blocked.Blocked)
            {
                last = new InvalidOperationException("registry url blocked: dns");
                await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2, attempt)), ct);
                continue;
            }
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, url);
                request.Headers.UserAgent.ParseAdd("teammates/0.2");
                request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
                using var response = await PluginHttp.Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
                if ((int)response.StatusCode is 429 or >= 500)
                {
                    last = new HttpRequestException("status " + (int)response.StatusCode);
                    await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2, attempt)), ct);
                    continue;
                }
                response.EnsureSuccessStatusCode();
                return await PluginProbe.ReadLimited(response.Content, PluginLimits.MaxRegistryPageBytes, ct);
            }
            catch (Exception ex) when ((ex is HttpRequestException or TaskCanceledException) && !ct.IsCancellationRequested)
            {
                last = ex;
                await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2, attempt)), ct);
            }
        }
        throw new InvalidOperationException("registry page failed: " + (last?.Message ?? "unknown"));
    }

    private static async Task<(List<Dictionary<string, object?>> Items, int Total)> Search(NpgsqlConnection conn, string query, string category, string label, int offset, int limit)
    {
        var like = "%" + query.Trim().Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";
        var needle = query.Trim();
        var total = await conn.ExecuteScalarAsync<int>(
            """
            SELECT count(*) FROM plugin_catalog
            WHERE (@needle = '' OR name ILIKE @like OR publisher ILIKE @like OR id ILIKE @like)
              AND (@category = '' OR category ILIKE @category)
              AND (
                @label = ''
                OR label = @label
                OR trust = @label
                OR risk = @label
                OR (@label = 'verified' AND (trust = 'verified' OR label = 'tested'))
              )
            """,
            new { needle, like, category, label });
        var rows = await conn.QueryAsync(
            """
            SELECT id, name, publisher, source_url, version, kind, transport, auth_type, category, risk, trust, label, check_status, check_detail, blocked, health_status, health_detail
            FROM plugin_catalog
            WHERE (@needle = '' OR name ILIKE @like OR publisher ILIKE @like OR id ILIKE @like)
              AND (@category = '' OR category ILIKE @category)
              AND (
                @label = ''
                OR label = @label
                OR trust = @label
                OR risk = @label
                OR (@label = 'verified' AND (trust = 'verified' OR label = 'tested'))
              )
            ORDER BY name
            LIMIT @limit OFFSET @offset
            """,
            new { needle, like, category, label, limit, offset });
        var items = new List<Dictionary<string, object?>>();
        foreach (var row in rows)
        {
            var dict = Platform.ToDict((object)row);
            var itemLabel = dict.TryGetValue("label", out var labelValue) ? labelValue?.ToString() ?? "" : "";
            var trust = dict.TryGetValue("trust", out var trustValue) ? trustValue?.ToString() ?? "" : "";
            var risk = dict.TryGetValue("risk", out var riskValue) ? riskValue?.ToString() ?? "" : "";
            dict["labels"] = PluginLabels.Of(itemLabel, trust, risk);
            items.Add(dict);
        }
        return (items, total);
    }

    private sealed class LoadedCall
    {
        public string? Error { get; init; }
        public Guid InstallId { get; init; }
        public string CatalogId { get; init; } = "";
        public string ModelName { get; init; } = "";
        public string ToolName { get; init; } = "";
        public string Transport { get; init; } = "";
        public string AuthType { get; init; } = "";
        public string RemoteUrl { get; init; } = "";
        public string Method { get; init; } = "";
        public string Path { get; init; } = "";
        public string Description { get; init; } = "";
        public string ActionClass { get; init; } = ActionClasses.Write;
        public string RiskLabel { get; init; } = "";
        public string[] Command { get; init; } = [];
        public Guid? SecretId { get; init; }
        public static LoadedCall Fail(string error) => new() { Error = error };
    }

    private static async Task<LoadedCall> LoadCall(Platform platform, Guid owner, Guid botId, Guid installId, string tool, CancellationToken ct)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var row = await conn.QuerySingleOrDefaultAsync<(Guid Id, string? Catalog, string Auth, string Transport, string? Secret, bool Blocked, string Tools, string Remote, string Check, string Health, string Manifest)>(
            """
            SELECT p.id, p.catalog_id, p.auth_type, coalesce(c.transport, p.transport), p.secret_id::text,
                   coalesce(c.blocked, false), coalesce(c.tools, p.manifest->'tools')::text,
                   coalesce(c.manifest->>'remoteUrl', ''),
                   coalesce(c.check_status, 'passed'),
                   coalesce(c.health_status, 'unknown'),
                   coalesce(c.manifest, p.manifest)::text
            FROM plugins p
            LEFT JOIN plugin_catalog c ON c.id = p.catalog_id
            WHERE p.id=@id AND p.owner_user_id=@owner
            """,
            new { id = installId, owner });
        if (row.Id == Guid.Empty) return LoadedCall.Fail("not_installed");
        if (!PluginHealth.VisibleToBots(row.Check, row.Health, row.Blocked))
            return LoadedCall.Fail(row.Blocked ? "blocked" : "plugin_unhealthy");
        var enabled = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM plugin_bot_enable WHERE plugin_id=@id AND bot_id=@bot AND enabled", new { id = installId, bot = botId });
        if (enabled == 0) return LoadedCall.Fail("not_enabled");
        var tools = PluginManifestJson.ReadTools(row.Tools);
        var match = tools.FirstOrDefault(item => item.Name == tool || PluginIds.ModelTool(installId, item.Name) == tool);
        if (match == null) return LoadedCall.Fail("unknown_tool");
        var derived = string.IsNullOrEmpty(match.ActionClass) ? PluginRisk.Derive(match.Name, match.Description, match.Method) : match.ActionClass;
        var label = match.RiskLabel.Length > 0 ? match.RiskLabel : PluginRiskLabels.FromAction(derived);
        var action = PluginRiskLabels.Apply(derived, label);
        return new LoadedCall
        {
            InstallId = installId,
            CatalogId = row.Catalog ?? "",
            ModelName = PluginIds.ModelTool(installId, match.Name),
            ToolName = match.Name,
            Transport = row.Transport,
            AuthType = row.Auth,
            RemoteUrl = row.Remote,
            Method = match.Method,
            Path = match.Path,
            Description = match.Description,
            ActionClass = action,
            RiskLabel = PluginRiskLabels.FromAction(action),
            Command = ReadCommand(row.Manifest),
            SecretId = Guid.TryParse(row.Secret, out var secret) ? secret : null
        };
    }

    private static async Task<LoadedCall> LoadByModelName(Platform platform, Guid owner, Guid botId, string modelName, CancellationToken ct)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var ids = await conn.QueryAsync<Guid>(
            """
            SELECT p.id FROM plugin_bot_enable e
            JOIN plugins p ON p.id = e.plugin_id
            WHERE e.bot_id=@bot AND e.enabled AND p.owner_user_id=@owner
            """,
            new { bot = botId, owner });
        foreach (var id in ids)
        {
            var prefix = "plugin_" + id.ToString("N")[..8] + "_";
            if (!modelName.StartsWith(prefix, StringComparison.Ordinal)) continue;
            var loaded = await LoadCall(platform, owner, botId, id, modelName, ct);
            if (loaded.Error == null) return loaded;
        }
        return LoadedCall.Fail("not_enabled");
    }

    private static async Task<object> Invoke(Platform platform, Guid owner, Guid botId, Guid? taskId, LoadedCall loaded, JsonElement args, CancellationToken ct)
    {
        if (loaded.AuthType is "api_key" or "oauth" && loaded.SecretId == null)
            throw new ToolHalt("denied", "needs_auth");
        byte[]? secret = null;
        if (loaded.SecretId != null)
        {
            var reference = "secret://plugin/" + loaded.InstallId.ToString("N");
            var destination = loaded.RemoteUrl.Length > 0 ? loaded.RemoteUrl : null;
            var resolved = await platform.ResolveDetailed(owner, reference, loaded.ModelName, botId, destination, taskId, "plugin");
            if (resolved.Value == null) throw new ToolHalt("denied", resolved.Deny ?? "secret_denied");
            secret = resolved.Value;
        }
        try
        {
            return await OutboundLog.Run(platform, owner, botId, taskId, loaded.ModelName, loaded.ActionClass, args, () => DispatchCall(platform, botId, loaded, args, secret, ct), ct);
        }
        finally
        {
            if (secret != null) CryptographicOperations.ZeroMemory(secret);
        }
    }

    private static async Task<object> DispatchCall(Platform platform, Guid botId, LoadedCall loaded, JsonElement args, byte[]? secret, CancellationToken ct)
    {
        if (loaded.Transport == "builtin")
            return new { tool = loaded.ToolName, args = RedactedArgs(args) };
        if (loaded.Transport == "stdio")
            return await CallStdio(platform, botId, loaded, args, ct);
        if (loaded.Method.Length > 0 && loaded.Path.Length > 0)
            return await CallOpenApi(loaded, args, secret, ct);
        return await CallMcp(loaded, args, secret, ct);
    }

    private static async Task<object> CallStdio(Platform platform, Guid botId, LoadedCall loaded, JsonElement args, CancellationToken ct)
    {
        var rpc = JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 1,
            method = "tools/call",
            @params = new
            {
                name = loaded.ToolName,
                arguments = args.ValueKind == JsonValueKind.Undefined ? JsonDocument.Parse("{}").RootElement : args
            }
        });
        var plan = StdioMcp.Plan(loaded.Command, rpc);
        if (!plan.Ok) throw new ToolHalt("denied", plan.Error);
        var placement = await platform.PlacementForBot(botId, ct);
        try
        {
            var (code, stdout, stderr) = await ExecInComputer(platform, placement.Computer, botId, plan.Argv, ct);
            var text = stdout.Length > 0 ? stdout : stderr;
            if (text.Length > 8000) text = text[..8000];
            return new { exitCode = code, body = Dlp.Redact(text), sandboxed = true };
        }
        catch (ComputeException)
        {
            throw new ToolHalt("denied", "computer_unavailable");
        }
    }

    private static async Task<(int Code, string Stdout, string Stderr)> ExecInComputer(Platform platform, ComputerId id, Guid botId, IReadOnlyList<string> argv, CancellationToken ct)
    {
        var spec = await BotFs.ConfinedAsync(platform.Compute, id, botId, argv, null, null, TimeSpan.FromSeconds(8), 32_768, ct);
        return await BotFs.Capture(platform.Compute, spec, ct);
    }

    private static string[] ReadCommand(string manifest)
    {
        try
        {
            using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(manifest) ? "{}" : manifest);
            if (!doc.RootElement.TryGetProperty("stdioCommand", out var command) || command.ValueKind != JsonValueKind.Array)
                return [];
            return command.EnumerateArray().Select(item => item.ValueKind == JsonValueKind.String ? item.GetString() ?? "" : "").Where(item => item.Length > 0).ToArray();
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private static async Task<object> CallOpenApi(LoadedCall loaded, JsonElement args, byte[]? secret, CancellationToken ct)
    {
        var path = loaded.Path;
        if (args.ValueKind == JsonValueKind.Object)
        {
            foreach (var prop in args.EnumerateObject())
                path = path.Replace("{" + prop.Name + "}", Uri.EscapeDataString(prop.Value.ToString()), StringComparison.Ordinal);
        }
        var baseUrl = loaded.RemoteUrl.TrimEnd('/');
        var url = path.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? path : baseUrl + (path.StartsWith('/') ? path : "/" + path);
        var blocked = await SsrfGuard.ResolveAsync(url, ct);
        if (blocked.Blocked) throw new ToolHalt("denied", blocked.Reason);
        using var request = new HttpRequestMessage(new HttpMethod(loaded.Method), url);
        ApplySecret(request, loaded.AuthType, secret);
        if (loaded.Method is "POST" or "PUT" or "PATCH")
            request.Content = new StringContent(args.ValueKind == JsonValueKind.Undefined ? "{}" : args.GetRawText(), Encoding.UTF8, "application/json");
        using var response = await PluginHttp.Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        var body = await PluginProbe.ReadLimited(response.Content, 32_768, ct);
        body = Dlp.Redact(body);
        if (secret != null)
        {
            var token = Encoding.UTF8.GetString(secret);
            if (token.Length > 0) body = body.Replace(token, "[redacted]", StringComparison.Ordinal);
        }
        return new { status = (int)response.StatusCode, body };
    }

    private static async Task<object> CallMcp(LoadedCall loaded, JsonElement args, byte[]? secret, CancellationToken ct)
    {
        var blocked = await SsrfGuard.ResolveAsync(loaded.RemoteUrl, ct);
        if (blocked.Blocked) throw new ToolHalt("denied", blocked.Reason);
        var payload = JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 1,
            method = "tools/call",
            @params = new { name = loaded.ToolName, arguments = args.ValueKind == JsonValueKind.Undefined ? JsonDocument.Parse("{}").RootElement : args }
        });
        using var request = new HttpRequestMessage(HttpMethod.Post, loaded.RemoteUrl);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Content = new StringContent(payload, Encoding.UTF8, "application/json");
        ApplySecret(request, loaded.AuthType, secret);
        using var response = await PluginHttp.Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        var body = await PluginProbe.ReadLimited(response.Content, 32_768, ct);
        body = Dlp.Redact(body);
        return new { status = (int)response.StatusCode, body };
    }

    private static void ApplySecret(HttpRequestMessage request, string auth, byte[]? secret)
    {
        if (secret == null || secret.Length == 0) return;
        var token = Encoding.UTF8.GetString(secret);
        if (auth == "oauth") request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        else request.Headers.TryAddWithoutValidation("X-Api-Key", token);
    }

    private static object RedactedArgs(JsonElement args)
    {
        if (args.ValueKind != JsonValueKind.Object) return new { };
        var copy = new Dictionary<string, string>();
        foreach (var prop in args.EnumerateObject())
        {
            if (prop.Name.Contains("secret", StringComparison.OrdinalIgnoreCase) || prop.Name.Contains("token", StringComparison.OrdinalIgnoreCase) || prop.Name.Contains("key", StringComparison.OrdinalIgnoreCase))
                continue;
            var text = prop.Value.ValueKind == JsonValueKind.String ? prop.Value.GetString() ?? "" : prop.Value.ToString();
            copy[prop.Name] = Dlp.Redact(text);
        }
        return copy;
    }

    private static async Task<OpenApiGeneration> GenerateFromUrl(string url, string name, CancellationToken ct)
    {
        var blocked = await SsrfGuard.ResolveAsync(url, ct);
        if (blocked.Blocked) return new OpenApiGeneration(false, "blocked_source:" + blocked.Reason, null);
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.UserAgent.ParseAdd("teammates/0.2");
        using var response = await PluginHttp.Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if ((int)response.StatusCode is >= 300 and < 400) return new OpenApiGeneration(false, "redirect", null);
        if (!response.IsSuccessStatusCode) return new OpenApiGeneration(false, "fetch_failed", null);
        string body;
        try
        {
            body = await PluginProbe.ReadLimited(response.Content, PluginLimits.MaxSpecBytes, ct);
        }
        catch (InvalidOperationException)
        {
            return new OpenApiGeneration(false, "spec_too_large", null);
        }
        return OpenApiSpec.Generate(body, url, name);
    }

    private static PluginManifest FromAdmin(JsonElement body)
    {
        var name = Text(body, "name");
        var kind = PluginModel.NormalizePluginKind(Text(body, "kind", "builtin"));
        if (kind == "oauth") kind = "builtin";
        var transport = Text(body, "transport");
        if (transport.Length == 0) transport = kind == "builtin" ? "builtin" : "remote";
        if (transport is "sse" or "streamable-http" or "http") transport = "remote";
        var auth = Text(body, "authType", "none").ToLowerInvariant();
        var tools = new List<PluginToolDef>();
        if (body.TryGetProperty("tools", out var toolEl) && toolEl.ValueKind == JsonValueKind.Array)
        {
            foreach (var tool in toolEl.EnumerateArray())
            {
                var toolName = tool.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
                var description = tool.TryGetProperty("description", out var d) ? d.GetString() ?? "" : "";
                var method = tool.TryGetProperty("method", out var m) ? m.GetString() ?? "" : "";
                var action = PluginRisk.Derive(toolName, description, method);
                tools.Add(new PluginToolDef(toolName, description, method, tool.TryGetProperty("path", out var p) ? p.GetString() ?? "" : "", PluginRisk.Level(action), action));
            }
        }
        var command = new List<string>();
        if (body.TryGetProperty("command", out var commandEl) && commandEl.ValueKind == JsonValueKind.Array)
        {
            foreach (var part in commandEl.EnumerateArray())
                if (part.ValueKind == JsonValueKind.String && part.GetString() is { Length: > 0 } text)
                    command.Add(text);
        }
        var dedupe = Text(body, "dedupeKey");
        if (dedupe.Length == 0) dedupe = kind + ":" + name.Trim().ToLowerInvariant();
        var remote = Text(body, "remoteUrl");
        return new PluginManifest(
            PluginIds.For(kind, dedupe),
            name,
            Text(body, "publisher", "teammates"),
            Text(body, "sourceUrl"),
            Text(body, "version", "1"),
            kind,
            transport,
            auth,
            Text(body, "category", "Built-in"),
            PluginRisk.Highest(tools.Select(tool => tool.Risk)),
            Text(body, "trust", "community"),
            "listed",
            "pending",
            "",
            dedupe,
            remote,
            Text(body, "packageRef"),
            tools,
            Text(body, "oauthAuthorize"),
            Text(body, "oauthToken"),
            "",
            command);
    }

    private static object Public(PluginManifest manifest) => new
    {
        id = manifest.Id,
        name = manifest.Name,
        publisher = manifest.Publisher,
        sourceUrl = manifest.SourceUrl,
        version = manifest.Version,
        kind = manifest.Kind,
        transport = manifest.Transport,
        authType = manifest.AuthType,
        category = manifest.Category,
        risk = manifest.Risk,
        trust = manifest.Trust,
        label = manifest.Label,
        checkStatus = manifest.CheckStatus,
        checkDetail = manifest.CheckDetail,
        labels = PluginLabels.Of(manifest.Label, manifest.Trust, manifest.Risk),
        tools = manifest.Tools.Select(tool => tool.Name).ToArray()
    };

    private static async Task<string[]> ModelToolNames(NpgsqlConnection conn, Guid installId, string? catalogId)
    {
        var json = await conn.ExecuteScalarAsync<string>(
            "SELECT tools::text FROM plugin_catalog WHERE id=@id",
            new { id = catalogId ?? "" });
        return PluginManifestJson.ReadTools(json).Select(tool => PluginIds.ModelTool(installId, tool.Name)).ToArray();
    }

    private static async Task<string[]> DomainsFor(NpgsqlConnection conn, string? catalogId)
    {
        if (string.IsNullOrWhiteSpace(catalogId)) return [];
        var remote = await conn.ExecuteScalarAsync<string>("SELECT manifest->>'remoteUrl' FROM plugin_catalog WHERE id=@id", new { id = catalogId });
        if (string.IsNullOrWhiteSpace(remote) || !Uri.TryCreate(remote, UriKind.Absolute, out var uri)) return [];
        return [uri.GetLeftPart(UriPartial.Authority)];
    }

    private static bool AuthorizeUrlAllowed(string url, bool testHooks)
    {
        if (!SsrfGuard.LiteralBlocked(url, out _)) return true;
        if (!testHooks || !Uri.TryCreate(url, UriKind.Absolute, out var uri)) return false;
        if (!uri.AbsolutePath.Equals("/internal/test/oauth/authorize", StringComparison.Ordinal)) return false;
        return IPAddress.TryParse(uri.IdnHost, out var ip) && IPAddress.IsLoopback(ip);
    }

    private static string OauthField(string manifest, string name)
    {
        try
        {
            using var doc = JsonDocument.Parse(manifest);
            if (doc.RootElement.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String)
                return value.GetString() ?? "";
        }
        catch (JsonException)
        {
            return "";
        }
        return "";
    }

    private static async Task<Guid?> User(HttpContext ctx, Platform platform)
    {
        ctx.Request.Cookies.TryGetValue("teammates_session", out var token);
        return await platform.UserForSession(token);
    }

    private static async Task<string?> Role(Platform platform, Guid user)
    {
        await using var conn = await platform.Data.OpenConnectionAsync();
        return await conn.ExecuteScalarAsync<string>("SELECT role FROM users WHERE id=@id", new { id = user });
    }

    private static bool Worker(HttpContext ctx, Platform platform)
    {
        var header = ctx.Request.Headers.Authorization.ToString();
        var token = header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? header[7..].Trim() : "";
        var expected = Encoding.UTF8.GetBytes(platform.WorkerToken);
        var presented = Encoding.UTF8.GetBytes(token);
        return expected.Length > 0 && presented.Length == expected.Length && CryptographicOperations.FixedTimeEquals(presented, expected);
    }

    private static string Text(JsonElement body, string name, string fallback = "")
    {
        if (body.ValueKind != JsonValueKind.Object || !body.TryGetProperty(name, out var el) || el.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            return fallback;
        return el.ValueKind == JsonValueKind.String ? el.GetString() ?? fallback : fallback;
    }
}

public sealed class PluginCatalogJob(Platform platform, IConfiguration config, ILogger<PluginCatalogJob> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await using var conn = await platform.Data.OpenConnectionAsync(stoppingToken);
            await conn.ExecuteAsync("UPDATE plugin_jobs SET status='queued', started_at=NULL WHERE status='running'");
        }
        catch (Exception ex)
        {
            logger.LogDebug("plugin job reset skipped {Message}", ex.Message);
        }
        var minutes = CatalogSchedule.ImportIntervalMinutes(config["PLUGIN_IMPORT_INTERVAL_MINUTES"]);
        var next = minutes > 0 ? DateTimeOffset.UtcNow.AddMinutes(minutes) : DateTimeOffset.MaxValue;
        var nextHealth = DateTimeOffset.UtcNow.AddMinutes(15);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (minutes > 0 && DateTimeOffset.UtcNow >= next)
                {
                    await using var conn = await platform.Data.OpenConnectionAsync(stoppingToken);
                    await conn.ExecuteAsync("INSERT INTO plugin_jobs (kind, status, detail) VALUES ('import', 'queued', '{\"scheduled\":true}'::jsonb)");
                    next = DateTimeOffset.UtcNow.AddMinutes(minutes);
                }
                if (DateTimeOffset.UtcNow >= nextHealth)
                {
                    await using var conn = await platform.Data.OpenConnectionAsync(stoppingToken);
                    var queued = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM plugin_jobs WHERE kind='health' AND status IN ('queued','running')");
                    if (queued == 0)
                        await conn.ExecuteAsync("INSERT INTO plugin_jobs (kind, status) VALUES ('health', 'queued')");
                    nextHealth = DateTimeOffset.UtcNow.AddMinutes(15);
                }
                await RunOne(stoppingToken);
            }
            catch (Exception ex)
            {
                logger.LogWarning("plugin job skipped {Message}", ex.Message);
            }
            try { await Task.Delay(TimeSpan.FromSeconds(15), stoppingToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task RunOne(CancellationToken ct)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var id = await conn.ExecuteScalarAsync<long?>("SELECT id FROM plugin_jobs WHERE status='queued' ORDER BY id LIMIT 1");
        if (id == null) return;
        var claimed = await conn.ExecuteAsync("UPDATE plugin_jobs SET status='running', started_at=now() WHERE id=@id AND status='queued'", new { id });
        if (claimed == 0) return;
        var kind = await conn.ExecuteScalarAsync<string>("SELECT kind FROM plugin_jobs WHERE id=@id", new { id });
        try
        {
            if (kind == "import")
            {
                var registry = config["MCP_REGISTRY_URL"] ?? McpRegistry.DefaultBase;
                var detail = await conn.ExecuteScalarAsync<string>("SELECT detail::text FROM plugin_jobs WHERE id=@id") ?? "";
                var pages = detail.Contains("scheduled", StringComparison.Ordinal) ? CatalogSchedule.ScheduledPages : 20;
                var count = await PluginCatalog.ImportRegistry(conn, registry, fresh: false, maxPages: pages, ct);
                await conn.ExecuteAsync("UPDATE plugin_jobs SET status='done', finished_at=now(), detail=jsonb_build_object('imported', @count) WHERE id=@id", new { id, count });
            }
            else if (kind == "health")
            {
                var count = await PluginCatalog.ProbeHealth(platform.Data, limit: 4, ct);
                await conn.ExecuteAsync("UPDATE plugin_jobs SET status='done', finished_at=now(), detail=jsonb_build_object('probed', @count) WHERE id=@id", new { id, count });
            }
            else
            {
                var count = await PluginCatalog.CheckPending(platform.Data, limit: 40, concurrency: 4, ct);
                await conn.ExecuteAsync("UPDATE plugin_jobs SET status='done', finished_at=now(), detail=jsonb_build_object('checked', @count) WHERE id=@id", new { id, count });
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning("plugin job failed {Message}", ex.Message);
            await conn.ExecuteAsync("UPDATE plugin_jobs SET status='failed', finished_at=now(), detail=jsonb_build_object('error', @error) WHERE id=@id", new { id, error = "failed" });
        }
    }
}
