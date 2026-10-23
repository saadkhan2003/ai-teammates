using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Teammates.Api;

/// <summary>Exact, narrow remembered approvals for shell command shapes.</summary>
public static class ApprovalRules
{
    public static string? CommandShapeHash(string tool, JsonElement args)
    {
        if (tool != "shell" || args.ValueKind != JsonValueKind.Object) return null;
        var argv = new List<string>();
        if (args.TryGetProperty("argv", out var supplied) && supplied.ValueKind == JsonValueKind.Array)
        {
            foreach (var part in supplied.EnumerateArray())
            {
                if (part.ValueKind != JsonValueKind.String) return null;
                argv.Add(part.GetString() ?? "");
            }
        }
        else if (args.TryGetProperty("command", out var command) && command.ValueKind == JsonValueKind.String)
        {
            argv.Add("/bin/sh");
            argv.Add("-lc");
            argv.Add(command.GetString() ?? "");
        }
        if (argv.Count is < 1 or > 128 || argv.Any(x => string.IsNullOrWhiteSpace(x) || x.Length > 4096 || x.Contains('\0')))
            return null;
        argv = argv.Select(x => x.Trim()).ToList();
        if (argv.Sum(x => x.Length) > 16384) return null;
        var canonical = JsonSerializer.Serialize(argv);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
    }

    public static bool Matches(string? storedHash, string tool, JsonElement args)
    {
        var current = CommandShapeHash(tool, args);
        if (storedHash is null || current is null || storedHash.Length != current.Length) return false;
        try { return CryptographicOperations.FixedTimeEquals(Convert.FromHexString(storedHash), Convert.FromHexString(current)); }
        catch (FormatException) { return false; }
    }
}
