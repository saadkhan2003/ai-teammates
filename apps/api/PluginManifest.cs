using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Teammates.Api;

public static class PluginLimits
{
    public const int MaxSpecBytes = 1_048_576;
    public const int MaxOperations = 80;
    public const int MaxModelTools = 24;
    public const int MaxRegistryPageBytes = 8_000_000;
    public const int ProbeTimeoutSeconds = 5;
    public const int CatalogPageSize = 40;
    public const int Target = 6000;
}

public sealed record PluginToolDef(string Name, string Description, string Method, string Path, string Risk, string ActionClass, string RiskLabel = "");

public sealed record PluginManifest(
    string Id,
    string Name,
    string Publisher,
    string SourceUrl,
    string Version,
    string Kind,
    string Transport,
    string AuthType,
    string Category,
    string Risk,
    string Trust,
    string Label,
    string CheckStatus,
    string CheckDetail,
    string DedupeKey,
    string RemoteUrl,
    string PackageRef,
    IReadOnlyList<PluginToolDef> Tools,
    string OauthAuthorize,
    string OauthToken,
    string Summary,
    IReadOnlyList<string>? StdioCommand = null);

public sealed record ManifestValidation(bool Ok, string Error);

public sealed record PluginCallHint(string ActionClass, string Description, string Method, string RiskLabel = "");

public static class PluginIds
{
    public static string For(string kind, string dedupeKey)
    {
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(dedupeKey))).ToLowerInvariant()[..24];
        var prefix = kind is "mcp" or "openapi" or "builtin" ? kind : "plugin";
        return prefix + "_" + hash;
    }

    public static string ModelTool(Guid installId, string toolName)
    {
        var prefix = "plugin_" + installId.ToString("N")[..8];
        var safe = Regex.Replace(toolName.ToLowerInvariant(), "[^a-z0-9_]+", "_").Trim('_');
        if (safe.Length == 0) safe = "tool";
        var full = prefix + "_" + safe;
        return full.Length <= 64 ? full : full[..64];
    }

    public static bool IsPluginTool(string? name) =>
        !string.IsNullOrEmpty(name) && name.StartsWith("plugin_", StringComparison.Ordinal);
}

public static class PluginLabels
{
    public static readonly string[] CheckLabels = ["listed", "auto-checked", "tested", "failed", "needs-auth"];

    public static string[] Of(string label, string trust, string risk)
    {
        var list = new List<string>();
        if (!string.IsNullOrWhiteSpace(label)) list.Add(label);
        if (trust is "verified" or "community" or "official") list.Add(trust);
        if (label == "tested") list.Add("tested");
        if (risk is "low" or "medium" or "high" or "unknown") list.Add(risk);
        return list.Distinct(StringComparer.Ordinal).ToArray();
    }

    /// <summary>Only a passed automated check or an explicit tested label counts. Skipped and pending do not.</summary>
    public static bool CountsTowardTarget(string label) => label is "auto-checked" or "tested";
}

public static class CatalogStats
{
    public static IReadOnlyDictionary<string, int> Count(IEnumerable<(string Label, string CheckStatus)> rows)
    {
        var imported = 0;
        var autoChecked = 0;
        var needsAuth = 0;
        var failed = 0;
        var skipped = 0;
        var pending = 0;
        var tested = 0;
        foreach (var row in rows)
        {
            imported++;
            if (row.Label == "auto-checked") autoChecked++;
            if (row.Label == "tested") tested++;
            if (row.Label == "needs-auth" || row.CheckStatus == "needs-auth") needsAuth++;
            if (row.Label == "failed" || row.CheckStatus == "failed") failed++;
            if (row.CheckStatus == "skipped") skipped++;
            if (row.CheckStatus == "pending") pending++;
        }
        return new Dictionary<string, int>
        {
            ["imported"] = imported,
            ["autoChecked"] = autoChecked,
            ["needsAuth"] = needsAuth,
            ["failed"] = failed,
            ["skipped"] = skipped,
            ["pending"] = pending,
            ["tested"] = tested,
            ["countsTowardTarget"] = autoChecked + tested
        };
    }
}

