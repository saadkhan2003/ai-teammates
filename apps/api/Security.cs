using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Teammates.Api;

public static class Passwords
{
    public static string Hash(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var hash = Rfc2898DeriveBytes.Pbkdf2(password, salt, 100_000, HashAlgorithmName.SHA256, 32);
        return $"pbkdf2-sha256$100000${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
    }

    public static bool Verify(string password, string stored)
    {
        var parts = stored.Split('$');
        if (parts.Length != 4) return false;
        var iterations = int.Parse(parts[1]);
        var salt = Convert.FromBase64String(parts[2]);
        var expected = Convert.FromBase64String(parts[3]);
        var actual = Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, HashAlgorithmName.SHA256, expected.Length);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }
}

public static class KeyEncryption
{
    public const int KeyVersion = 1;

    public static byte[] LoadMasterKey(string path)
    {
        if (!File.Exists(path)) throw new InvalidOperationException("secrets master key file is missing");
        var key = File.ReadAllBytes(path);
        if (key.Length != 32) throw new InvalidOperationException("secrets master key must be 32 bytes");
        return key;
    }

    public static string Aad(Guid secretId, Guid ownerId, string type, int keyVersion) =>
        $"{secretId:D}|{ownerId:D}|{type}|{keyVersion}";

    public static (byte[] Ciphertext, byte[] Nonce) Encrypt(byte[] key, Guid secretId, Guid ownerId, string type, int keyVersion, byte[] plaintext)
    {
        var nonce = RandomNumberGenerator.GetBytes(12);
        var cipher = new byte[plaintext.Length];
        var tag = new byte[16];
        using var aes = new AesGcm(key, 16);
        aes.Encrypt(nonce, plaintext, cipher, tag, Encoding.UTF8.GetBytes(Aad(secretId, ownerId, type, keyVersion)));
        var combined = new byte[cipher.Length + tag.Length];
        Buffer.BlockCopy(cipher, 0, combined, 0, cipher.Length);
        Buffer.BlockCopy(tag, 0, combined, cipher.Length, tag.Length);
        return (combined, nonce);
    }

    public static byte[] Decrypt(byte[] key, Guid secretId, Guid ownerId, string type, int keyVersion, byte[] ciphertext, byte[] nonce)
    {
        if (ciphertext.Length < 16) throw new CryptographicException("ciphertext too short");
        var body = ciphertext.AsSpan(0, ciphertext.Length - 16);
        var tag = ciphertext.AsSpan(ciphertext.Length - 16);
        var plain = new byte[body.Length];
        using var aes = new AesGcm(key, 16);
        aes.Decrypt(nonce, body, tag, plain, Encoding.UTF8.GetBytes(Aad(secretId, ownerId, type, keyVersion)));
        return plain;
    }
}

public static partial class SecretRef
{
    [GeneratedRegex(@"^secret://([a-z0-9._-]+)/([a-z0-9._-]+)$", RegexOptions.CultureInvariant)]
    private static partial Regex Grammar();

    public static bool TryParse(string? text, out string provider, out string name)
    {
        provider = "";
        name = "";
        if (string.IsNullOrWhiteSpace(text)) return false;
        var match = Grammar().Match(text.Trim());
        if (!match.Success) return false;
        if (match.Groups[1].Value.Contains("..", StringComparison.Ordinal) || match.Groups[2].Value.Contains("..", StringComparison.Ordinal))
            return false;
        provider = match.Groups[1].Value;
        name = match.Groups[2].Value;
        return true;
    }
}

public static class DomainRules
{
    public static bool Allows(IEnumerable<string> rules, string destination)
    {
        if (!Uri.TryCreate(destination, UriKind.Absolute, out var dest)) return false;
        foreach (var rule in rules)
        {
            if (RuleMatches(rule.Trim(), dest)) return true;
        }
        return false;
    }

