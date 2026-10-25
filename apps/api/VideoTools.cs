using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Teammates.Compute;

namespace Teammates.Api;

public static class VideoTools
{
    public static (string Json, bool Ok) FinalVideoStep(JsonElement result)
    {
        var safe = RedactJsonStrings(result);
        using var parsed = JsonDocument.Parse(safe);
        var ok = !parsed.RootElement.TryGetProperty("ok", out var flag) || flag.ValueKind != JsonValueKind.False;
        return (InjectionFilter.ScrubJson(safe), ok);
    }
    public const string UsageRole = "video";
    public const string UsageProvider = "video";
    public const string UsageLabel = "Video watching";
    private const decimal VideoFrameCreditUsd = 0.000001m;
    private const decimal TranscriptionMinuteCreditUsd = 0.0003m;
    private const decimal VisionThousandTokenCreditUsd = 0.00015m;

    public static decimal ComputeCreditCost(int frameCount, double transcriptionSeconds, int visionTokens)
    {
        var seconds = Math.Max(0, transcriptionSeconds);
        return decimal.Round(Math.Max(0, frameCount) * VideoFrameCreditUsd
            + (decimal)seconds / 60m * TranscriptionMinuteCreditUsd
            + Math.Max(0, visionTokens) / 1000m * VisionThousandTokenCreditUsd, 8, MidpointRounding.AwayFromZero);
    }

    public sealed record AdminConfig(string VisionModel, string TranscriptionModel, string TranscriptionProvider);

    public static AdminConfig Defaults(string? visionModel, string? transcriptionModel, string? transcriptionProvider, string? plannerModel) =>
        new(NonBlank(visionModel, plannerModel ?? "mock/planner"),
            NonBlank(transcriptionModel, "openai/whisper-large-v3-turbo"),
            NonBlank(transcriptionProvider, "DeepInfra"));

    public static bool ValidAdminConfig(AdminConfig config) =>
        SafeConfigToken(config.VisionModel, 200) && SafeConfigToken(config.TranscriptionModel, 200)
        && SafeConfigToken(config.TranscriptionProvider, 80);

    public static bool CanManageAdminConfig(string? role) => Access.IsStaff(role);
    public static int AdminConfigStatusCode(string? role) => CanManageAdminConfig(role) ? 200 : 403;

    private static string NonBlank(string? value, string fallback) => string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
    private static bool SafeConfigToken(string value, int max) => value.Length > 0 && value.Length <= max
        && value.All(c => char.IsAsciiLetterOrDigit(c) || c is '/' or '-' or '_' or '.' or ':');

    public static bool IsTool(string tool) => tool is "watch_video" or "ask_video";

    public static string Source(JsonElement args)
    {
        foreach (var field in new[] { "attachment_id", "video_id", "path", "source" })
            if (args.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String
                && !string.IsNullOrWhiteSpace(value.GetString())) return value.GetString()!;
        return "";
    }

    public static bool SafeSource(string source) => Guid.TryParse(source, out _)
        || (!string.IsNullOrWhiteSpace(source) && source.Length <= 4096 && !source.Contains('\0')
            && !source.Contains("://", StringComparison.Ordinal) && !source.Split('/').Contains("..")
            && !LibraryKinds.IsDeniedName(source));

    public static Dictionary<string, JsonElement> Card(JsonElement analysis) =>
        new[] { "videoId", "duration", "summary", "timeline", "audioSkipReason", "sttProvider", "sttSeconds", "frameCount" }
            .Where(key => analysis.TryGetProperty(key, out _))
            .ToDictionary(key => key, key => analysis.GetProperty(key).Clone());

    /// <summary>
    /// Redacts user supplied strings without treating serialized JSON as plain text.
    /// Redacting raw JSON can replace characters inside quoted values and corrupt the document.
    /// </summary>
    public static string RedactJsonStrings(JsonElement value)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream)) WriteRedacted(value, writer);
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static void WriteRedacted(JsonElement value, Utf8JsonWriter writer)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var property in value.EnumerateObject())
                {
                    writer.WritePropertyName(property.Name);
                    WriteRedacted(property.Value, writer);
                }
                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in value.EnumerateArray()) WriteRedacted(item, writer);
                writer.WriteEndArray();
                break;
            case JsonValueKind.String:
                writer.WriteStringValue(OutputRedactor.Redact(value.GetString()));
                break;
            case JsonValueKind.Number:
                value.WriteTo(writer);
                break;
            case JsonValueKind.True:
                writer.WriteBooleanValue(true);
                break;
            case JsonValueKind.False:
                writer.WriteBooleanValue(false);
                break;
            default:
                writer.WriteNullValue();
                break;
        }
    }

    // Cache identity includes effective API models and worker preprocessing settings.
    public static string SettingsVersion(string summaryModel, string sttModel, string sttProvider, string processingSettings)
    {
        var settings = JsonSerializer.Serialize(new { version = "video-v1", summaryModel, sttModel, sttProvider, processingSettings });
        return "video-v1:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(settings))).ToLowerInvariant();
    }
}