public static class PluginRisk
{
    private static readonly HashSet<string> Payment = new(StringComparer.Ordinal)
    {
        "pay", "payment", "charge", "invoice", "refund", "billing", "checkout", "purchase", "payout", "wire", "buy"
    };

    private static readonly HashSet<string> Send = new(StringComparer.Ordinal)
    {
        "send", "email", "sms", "notify"
    };

    private static readonly HashSet<string> Publish = new(StringComparer.Ordinal)
    {
        "publish", "tweet", "post"
    };

    private static readonly HashSet<string> Delete = new(StringComparer.Ordinal)
    {
        "delete", "remove", "destroy", "drop", "purge", "wipe", "shred", "uninstall", "truncate"
    };

    private static readonly HashSet<string> Read = new(StringComparer.Ordinal)
    {
        "get", "list", "read", "search", "fetch", "query", "describe", "find", "show", "lookup", "head"
    };

    public static string Derive(string name, string? description, string? httpMethod)
    {
        var tokens = Tokens(name + " " + (description ?? ""));
        var method = (httpMethod ?? "").Trim().ToUpperInvariant();
        if (tokens.Overlaps(Payment) || name.Contains("transfer_funds", StringComparison.OrdinalIgnoreCase))
            return ActionClasses.Payment;
        if (method == "DELETE" || tokens.Overlaps(Delete))
            return ActionClasses.Delete;
        if (tokens.Overlaps(Publish) && !tokens.Overlaps(Read))
            return ActionClasses.ExternalPost;
        var readish = method is "GET" or "HEAD" or "OPTIONS" || tokens.Overlaps(Read);
        if (tokens.Overlaps(Send) && !readish)
            return ActionClasses.SendMessage;
        if (readish && !tokens.Overlaps(Send))
            return ActionClasses.Read;
        if (tokens.Overlaps(Send))
            return ActionClasses.SendMessage;
        return ActionClasses.Write;
    }

    public static string Level(string actionClass) => actionClass switch
    {
        ActionClasses.Read => "low",
        ActionClasses.Write => "medium",
        _ => "high"
    };

    public static string Highest(IEnumerable<string> levels)
    {
        var rank = 0;
        var found = false;
        foreach (var level in levels)
        {
            found = true;
            rank = Math.Max(rank, level switch
            {
                "high" => 3,
                "medium" => 2,
                "low" => 1,
                _ => 0
            });
        }
        if (!found) return "unknown";
        return rank switch
        {
            3 => "high",
            2 => "medium",
            1 => "low",
            _ => "unknown"
        };
    }

    public static string ClassifyCall(string tool, JsonElement args, PluginCallHint? hint)
    {
        if (hint != null && ActionClasses.All.Contains(hint.ActionClass))
            return hint.ActionClass;
        if (PluginIds.IsPluginTool(tool))
            return Derive(tool, hint?.Description, hint?.Method);
        return ActionClassifier.Classify(tool, args);
    }

    private static HashSet<string> Tokens(string text)
    {
        var set = new HashSet<string>(StringComparer.Ordinal);
        foreach (var part in Regex.Split(text.ToLowerInvariant(), "[^a-z0-9]+"))
        {
            if (part.Length > 0) set.Add(part);
        }
        return set;
    }
}

