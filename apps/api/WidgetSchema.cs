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
        if (value.TryGetProperty("title", out var title) && !Text(title, 240)) return "invalid_widget_title";
        var kind = typeNode.GetString();
        if (kind == "card") return OptionalText(value, "body", 4000) && OptionalArray(value, "items", 0, 40) && OptionalActions(value, "actions", 0, 12) ? null : "invalid_card";
        if (kind == "list") return Array(value, "items", 0, 100) ? null : "invalid_list";
        if (kind == "table") return Array(value, "columns", 1, 24) && Array(value, "rows", 0, 200) && value.GetProperty("columns").EnumerateArray().All(x => Text(x, 120)) && value.GetProperty("rows").EnumerateArray().All(r => r.ValueKind == JsonValueKind.Array && r.GetArrayLength() <= 24 && r.EnumerateArray().All(Scalar)) ? null : "invalid_table";
        if (kind == "form") return Array(value, "fields", 1, 24) && value.TryGetProperty("submit", out var submit) && Action(submit) ? null : "invalid_form";
        if (kind == "buttons") return Array(value, "actions", 1, 16) && value.GetProperty("actions").EnumerateArray().All(Action) ? null : "invalid_buttons";
        if (kind == "badges") return Array(value, "items", 0, 40) ? null : "invalid_badges";
        if (kind == "key-value") return Array(value, "items", 0, 60) ? null : "invalid_key_value";
        if (kind == "progress") return value.TryGetProperty("value", out var progress) && progress.ValueKind == JsonValueKind.Number && progress.TryGetDouble(out var p) && double.IsFinite(p) && p is >= 0 and <= 100 && OptionalText(value, "label", 160) ? null : "invalid_progress";
        if (kind == "image-grid")
        {
            if (!Array(value, "images", 0, 24)) return "invalid_images";
            foreach (var image in value.GetProperty("images").EnumerateArray())
                if (image.ValueKind != JsonValueKind.Object || !image.TryGetProperty("url", out var url) || url.ValueKind != JsonValueKind.String || !SafeImage(url.GetString() ?? "") || !image.TryGetProperty("alt", out var alt) || !Text(alt, 240)) return "unsafe_image_url";
            return null;
        }
        if (kind == "chart") return value.TryGetProperty("chart", out var chart) && chart.ValueKind == JsonValueKind.String && new[] { "bar", "line", "area", "pie" }.Contains(chart.GetString()) && Array(value, "data", 0, 200) ? null : "invalid_chart";
        if (kind == "flow") return Array(value, "nodes", 0, 80) && Array(value, "edges", 0, 160) ? null : "invalid_flow";
        if (kind == "code") return TextProperty(value, "language", 40) && TextProperty(value, "code", 24000) && OptionalText(value, "original", 24000) && OptionalText(value, "filename", 240) ? null : "invalid_code";
        return "unknown_widget_type";
    }
    private static bool Text(JsonElement value, int max) => value.ValueKind == JsonValueKind.String && (value.GetString()?.Length ?? max + 1) <= max;
    private static bool TextProperty(JsonElement obj, string name, int max) => obj.TryGetProperty(name, out var value) && Text(value, max);
    private static bool OptionalText(JsonElement obj, string name, int max) => !obj.TryGetProperty(name, out var value) || Text(value, max);
    private static bool Array(JsonElement obj, string name, int min, int max) => obj.TryGetProperty(name, out var arr) && arr.ValueKind == JsonValueKind.Array && arr.GetArrayLength() >= min && arr.GetArrayLength() <= max;
    private static bool OptionalArray(JsonElement obj, string name, int min, int max) => !obj.TryGetProperty(name, out _) || Array(obj, name, min, max);
    private static bool Scalar(JsonElement value) => value.ValueKind is JsonValueKind.String or JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False or JsonValueKind.Null;
    private static bool Action(JsonElement value) => value.ValueKind == JsonValueKind.Object && TextProperty(value, "id", 120) && Regex.IsMatch(value.GetProperty("id").GetString() ?? "", @"^[A-Za-z0-9_.:-]+$") && TextProperty(value, "label", 160) && TextProperty(value, "action", 120) && Regex.IsMatch(value.GetProperty("action").GetString() ?? "", @"^[A-Za-z0-9_.:-]+$") && (!value.TryGetProperty("payload", out var payload) || payload.ValueKind == JsonValueKind.Object) && (!value.TryGetProperty("requires_approval", out var approval) || approval.ValueKind is JsonValueKind.True or JsonValueKind.False);
    private static bool OptionalActions(JsonElement obj, string name, int min, int max) => !obj.TryGetProperty(name, out _) || Array(obj, name, min, max) && obj.GetProperty(name).EnumerateArray().All(Action);
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
