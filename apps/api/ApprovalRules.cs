using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Teammates.Api;

public static class ApprovalRules
{
    private static readonly HashSet<string> Never = new(StringComparer.Ordinal)
        { ActionClasses.Payment, ActionClasses.Sign, ActionClasses.Delete, ActionClasses.CredentialUse, ActionClasses.BotManage };
    private static readonly HashSet<string> ShellTools = new(StringComparer.Ordinal)
        { "shell" };
    private static readonly HashSet<string> CodingTools = new(StringComparer.Ordinal)
        { "git_status", "git_diff", "git_commit", "run_tests" };

    public static bool AllowedClass(string actionClass, string tool) =>
        !Never.Contains(actionClass) && (actionClass is ActionClasses.Read or ActionClasses.Write or ActionClasses.SendMessage)
        && tool is not ("type_secret" or "browser.type_secret" or "request_secret" or "setup_env")
        && !tool.Contains("vault", StringComparison.OrdinalIgnoreCase)
        && tool != "external_post";

    public static (string Class, string Tool, string Matcher, string Display)? Build(string actionClass, string tool, JsonElement args)
    {
        if (!AllowedClass(actionClass, tool) || args.ValueKind != JsonValueKind.Object || TouchesSecretsOrVault(args)) return null;
        if (tool == "browser_open" && Uri.TryCreate(Value(args, "url"), UriKind.Absolute, out var uri)
            && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps) && !CredentialSites.IsLookAlike(uri.Host))
        {
            var host = uri.IdnHost.ToLowerInvariant();
            return (actionClass, tool, JsonSerializer.Serialize(new { kind = "host", host }), $"Always allow {host} in this bot");
        }
        if (ShellTools.Contains(tool) || CodingTools.Contains(tool))
        {
            var command = ShellTools.Contains(tool) ? NormalizeCommand(Value(args, "command")) : tool + ":" + CanonicalArgs(args);
            if (command.Length == 0 || command.Contains("secret://", StringComparison.OrdinalIgnoreCase) || command.Contains("vault", StringComparison.OrdinalIgnoreCase)) return null;
            var hash = CommandHash(command);
            var safeLabel = Dlp.Redact(ShellTools.Contains(tool) ? command : tool.Replace('_', ' '));
            if (safeLabel.Length > 80) safeLabel = safeLabel[..80];
            return (actionClass, tool, JsonSerializer.Serialize(new { kind = "command", sha256 = hash }), $"Always allow {safeLabel} in this bot");
        }
        if (actionClass == ActionClasses.SendMessage && tool == "send_message")
        {
            var recipient = NormalizeRecipient(Value(args, "to"));
            if (recipient.Length == 0 || Dlp.HasStrict(recipient)) return null;
            return (actionClass, tool, JsonSerializer.Serialize(new { kind = "recipient", recipient }), $"Always allow messages to {Dlp.Redact(recipient)} in this bot");
        }
        if (actionClass == ActionClasses.Write)
        {
            var target = Value(args, "path");
            if (target.Length == 0) target = Value(args, "url");
            var prefix = NormalizeTarget(target);
            if (!SafePrefix(prefix)) return null;
            return (actionClass, tool, JsonSerializer.Serialize(new { kind = "prefix", prefix }), $"Always allow {tool} within {Dlp.Redact(prefix)} in this bot");
        }
        return null;
    }

    public static bool Matches(string actionClass, string tool, string matcherJson, JsonElement args)
    {
        if (!AllowedClass(actionClass, tool) || args.ValueKind != JsonValueKind.Object || TouchesSecretsOrVault(args)) return false;
        try
        {
            using var doc = JsonDocument.Parse(matcherJson);
            var root = doc.RootElement;
            var kind = root.GetProperty("kind").GetString();
            return kind switch
            {
                "host" => Uri.TryCreate(Value(args, "url"), UriKind.Absolute, out var uri) &&
                    string.Equals(uri.IdnHost, root.GetProperty("host").GetString(), StringComparison.OrdinalIgnoreCase),
                "command" => (ShellTools.Contains(tool) || CodingTools.Contains(tool)) && CommandHash(ShellTools.Contains(tool) ? NormalizeCommand(Value(args, "command")) : tool + ":" + CanonicalArgs(args)) == root.GetProperty("sha256").GetString(),
                "recipient" => tool == "send_message" && NormalizeRecipient(Value(args, "to")) == root.GetProperty("recipient").GetString(),
                "prefix" => IsWithin(NormalizeTarget(Target(args)), root.GetProperty("prefix").GetString() ?? ""),
                _ => false
            };
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or KeyNotFoundException) { return false; }
    }

    public static bool IsNarrowerOrEqual(string actionClass, string tool, string oldMatcher, string newMatcher)
    {
        try
        {
            using var oldDoc = JsonDocument.Parse(oldMatcher);
            using var newDoc = JsonDocument.Parse(newMatcher);
            var old = oldDoc.RootElement;
            var next = newDoc.RootElement;
            if (old.GetProperty("kind").GetString() != next.GetProperty("kind").GetString()) return false;
            if (next.EnumerateObject().Count() != 2 || !next.TryGetProperty("kind", out _)) return false;
            return old.GetProperty("kind").GetString() switch
            {
                "host" => IsHostNarrower(next.GetProperty("host").GetString() ?? "", old.GetProperty("host").GetString() ?? ""),
                "command" => old.GetProperty("sha256").GetString() == next.GetProperty("sha256").GetString(),
                "recipient" => old.GetProperty("recipient").GetString() == next.GetProperty("recipient").GetString(),
                "prefix" => SafePrefix(next.GetProperty("prefix").GetString() ?? "") && IsWithin(next.GetProperty("prefix").GetString() ?? "", old.GetProperty("prefix").GetString() ?? ""),
                _ => false
            } && AllowedClass(actionClass, tool);
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or KeyNotFoundException) { return false; }
    }

    public static string NormalizeCommand(string value) => string.Join(' ', value.Trim().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
    public static string NormalizeRecipient(string value) => value.Trim().ToLowerInvariant();
    public static string NormalizeTarget(string value) => value.Trim().Replace('\\', '/').TrimEnd('/');
    public static bool IsWithin(string candidate, string prefix) => candidate == prefix || candidate.StartsWith(prefix.EndsWith('/') ? prefix : prefix + "/", StringComparison.Ordinal);
    private static bool IsHostNarrower(string candidate, string original) =>
        Uri.TryCreate("https://" + candidate, UriKind.Absolute, out var uri) && uri.Host.Equals(candidate, StringComparison.OrdinalIgnoreCase) &&
        !CredentialSites.IsLookAlike(candidate) && (candidate.Equals(original, StringComparison.OrdinalIgnoreCase) || candidate.EndsWith("." + original, StringComparison.OrdinalIgnoreCase));
    private static bool SafePrefix(string value) => value.Length > 0 && !value.Contains('*') && !value.Contains("..", StringComparison.Ordinal) && !value.Contains("secret", StringComparison.OrdinalIgnoreCase) && !value.Contains("vault", StringComparison.OrdinalIgnoreCase) && !Dlp.HasStrict(value);
    private static string CommandHash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    private static string CanonicalArgs(JsonElement args) => JsonSerializer.Serialize(args.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal).ToDictionary(p => p.Name, p => p.Value.Clone()));
    private static bool TouchesSecretsOrVault(JsonElement args) => System.Text.RegularExpressions.Regex.IsMatch(args.GetRawText(), @"\b(?:secret|secrets|vault|credential|credentials)\b|secret://", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    private static string Target(JsonElement args) => Value(args, "path") is { Length: > 0 } path ? path : Value(args, "url");
    private static string Value(JsonElement args, string key) => args.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
}