public static class SsrfGuard
{
    public static bool LiteralBlocked(string? url, out string reason)
    {
        reason = "";
        if (string.IsNullOrWhiteSpace(url))
        {
            reason = "missing_url";
            return true;
        }
        if (url.Contains("://", StringComparison.Ordinal) && url.StartsWith("file:", StringComparison.OrdinalIgnoreCase))
        {
            reason = "file_scheme";
            return true;
        }
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            reason = "bad_url";
            return true;
        }
        return UriBlocked(uri, null, out reason);
    }

    public static bool UriBlocked(Uri uri, IEnumerable<IPAddress>? resolved, out string reason)
    {
        reason = "";
        if (uri.Scheme is not ("http" or "https"))
        {
            reason = "scheme";
            return true;
        }
        if (!string.IsNullOrEmpty(uri.UserInfo))
        {
            reason = "userinfo";
            return true;
        }
        var host = uri.IdnHost.Trim().TrimEnd('.');
        if (host.Length == 0)
        {
            reason = "host";
            return true;
        }
        if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".local", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".internal", StringComparison.OrdinalIgnoreCase)
            || host.Equals("metadata.google.internal", StringComparison.OrdinalIgnoreCase)
            || host.Equals("0", StringComparison.Ordinal))
        {
            reason = "local_name";
            return true;
        }
        if (IPAddress.TryParse(host, out var literal) && AddressBlocked(literal))
        {
            reason = "private_ip";
            return true;
        }
        if (uint.TryParse(host, NumberStyles.None, CultureInfo.InvariantCulture, out var dec))
        {
            var raw = new byte[] { (byte)(dec >> 24), (byte)(dec >> 16), (byte)(dec >> 8), (byte)dec };
            if (AddressBlocked(new IPAddress(raw)))
            {
                reason = "private_ip";
                return true;
            }
        }
        if (resolved != null)
        {
            foreach (var address in resolved)
            {
                if (AddressBlocked(address))
                {
                    reason = "private_ip";
                    return true;
                }
            }
        }
        return false;
    }

    public static bool AddressBlocked(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        if (IPAddress.IsLoopback(address) || address.Equals(IPAddress.Any) || address.Equals(IPAddress.IPv6Any))
            return true;
        if (address.AddressFamily == AddressFamily.InterNetworkV6)
        {
            var bytes = address.GetAddressBytes();
            if ((bytes[0] & 0xfe) == 0xfc) return true; // fc00::/7
            if (bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80) return true; // fe80::/10
            return false;
        }
        var v4 = address.GetAddressBytes();
        if (v4.Length != 4) return true;
        if (v4[0] == 0 || v4[0] == 10 || v4[0] == 127) return true;
        if (v4[0] == 169 && v4[1] == 254) return true;
        if (v4[0] == 172 && v4[1] >= 16 && v4[1] <= 31) return true;
        if (v4[0] == 192 && v4[1] == 168) return true;
        if (v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127) return true; // CGNAT
        if (v4[0] == 192 && v4[1] == 0 && v4[2] == 2) return true;
        if (v4[0] == 198 && v4[1] == 51 && v4[2] == 100) return true;
        if (v4[0] == 203 && v4[1] == 0 && v4[2] == 113) return true;
        if (v4[0] >= 224) return true; // multicast and reserved
        return false;
    }

    public static async Task<(bool Blocked, string Reason)> ResolveAsync(string url, CancellationToken ct)
    {
        if (LiteralBlocked(url, out var reason)) return (true, reason);
        var uri = new Uri(url);
        if (IPAddress.TryParse(uri.IdnHost, out _)) return (false, "");
        try
        {
            var addresses = await Dns.GetHostAddressesAsync(uri.IdnHost, ct);
            if (addresses.Length == 0) return (true, "dns");
            if (UriBlocked(uri, addresses, out reason)) return (true, reason);
            return (false, "");
        }
        catch (Exception)
        {
            return (true, "dns");
        }
    }
}

