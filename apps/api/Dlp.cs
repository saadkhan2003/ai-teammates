using System.Text;
using System.Text.Json;
using Teammates.Compute;

namespace Teammates.Api;

public static class Dlp
{
    public const string Blocked = "dlp_blocked";
    public const string Health = "dlp_health_or_finance";

    private static readonly string[] HealthPhrases =
    [
        "medical record", "diagnosis", "prescription", "blood type", "lab result", "patient history"
    ];

    private static readonly string[] FinancePhrases =
    [
        "account balance", "routing number", "bank statement", "tax return", "credit score"
    ];

    public static string Redact(string? text) => OutputRedactor.Redact(text);

    public static bool HasStrict(string? text)
    {
        if (string.IsNullOrEmpty(text)) return false;
        return OutputRedactor.Redact(text) != text;
    }

    public static bool IsHealthOrFinance(string? text)
    {
        if (string.IsNullOrEmpty(text)) return false;
        foreach (var phrase in HealthPhrases)
        {
            if (text.Contains(phrase, StringComparison.OrdinalIgnoreCase)) return true;
        }
        foreach (var phrase in FinancePhrases)
        {
            if (text.Contains(phrase, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    public static bool ExplicitShare(string? instruction, string? payload)
    {
        if (string.IsNullOrWhiteSpace(instruction)) return false;
        if (instruction.Contains("share my", StringComparison.OrdinalIgnoreCase)
            || instruction.Contains("include my", StringComparison.OrdinalIgnoreCase)
            || instruction.Contains("send my", StringComparison.OrdinalIgnoreCase)
            || instruction.Contains("explicitly include", StringComparison.OrdinalIgnoreCase))
            return true;
        if (string.IsNullOrEmpty(payload)) return false;
        foreach (var phrase in HealthPhrases.Concat(FinancePhrases))
        {
            if (payload.Contains(phrase, StringComparison.OrdinalIgnoreCase)
                && instruction.Contains(phrase, StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return false;
    }

    public static (bool Block, string Reason) AssessOutbound(string? text, string? instruction)
    {
        if (HasStrict(text)) return (true, Blocked);
        if (IsHealthOrFinance(text) && !ExplicitShare(instruction, text)) return (true, Health);
        return (false, "");
    }

    public static (bool Block, string Reason) AssessArgs(string tool, JsonElement args, string? instruction, string riskClass)
    {
        var raw = args.ValueKind == JsonValueKind.Undefined ? "" : ArgsForScan(args);
        if (HasStrict(raw)) return (true, Blocked);
        if (riskClass is ActionClasses.SendMessage or ActionClasses.ExternalPost)
            return AssessOutbound(raw, instruction);
        _ = tool;
        return (false, "");
    }

    /// <summary>
    /// Browser target ids are opaque CDP handles. A 32-hex id can checksum like an IBAN, which must not block type_secret.
    /// </summary>
    private static string ArgsForScan(JsonElement args)
    {
        if (args.ValueKind != JsonValueKind.Object) return args.GetRawText();
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            foreach (var prop in args.EnumerateObject())
            {
                if (prop.Name is "targetId" or "target_id") continue;
                prop.WriteTo(writer);
            }
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }
}