    public static bool RuleMatches(string rule, Uri dest)
    {
        if (string.IsNullOrWhiteSpace(rule)) return false;
        if (rule.StartsWith("*."))
        {
            var host = rule[2..];
            var destHost = dest.Host;
            if (!dest.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase)) return false;
            if (dest.Port is not 443 and not -1 && dest.IsDefaultPort == false && dest.Port != 443) return false;
            if (destHost.Equals(host, StringComparison.OrdinalIgnoreCase)) return false;
            return destHost.EndsWith("." + host, StringComparison.OrdinalIgnoreCase);
        }
        if (rule.Contains("://", StringComparison.Ordinal))
        {
            if (!Uri.TryCreate(rule, UriKind.Absolute, out var allowed)) return false;
            return dest.Scheme.Equals(allowed.Scheme, StringComparison.OrdinalIgnoreCase)
                && dest.Host.Equals(allowed.Host, StringComparison.OrdinalIgnoreCase)
                && dest.Port == allowed.Port;
        }
        return dest.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase)
            && dest.IsDefaultPort
            && dest.Host.Equals(rule, StringComparison.OrdinalIgnoreCase);
    }
}

public static partial class PolicyEngine
{
    public const string Allow = "ALLOW";
    public const string Ask = "ASK";
    public const string Deny = "DENY";

    [GeneratedRegex(@"\brm\b", RegexOptions.IgnoreCase)]
    private static partial Regex Rm();

    public static string Decide(string tool, JsonElement args, ISet<string> seenDomains)
    {
        var command = Arg(args, "command");
        if (tool is "shell" or "setup_env")
        {
            if (IsCatastrophic(command)) return Deny;
            if (command.Contains("secret://", StringComparison.Ordinal) || LooksLikeCredential(command)) return Deny;
            if (Rm().IsMatch(command)) return Ask;
            if (Regex.IsMatch(command, "purchase|send mail|publish|chmod\\s+777", RegexOptions.IgnoreCase)) return Ask;
        }
        if (tool == "delete_file") return Ask;
        if (tool == "browser_open")
        {
            var url = Arg(args, "url");
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return Deny;
            if (uri.Scheme is not ("http" or "https")) return Deny;
            if (!seenDomains.Contains(uri.GetLeftPart(UriPartial.Authority))) return Ask;
        }
        if (tool is "type_secret" or "browser.type_secret")
        {
            var reference = Arg(args, "secret_ref");
            if (string.IsNullOrWhiteSpace(reference)) reference = Arg(args, "secretRef");
            return SecretRef.TryParse(reference, out _, out _) ? Allow : Deny;
        }
        return Allow;
    }

    public static bool IsCatastrophic(string command) =>
        command.Contains("rm -rf /", StringComparison.Ordinal)
        || command.Contains("mkfs", StringComparison.OrdinalIgnoreCase)
        || command.Contains(":(){", StringComparison.Ordinal);

    public static bool LooksLikeCredential(string command) =>
        Regex.IsMatch(command, @"sk-or-|sk-[A-Za-z0-9]|ghp_|github_pat_|glpat-|xox[baprs]-|BEGIN [A-Z ]*PRIVATE KEY");

    private static string Arg(JsonElement args, string name) =>
        args.ValueKind == JsonValueKind.Object && args.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";
}

public static class Cron
{
    public static DateTimeOffset Next(string expression, DateTimeOffset after, TimeZoneInfo zone)
    {
        var fields = expression.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (fields.Length != 5) throw new FormatException("cron needs 5 fields");
        var local = TimeZoneInfo.ConvertTime(after, zone);
        var cursor = new DateTime(local.Year, local.Month, local.Day, local.Hour, local.Minute, 0, DateTimeKind.Unspecified).AddMinutes(1);
        for (var i = 0; i < 366 * 24 * 60; i++)
        {
            if (Matches(fields, cursor))
                return new DateTimeOffset(cursor, zone.GetUtcOffset(cursor));
            cursor = cursor.AddMinutes(1);
        }
        throw new InvalidOperationException("cron did not match within a year");
    }