public static class PluginManifestRules
{
    public static ManifestValidation Validate(PluginManifest manifest)
    {
        if (string.IsNullOrWhiteSpace(manifest.Id) || manifest.Id.Length > 80 || !Regex.IsMatch(manifest.Id, "^[a-z0-9_-]+$"))
            return new ManifestValidation(false, "id");
        if (string.IsNullOrWhiteSpace(manifest.Name) || manifest.Name.Length > 200)
            return new ManifestValidation(false, "name");
        if (manifest.Publisher.Length > 200) return new ManifestValidation(false, "publisher");
        if (manifest.Version.Length > 64) return new ManifestValidation(false, "version");
        if (manifest.Kind is not ("mcp" or "openapi" or "builtin")) return new ManifestValidation(false, "kind");
        if (manifest.AuthType is not ("none" or "api_key" or "oauth")) return new ManifestValidation(false, "auth");
        if (manifest.Transport is not ("remote" or "stdio" or "builtin")) return new ManifestValidation(false, "transport");
        if (manifest.Category.Length > 80) return new ManifestValidation(false, "category");
        if (manifest.Risk is not ("unknown" or "low" or "medium" or "high")) return new ManifestValidation(false, "risk");
        if (manifest.Trust is not ("community" or "official" or "verified")) return new ManifestValidation(false, "trust");
        if (manifest.SourceUrl.Length > 0 && SsrfGuard.LiteralBlocked(manifest.SourceUrl, out _))
            return new ManifestValidation(false, "source_url");
        if (manifest.RemoteUrl.Length > 0 && SsrfGuard.LiteralBlocked(manifest.RemoteUrl, out _))
            return new ManifestValidation(false, "remote_url");
        if (manifest.Tools.Count > PluginLimits.MaxOperations) return new ManifestValidation(false, "too_many_tools");
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var tool in manifest.Tools)
        {
            if (string.IsNullOrWhiteSpace(tool.Name) || tool.Name.Length > 80 || !Regex.IsMatch(tool.Name, "^[A-Za-z0-9_.:-]{1,80}$"))
                return new ManifestValidation(false, "tool_name");
            if (!names.Add(tool.Name)) return new ManifestValidation(false, "duplicate_tool");
        }
        return new ManifestValidation(true, "");
    }

    public static (string Label, string Status, string Detail) InitialCheck(PluginManifest manifest, ManifestValidation validation)
    {
        if (!validation.Ok) return ("failed", "failed", validation.Error);
        if (manifest.AuthType is "api_key" or "oauth")
            return ("needs-auth", "needs-auth", "auth required; tool listing skipped");
        if (manifest.Transport == "stdio")
            return ("listed", "skipped", "stdio runs in the bot computer when called");
        if (manifest.Transport == "builtin")
            return manifest.Tools.Count > 0
                ? ("auto-checked", "passed", "built-in manifest validated")
                : ("failed", "failed", "builtin has no tools");
        if (manifest.Kind == "openapi" && manifest.Tools.Count > 0)
            return ("auto-checked", "passed", "operations read from the spec");
        if (manifest.Transport == "remote")
            return ("listed", "pending", "remote listing not run");
        return ("failed", "failed", "unclassified");
    }
}

public sealed record RegistryEntry(PluginManifest Manifest, bool IsLatest, long UpdatedUnix, string Status);

public sealed record RegistryPage(IReadOnlyList<RegistryEntry> Entries, string NextCursor);

public static class McpRegistry
{
    public const string DefaultBase = "https://registry.modelcontextprotocol.io";

    public static RegistryPage Parse(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var next = "";
        if (root.TryGetProperty("metadata", out var meta) && meta.TryGetProperty("nextCursor", out var cursor) && cursor.ValueKind == JsonValueKind.String)
            next = cursor.GetString() ?? "";
        var entries = new List<RegistryEntry>();
        if (!root.TryGetProperty("servers", out var servers) || servers.ValueKind != JsonValueKind.Array)
            return new RegistryPage(entries, next);
        foreach (var item in servers.EnumerateArray())
            if (TryParseServer(item, out var entry))
                entries.Add(entry);
        return new RegistryPage(entries, next);
    }

    public static IReadOnlyList<PluginManifest> Dedupe(IEnumerable<RegistryEntry> entries)
    {
        var best = new Dictionary<string, (RegistryEntry Entry, int Order)>(StringComparer.Ordinal);
        var order = 0;
        foreach (var entry in entries)
        {
            if (entry.Status.Equals("deleted", StringComparison.OrdinalIgnoreCase)) continue;
            order++;
            var key = entry.Manifest.DedupeKey;
            if (!best.TryGetValue(key, out var current) || Better(entry, order, current.Entry, current.Order))
                best[key] = (entry, order);
        }
        return best.Values.Select(item => item.Entry.Manifest).ToList();
    }

