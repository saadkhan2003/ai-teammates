using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Teammates.Compute;

namespace Teammates.Api;

public static class VideoTools
{
    public const string UsageRole = "video";
    public const string UsageProvider = "video";
    public const string UsageLabel = "Video watching";

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
