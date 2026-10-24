using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Teammates.Api;

public static class VideoTools
{
    public static bool IsTool(string tool) => tool is "watch_video" or "ask_video";

    public static string Source(JsonElement args)
    {
        foreach (var field in new[] { "video_id", "source" })
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

    // Cache identity includes effective API models and worker preprocessing settings.
    public static string SettingsVersion(string summaryModel, string sttModel, string sttProvider, string processingSettings)
    {
        var settings = JsonSerializer.Serialize(new { version = "video-v1", summaryModel, sttModel, sttProvider, processingSettings });
        return "video-v1:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(settings))).ToLowerInvariant();
    }
}