    private static bool Better(RegistryEntry incoming, int incomingOrder, RegistryEntry current, int currentOrder)
    {
        if (incoming.IsLatest != current.IsLatest) return incoming.IsLatest;
        if (incoming.UpdatedUnix != current.UpdatedUnix) return incoming.UpdatedUnix > current.UpdatedUnix;
        return incomingOrder > currentOrder;
    }

    private static bool TryParseServer(JsonElement item, out RegistryEntry entry)
    {
        entry = null!;
        if (!item.TryGetProperty("server", out var server) || server.ValueKind != JsonValueKind.Object)
            return false;
        var name = Text(server, "name");
        if (name.Length == 0) return false;
        var title = Text(server, "title");
        var description = Text(server, "description");
        var version = Text(server, "version");
        var official = Official(item);
        var status = official.Status;
        var publisher = name.Split('/')[0];
        var repository = "";
        if (server.TryGetProperty("repository", out var repo) && repo.ValueKind == JsonValueKind.Object)
            repository = Text(repo, "url");
        string remote = "";
        var remoteType = "";
        var secretHeader = false;
        if (server.TryGetProperty("remotes", out var remotes) && remotes.ValueKind == JsonValueKind.Array)
        {
            foreach (var remoteEl in remotes.EnumerateArray())
            {
                var url = Text(remoteEl, "url");
                if (url.Length == 0) continue;
                if (remote.Length == 0)
                {
                    remote = url;
                    remoteType = Text(remoteEl, "type");
                }
                if (remoteEl.TryGetProperty("headers", out var headers) && headers.ValueKind == JsonValueKind.Array)
                {
                    foreach (var header in headers.EnumerateArray())
                    {
                        if (header.TryGetProperty("isSecret", out var secret) && secret.ValueKind == JsonValueKind.True)
                            secretHeader = true;
                        if (header.TryGetProperty("isRequired", out var required) && required.ValueKind == JsonValueKind.True)
                            secretHeader = true;
                    }
                }
            }
        }
        var packageRef = "";
        if (server.TryGetProperty("packages", out var packages) && packages.ValueKind == JsonValueKind.Array)
        {
            foreach (var package in packages.EnumerateArray())
            {
                var identifier = Text(package, "identifier");
                if (identifier.Length == 0) continue;
                var registry = Text(package, "registryType");
                packageRef = (registry.Length > 0 ? registry : "pkg") + ":" + identifier;
                break;
            }
        }
        var transport = remote.Length > 0 ? "remote" : "stdio";
        var dedupe = remote.Length > 0
            ? "remote:" + NormalizeUrl(remote)
            : packageRef.Length > 0
                ? "package:" + packageRef.ToLowerInvariant()
                : "name:" + name.ToLowerInvariant();
        var auth = secretHeader ? "api_key" : "none";
        var source = repository.Length > 0 ? repository : remote;
        if (source.Length > 0 && SsrfGuard.LiteralBlocked(source, out _)) source = "";
        var tools = new List<PluginToolDef>();
        var trust = status.Equals("active", StringComparison.OrdinalIgnoreCase) ? "official" : "community";
        var manifest = new PluginManifest(
            PluginIds.For("mcp", dedupe),
            title.Length > 0 ? title : name,
            publisher,
            source,
            version,
            "mcp",
            transport,
            auth,
            "MCP",
            "unknown",
            trust,
            "listed",
            "pending",
            "",
            dedupe,
            remote,
            packageRef,
            tools,
            "",
            "",
            Trim(description, 400));
        if (manifest.SourceUrl.Length > 0 && SsrfGuard.LiteralBlocked(manifest.SourceUrl, out _))
            manifest = manifest with { SourceUrl = "" };
        if (manifest.RemoteUrl.Length > 0 && SsrfGuard.LiteralBlocked(manifest.RemoteUrl, out _))
        {
            manifest = manifest with { RemoteUrl = "", Label = "failed", CheckStatus = "failed", CheckDetail = "remote_url" };
        }
        else
        {
            var validation = PluginManifestRules.Validate(manifest);
            var check = PluginManifestRules.InitialCheck(manifest, validation);
            manifest = manifest with { Label = check.Label, CheckStatus = check.Status, CheckDetail = check.Detail };
        }
        entry = new RegistryEntry(manifest, official.IsLatest, official.UpdatedUnix, status);
        return true;
    }