    private static bool Matches(string[] fields, DateTime when)
    {
        var minute = MatchField(fields[0], when.Minute, 0, 59);
        var hour = MatchField(fields[1], when.Hour, 0, 23);
        var domRestricted = fields[2] != "*";
        var dowRestricted = fields[4] != "*";
        var dom = MatchField(fields[2], when.Day, 1, 31);
        var month = MatchField(fields[3], when.Month, 1, 12);
        var dow = MatchField(fields[4], (int)when.DayOfWeek, 0, 6);
        var day = domRestricted && dowRestricted ? dom || dow : dom && dow;
        return minute && hour && month && day;
    }

    private static bool MatchField(string field, int value, int min, int max)
    {
        foreach (var part in field.Split(','))
        {
            var step = 1;
            var range = part;
            var slash = part.IndexOf('/');
            if (slash >= 0)
            {
                range = part[..slash];
                step = int.Parse(part[(slash + 1)..]);
            }
            int start = min, end = max;
            if (range != "*")
            {
                var dash = range.IndexOf('-');
                if (dash >= 0)
                {
                    start = int.Parse(range[..dash]);
                    end = int.Parse(range[(dash + 1)..]);
                }
                else start = end = int.Parse(range);
            }
            if (value >= start && value <= end && (value - start) % step == 0) return true;
        }
        return false;
    }
}

public static class EmojiRules
{
    public static bool IsSingleEmoji(string? value)
    {
        if (string.IsNullOrEmpty(value)) return false;
        var info = new System.Globalization.StringInfo(value);
        if (info.LengthInTextElements != 1) return false;
        var emoji = false;
        foreach (var rune in value.EnumerateRunes())
        {
            if (IsJoiner(rune)) continue;
            if (!IsEmojiBase(rune)) return false;
            emoji = true;
        }
        return emoji;
    }

    private static bool IsJoiner(Rune rune) => rune.Value is 0x200D or 0xFE0F or 0xFE0E or 0x20E3;

    private static bool IsEmojiBase(Rune rune)
    {
        var value = rune.Value;
        if (value is >= 0x1F1E6 and <= 0x1F1FF) return true;
        if (value is >= 0x1F3FB and <= 0x1F3FF) return true;
        if (value is >= 0x1F300 and <= 0x1FAFF) return true;
        if (value is >= 0x2600 and <= 0x27BF) return true;
        if (value is >= 0x2194 and <= 0x2199) return true;
        if (value is >= 0x2B05 and <= 0x2B07) return true;
        if (value is 0x00A9 or 0x00AE or 0x203C or 0x2049 or 0x2122 or 0x2139 or 0x231A or 0x231B or 0x2328 or 0x23CF or 0x24C2 or 0x25AA or 0x25AB or 0x25B6 or 0x25C0 or 0x25FB or 0x25FC or 0x25FD or 0x25FE or 0x2934 or 0x2935 or 0x2B1B or 0x2B1C or 0x2B50 or 0x2B55 or 0x3030 or 0x303D or 0x3297 or 0x3299) return true;
        return false;
    }
}

public static class Embedder
{
    public static string VectorLiteral(string text)
    {
        var buckets = new double[64];
        foreach (var token in text.ToLowerInvariant().Split([' ', '\n', '\t', ',', '.'], StringSplitOptions.RemoveEmptyEntries))
        {
            var hash = SHA256.HashData(Encoding.UTF8.GetBytes(token));
            buckets[hash[0] % 64] += 1;
            buckets[hash[1] % 64] += 0.5;
        }
        var norm = Math.Sqrt(buckets.Sum(value => value * value));
        if (norm == 0) norm = 1;
        return "[" + string.Join(',', buckets.Select(value => (value / norm).ToString("0.######", System.Globalization.CultureInfo.InvariantCulture))) + "]";
    }
}
