using System.Text.Json;
using System.Text;
using System.Text.RegularExpressions;

namespace Teammates.Api;

/// <summary>Server-side bounds and URL policy mirrored by the web zod widget schema.</summary>
public static class WidgetSchema
{
    public const int Version = 1;
    public const int MaxBytes = 48_000;
    public const int MaxDepth = 8;
    private static readonly HashSet<string> Types = ["card", "list", "table", "form", "buttons", "badges", "key-value", "progress", "image-grid", "chart", "flow", "code"];
    public static string? Validate(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object || EncodingLength(value) > MaxBytes) return "widget_too_large";
        if (Depth(value, 0) > MaxDepth) return "widget_too_deep";
        if (!value.TryGetProperty("version", out var version) || version.ValueKind != JsonValueKind.Number || !version.TryGetInt32(out var versionNumber) || versionNumber != Version) return "unsupported_widget_version";
        if (!value.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.String || !Regex.IsMatch(id.GetString() ?? "", @"^[A-Za-z0-9_.:-]{1,120}$")) return "invalid_widget_id";
        if (!value.TryGetProperty("type", out var typeNode) || typeNode.ValueKind != JsonValueKind.String || !Types.Contains(typeNode.GetString() ?? "")) return "unknown_widget_type";
        if (typeNode.GetString() == "image-grid" && value.TryGetProperty("images", out var images))
            foreach (var image in images.EnumerateArray())
                if (image.TryGetProperty("url", out var url) && (url.ValueKind != JsonValueKind.String || !SafeImage(url.GetString() ?? ""))) return "unsafe_image_url";
        return null;
    }
    public static bool SafeImage(string value) => Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
        ((uri.Scheme == Uri.UriSchemeHttps && string.IsNullOrEmpty(uri.UserInfo)) || Regex.IsMatch(value, @"^data:image/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$", RegexOptions.IgnoreCase));
    private static int EncodingLength(JsonElement value) => System.Text.Encoding.UTF8.GetByteCount(value.GetRawText());
    private static int Depth(JsonElement value, int depth) => value.ValueKind switch
    {
        JsonValueKind.Object => value.EnumerateObject().Select(p => Depth(p.Value, depth + 1)).DefaultIfEmpty(depth).Max(),
        JsonValueKind.Array => value.EnumerateArray().Select(v => Depth(v, depth + 1)).DefaultIfEmpty(depth).Max(),
        _ => depth
    };
}