    private static (string Status, bool IsLatest, long UpdatedUnix) Official(JsonElement item)
    {
        if (!item.TryGetProperty("_meta", out var meta) || meta.ValueKind != JsonValueKind.Object)
            return ("", false, 0);
        if (!meta.TryGetProperty("io.modelcontextprotocol.registry/official", out var official) || official.ValueKind != JsonValueKind.Object)
            return ("", false, 0);
        var status = Text(official, "status");
        var latest = official.TryGetProperty("isLatest", out var flag) && flag.ValueKind == JsonValueKind.True;
        var updated = Text(official, "updatedAt");
        var unix = DateTimeOffset.TryParse(updated, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) ? at.ToUnixTimeSeconds() : 0;
        return (status, latest, unix);
    }

    public static string NormalizeUrl(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))
            return url.Trim().TrimEnd('/').ToLowerInvariant();
        var builder = new UriBuilder(uri) { Host = uri.IdnHost.ToLowerInvariant() };
        if ((uri.Scheme == "https" && uri.Port == 443) || (uri.Scheme == "http" && uri.Port == 80))
            builder.Port = -1;
        var text = builder.Uri.ToString().TrimEnd('/');
        return text;
    }

    private static string Text(JsonElement el, string name)
    {
        if (!el.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String) return "";
        return (value.GetString() ?? "").Trim();
    }

    private static string Trim(string text, int max) => text.Length <= max ? text : text[..max];
}

public sealed record OpenApiGeneration(bool Ok, string Error, PluginManifest? Manifest);

