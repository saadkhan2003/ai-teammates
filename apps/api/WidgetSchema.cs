using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Teammates.Api;

/// <summary>Server-side v1 validator kept in step with the web zod widget schema.</summary>
public static class WidgetSchema
{
    public const int Version = 1;
    public const int MaxBytes = 48_000;
    public const int MaxDepth = 8;
    private static readonly HashSet<string> Types = ["card", "list", "table", "form", "buttons", "badges", "key-value", "progress", "image-grid", "chart", "flow", "code"];
    private static readonly Regex IdPattern = new("^[A-Za-z0-9_.:-]{1,120}$", RegexOptions.CultureInvariant);

    public static string? Validate(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object || Encoding.UTF8.GetByteCount(value.GetRawText()) > MaxBytes) return "widget_too_large";
        if (Depth(value, 0) > MaxDepth) return "widget_too_deep";
        if (!value.TryGetProperty("version", out var version) || version.ValueKind != JsonValueKind.Number || !version.TryGetInt32(out var versionNumber) || versionNumber != Version) return "unsupported_widget_version";
        if (!StringProperty(value, "id", 120) || !IdPattern.IsMatch(value.GetProperty("id").GetString() ?? "")) return "invalid_widget_id";
        if (!StringProperty(value, "type", 32) || !Types.Contains(value.GetProperty("type").GetString() ?? "")) return "unknown_widget_type";
        if (value.TryGetProperty("title", out var title) && !Text(title, 240)) return "invalid_widget_title";
        var type = value.GetProperty("type").GetString();
        var valid = type switch
        {
            "card" => Shape(value, ["body"], ["items", "actions"]) && OptionalText(value, "body", 4000) && OptionalStringArray(value, "items", 40, 4000) && OptionalActions(value, "actions", 12),
            "list" => Shape(value, ["items"]) && Array(value, "items", 0, 100) && value.GetProperty("items").EnumerateArray().All(ListItem),
            "table" => Shape(value, ["columns", "rows"]) && StringArray(value, "columns", 1, 24, 120) && Array(value, "rows", 0, 200) && value.GetProperty("rows").EnumerateArray().All(Row),
            "form" => Shape(value, ["fields", "submit"]) && Array(value, "fields", 1, 24) && value.GetProperty("fields").EnumerateArray().All(Field) && Action(value.GetProperty("submit")),
            "buttons" => Shape(value, ["actions"]) && Array(value, "actions", 1, 16) && value.GetProperty("actions").EnumerateArray().All(Action),
            "badges" => Shape(value, ["items"]) && Array(value, "items", 0, 40) && value.GetProperty("items").EnumerateArray().All(Badge),
            "key-value" => Shape(value, ["items"]) && Array(value, "items", 0, 60) && value.GetProperty("items").EnumerateArray().All(KeyValue),
            "progress" => Shape(value, ["value"], ["label"]) && Number(value, "value", 0, 100) && OptionalText(value, "label", 160),
            "image-grid" => Shape(value, ["images"]) && Array(value, "images", 0, 24) && Images(value.GetProperty("images")),
            "chart" => Shape(value, ["chart", "data"], ["xKey", "yKey"]) && StringEnum(value, "chart", ["bar", "line", "area", "pie"]) && OptionalText(value, "xKey", 80) && OptionalText(value, "yKey", 80) && Array(value, "data", 0, 200) && value.GetProperty("data").EnumerateArray().All(Point),
            "flow" => Shape(value, ["nodes", "edges"]) && Array(value, "nodes", 0, 80) && value.GetProperty("nodes").EnumerateArray().All(Node) && Array(value, "edges", 0, 160) && value.GetProperty("edges").EnumerateArray().All(Edge),
            "code" => Shape(value, ["language", "code"], ["original", "filename"]) && TextProperty(value, "language", 40) && TextProperty(value, "code", 24000) && OptionalText(value, "original", 24000) && OptionalText(value, "filename", 240),
            _ => false
        };
        return valid ? null : type == "image-grid" ? "unsafe_image_url" : "invalid_" + type?.Replace('-', '_');
    }

    private static bool Shape(JsonElement obj, string[] required, string[]? optional = null)
    {
        var allowed = new HashSet<string>(["version", "id", "type", "title", .. required, .. (optional ?? [])], StringComparer.Ordinal);
        var present = obj.EnumerateObject().Select(p => p.Name).ToHashSet(StringComparer.Ordinal);
        return present.IsSubsetOf(allowed) && required.All(present.Contains);
    }
    private static bool Text(JsonElement value, int max) => value.ValueKind == JsonValueKind.String && (value.GetString()?.Length ?? max + 1) <= max;
    private static bool TextProperty(JsonElement obj, string name, int max) => obj.TryGetProperty(name, out var value) && Text(value, max);
    private static bool StringProperty(JsonElement obj, string name, int max) => TextProperty(obj, name, max);
    private static bool OptionalText(JsonElement obj, string name, int max) => !obj.TryGetProperty(name, out var value) || Text(value, max);
    private static bool Array(JsonElement obj, string name, int min, int max) => obj.TryGetProperty(name, out var arr) && arr.ValueKind == JsonValueKind.Array && arr.GetArrayLength() >= min && arr.GetArrayLength() <= max;
    private static bool StringArray(JsonElement obj, string name, int min, int max, int textMax) => Array(obj, name, min, max) && obj.GetProperty(name).EnumerateArray().All(x => Text(x, textMax));
    private static bool OptionalStringArray(JsonElement obj, string name, int max, int textMax) => !obj.TryGetProperty(name, out _) || StringArray(obj, name, 0, max, textMax);
    private static bool Scalar(JsonElement value) => value.ValueKind is JsonValueKind.String or JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False or JsonValueKind.Null;
    private static bool Row(JsonElement row) => row.ValueKind == JsonValueKind.Array && row.GetArrayLength() <= 24 && row.EnumerateArray().All(Scalar);
    private static bool ListItem(JsonElement item) => Text(item, 4000) || item.ValueKind == JsonValueKind.Object && Shape(item, ["title"], ["description"]) && TextProperty(item, "title", 240) && OptionalText(item, "description", 4000);
    private static bool Field(JsonElement field) => field.ValueKind == JsonValueKind.Object && Shape(field, ["name", "label", "type"], ["required", "options", "placeholder"]) && TextProperty(field, "name", 120) && IdPattern.IsMatch(field.GetProperty("name").GetString() ?? "") && TextProperty(field, "label", 160) && StringEnum(field, "type", ["text", "email", "number", "select", "textarea"]) && (!field.TryGetProperty("required", out var required) || required.ValueKind is JsonValueKind.True or JsonValueKind.False) && OptionalText(field, "placeholder", 240) && (!field.TryGetProperty("options", out _) || StringArray(field, "options", 0, 40, 160));
    private static bool Action(JsonElement action) => action.ValueKind == JsonValueKind.Object && Shape(action, ["id", "label", "action"], ["requires_approval", "payload"]) && TextProperty(action, "id", 120) && IdPattern.IsMatch(action.GetProperty("id").GetString() ?? "") && TextProperty(action, "label", 160) && TextProperty(action, "action", 120) && IdPattern.IsMatch(action.GetProperty("action").GetString() ?? "") && (!action.TryGetProperty("payload", out var payload) || payload.ValueKind == JsonValueKind.Object) && (!action.TryGetProperty("requires_approval", out var approval) || approval.ValueKind is JsonValueKind.True or JsonValueKind.False);
    private static bool OptionalActions(JsonElement obj, string name, int max) => !obj.TryGetProperty(name, out _) || Array(obj, name, 0, max) && obj.GetProperty(name).EnumerateArray().All(Action);
    private static bool Badge(JsonElement item) => item.ValueKind == JsonValueKind.Object && Shape(item, ["label"], ["tone"]) && TextProperty(item, "label", 120) && (!item.TryGetProperty("tone", out _) || StringEnum(item, "tone", ["neutral", "info", "success", "warning", "danger"]));
    private static bool KeyValue(JsonElement item) => item.ValueKind == JsonValueKind.Object && Shape(item, ["key", "value"]) && TextProperty(item, "key", 160) && Scalar(item.GetProperty("value"));
    private static bool Number(JsonElement obj, string name, double min, double max) => obj.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) && double.IsFinite(number) && number >= min && number <= max;
    private static bool StringEnum(JsonElement obj, string name, string[] values) => obj.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String && values.Contains(value.GetString());
    private static bool Image(JsonElement image) => image.ValueKind == JsonValueKind.Object && Shape(image, ["url", "alt"], ["caption"]) && TextProperty(image, "url", 2048) && SafeImage(image.GetProperty("url").GetString() ?? "") && TextProperty(image, "alt", 240) && OptionalText(image, "caption", 240);
    private static bool Images(JsonElement images) => images.EnumerateArray().All(Image);
    private static bool Point(JsonElement point) => point.ValueKind == JsonValueKind.Object && Shape(point, ["label", "value"], ["series"]) && TextProperty(point, "label", 160) && Number(point, "value", double.MinValue, double.MaxValue) && OptionalText(point, "series", 80);
    private static bool Node(JsonElement node) => node.ValueKind == JsonValueKind.Object && Shape(node, ["id", "label", "x", "y"]) && TextProperty(node, "id", 120) && IdPattern.IsMatch(node.GetProperty("id").GetString() ?? "") && TextProperty(node, "label", 160) && Number(node, "x", -10000, 10000) && Number(node, "y", -10000, 10000);
    private static bool Edge(JsonElement edge) => edge.ValueKind == JsonValueKind.Object && Shape(edge, ["source", "target"], ["label"]) && TextProperty(edge, "source", 120) && IdPattern.IsMatch(edge.GetProperty("source").GetString() ?? "") && TextProperty(edge, "target", 120) && IdPattern.IsMatch(edge.GetProperty("target").GetString() ?? "") && OptionalText(edge, "label", 120);
    public static bool SafeImage(string value) => Uri.TryCreate(value, UriKind.Absolute, out var uri) && ((uri.Scheme == Uri.UriSchemeHttps && string.IsNullOrEmpty(uri.UserInfo)) || Regex.IsMatch(value, @"^data:image/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$", RegexOptions.IgnoreCase));
    private static int Depth(JsonElement value, int depth) => value.ValueKind switch
    {
        JsonValueKind.Object => value.EnumerateObject().Select(p => Depth(p.Value, depth + 1)).DefaultIfEmpty(depth).Max(),
        JsonValueKind.Array => value.EnumerateArray().Select(v => Depth(v, depth + 1)).DefaultIfEmpty(depth).Max(),
        _ => depth
    };
}