public static class OpenApiSpec
{
    public static OpenApiGeneration Generate(string body, string sourceUrl, string? nameOverride = null)
    {
        if (string.IsNullOrWhiteSpace(body)) return new OpenApiGeneration(false, "empty_spec", null);
        if (Encoding.UTF8.GetByteCount(body) > PluginLimits.MaxSpecBytes)
            return new OpenApiGeneration(false, "spec_too_large", null);
        var trimmed = body.TrimStart();
        var jsonBody = body;
        if (trimmed.Length == 0 || trimmed[0] is not ('{' or '['))
        {
            if (!YamlJson.TryConvert(body, out jsonBody))
                return new OpenApiGeneration(false, "spec_not_json", null);
        }
        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(jsonBody);
        }
        catch (JsonException)
        {
            return new OpenApiGeneration(false, "spec_not_json", null);
        }
        using (doc)
        {
            var root = doc.RootElement;
            var swagger = Text(root, "swagger");
            var openapi = Text(root, "openapi");
            var swagger2 = swagger.StartsWith("2.", StringComparison.Ordinal);
            var oas3 = openapi.StartsWith("3.", StringComparison.Ordinal);
            if (!swagger2 && !oas3) return new OpenApiGeneration(false, "unsupported_spec", null);
            var server = swagger2 ? SwaggerServer(root) : OasServer(root);
            if (server.Length == 0) return new OpenApiGeneration(false, "missing_server", null);
            if (SsrfGuard.LiteralBlocked(server, out var block))
                return new OpenApiGeneration(false, "blocked_server:" + block, null);
            if (sourceUrl.Length > 0 && SsrfGuard.LiteralBlocked(sourceUrl, out var sourceBlock))
                return new OpenApiGeneration(false, "blocked_source:" + sourceBlock, null);
            var auth = swagger2 ? SwaggerAuth(root) : OasAuth(root);
            var tools = new List<PluginToolDef>();
            if (!root.TryGetProperty("paths", out var paths) || paths.ValueKind != JsonValueKind.Object)
                return new OpenApiGeneration(false, "missing_paths", null);
            foreach (var path in paths.EnumerateObject())
            {
                if (path.Value.ValueKind != JsonValueKind.Object) continue;
                foreach (var op in path.Value.EnumerateObject())
                {
                    var method = op.Name.ToUpperInvariant();
                    if (method is not ("GET" or "POST" or "PUT" or "PATCH" or "DELETE" or "HEAD")) continue;
                    if (op.Value.ValueKind != JsonValueKind.Object) continue;
                    tools.Add(ToolFrom(op.Value, method, path.Name));
                    if (tools.Count > PluginLimits.MaxOperations)
                        return new OpenApiGeneration(false, "too_many_operations", null);
                }
            }
            if (tools.Count == 0) return new OpenApiGeneration(false, "no_operations", null);
            var title = nameOverride?.Trim() ?? "";
            if (title.Length == 0 && root.TryGetProperty("info", out var info))
                title = Text(info, "title");
            if (title.Length == 0) title = "OpenAPI";
            var version = "";
            if (root.TryGetProperty("info", out var infoEl)) version = Text(infoEl, "version");
            var dedupe = sourceUrl.Length > 0
                ? "openapi:" + McpRegistry.NormalizeUrl(sourceUrl)
                : "openapi:body:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(body))).ToLowerInvariant()[..32];
            var risk = PluginRisk.Highest(tools.Select(tool => tool.Risk));
            var manifest = new PluginManifest(
                PluginIds.For("openapi", dedupe),
                title,
                "openapi",
                sourceUrl,
                version,
                "openapi",
                "remote",
                auth,
                "OpenAPI",
                risk,
                "community",
                "listed",
                "pending",
                "",
                dedupe,
                server,
                "",
                tools,
                "",
                "",
                "");
            var validation = PluginManifestRules.Validate(manifest);
            if (!validation.Ok) return new OpenApiGeneration(false, validation.Error, null);
            var check = PluginManifestRules.InitialCheck(manifest, validation);
            manifest = manifest with { Label = check.Label, CheckStatus = check.Status, CheckDetail = check.Detail };
            return new OpenApiGeneration(true, "", manifest);
        }
    }

    private static PluginToolDef ToolFrom(JsonElement op, string method, string path)
    {
        var operationId = Text(op, "operationId");
        var name = operationId.Length > 0 ? operationId : method.ToLowerInvariant() + "_" + Regex.Replace(path, "[^A-Za-z0-9]+", "_").Trim('_');
        if (name.Length > 80) name = name[..80];
        var description = Text(op, "summary");
        if (description.Length == 0) description = Text(op, "description");
        var action = PluginRisk.Derive(name, description, method);
        return new PluginToolDef(name, Trim(description, 400), method, path, PluginRisk.Level(action), action, PluginRiskLabels.FromAction(action));
    }

    private static string OasServer(JsonElement root)
    {
        if (!root.TryGetProperty("servers", out var servers) || servers.ValueKind != JsonValueKind.Array) return "";
        foreach (var server in servers.EnumerateArray())
        {
            var url = Text(server, "url");
            if (url.Length > 0) return url;
        }
        return "";
    }

    private static string SwaggerServer(JsonElement root)
    {
        var host = Text(root, "host");
        if (host.Length == 0) return "";
        var scheme = "https";
        if (root.TryGetProperty("schemes", out var schemes) && schemes.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in schemes.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.String && item.GetString() is "https" or "http")
                {
                    scheme = item.GetString()!;
                    if (scheme == "https") break;
                }
            }
        }
        var basePath = Text(root, "basePath");
        return scheme + "://" + host + basePath;
    }

    private static string OasAuth(JsonElement root)
    {
        var kind = "none";
        if (root.TryGetProperty("components", out var components) && components.TryGetProperty("securitySchemes", out var schemes))
            kind = Strongest(schemes, kind);
        if (root.TryGetProperty("security", out var security) && security.ValueKind == JsonValueKind.Array && security.GetArrayLength() > 0 && kind == "none")
            kind = "api_key";
        return kind;
    }

    private static string SwaggerAuth(JsonElement root)
    {
        var kind = "none";
        if (root.TryGetProperty("securityDefinitions", out var schemes))
            kind = Strongest(schemes, kind);
        if (root.TryGetProperty("security", out var security) && security.ValueKind == JsonValueKind.Array && security.GetArrayLength() > 0 && kind == "none")
            kind = "api_key";
        return kind;
    }

    private static string Strongest(JsonElement schemes, string current)
    {
        if (schemes.ValueKind != JsonValueKind.Object) return current;
        foreach (var scheme in schemes.EnumerateObject())
        {
            if (scheme.Value.ValueKind != JsonValueKind.Object) continue;
            var type = Text(scheme.Value, "type").ToLowerInvariant();
            if (type is "oauth2" or "openidconnect") return "oauth";
            if (type is "apikey" or "http") current = Rank(current) >= Rank("api_key") ? current : "api_key";
        }
        return current;
    }

    private static int Rank(string auth) => auth switch
    {
        "oauth" => 2,
        "api_key" => 1,
        _ => 0
    };

    private static string Text(JsonElement el, string name)
    {
        if (!el.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String) return "";
        return (value.GetString() ?? "").Trim();
    }

    private static string Trim(string text, int max) => text.Length <= max ? text : text[..max];
}

public static class PluginManifestJson
{
    public static string Tools(IReadOnlyList<PluginToolDef> tools)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartArray();
            foreach (var tool in tools)
            {
                writer.WriteStartObject();
                writer.WriteString("name", JsonSafe(tool.Name));
                writer.WriteString("description", JsonSafe(tool.Description));
                writer.WriteString("method", tool.Method);
                writer.WriteString("path", tool.Path);
                writer.WriteString("risk", tool.Risk);
                writer.WriteString("actionClass", tool.ActionClass);
                writer.WriteString("riskLabel", tool.RiskLabel.Length > 0 ? tool.RiskLabel : PluginRiskLabels.FromAction(tool.ActionClass));
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static string JsonSafe(string text)
    {
        if (string.IsNullOrEmpty(text)) return "";
        var chars = text.ToCharArray();
        var count = 0;
        for (var i = 0; i < chars.Length; i++)
        {
            var c = chars[i];
            if (c == '\0') continue;
            if (char.IsHighSurrogate(c))
            {
                if (i + 1 < chars.Length && char.IsLowSurrogate(chars[i + 1]))
                {
                    chars[count++] = c;
                    chars[count++] = chars[++i];
                }
                continue;
            }
            if (char.IsLowSurrogate(c)) continue;
            chars[count++] = c;
        }
        return new string(chars, 0, count);
    }

    public static string Document(PluginManifest manifest) => JsonSerializer.Serialize(new
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
        tools = manifest.Tools,
        remoteUrl = manifest.RemoteUrl,
        packageRef = manifest.PackageRef,
        oauthAuthorize = manifest.OauthAuthorize,
        oauthToken = manifest.OauthToken,
        stdioCommand = manifest.StdioCommand ?? []
    });

    public static List<PluginToolDef> ReadTools(string? json)
    {
        var list = new List<PluginToolDef>();
        if (string.IsNullOrWhiteSpace(json)) return list;
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return list;
            foreach (var item in doc.RootElement.EnumerateArray())
            {
                var name = item.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
                if (name.Length == 0) continue;
                list.Add(new PluginToolDef(
                    name,
                    item.TryGetProperty("description", out var d) ? d.GetString() ?? "" : "",
                    item.TryGetProperty("method", out var m) ? m.GetString() ?? "" : "",
                    item.TryGetProperty("path", out var p) ? p.GetString() ?? "" : "",
                    item.TryGetProperty("risk", out var r) ? r.GetString() ?? "unknown" : "unknown",
                    item.TryGetProperty("actionClass", out var a) ? a.GetString() ?? "" : "",
                    item.TryGetProperty("riskLabel", out var label) ? label.GetString() ?? "" : ""));
            }
        }
        catch (JsonException)
        {
            return list;
        }
        return list;
    }
}
