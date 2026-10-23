using System.Text;

namespace Teammates.Api;

public static class LibraryKinds
{
    private static readonly IReadOnlyDictionary<string, string> Extensions = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        ["png"]="image", ["jpg"]="image", ["jpeg"]="image", ["gif"]="image", ["webp"]="image", ["bmp"]="image", ["heic"]="image",
        ["mp4"]="video", ["webm"]="video", ["mov"]="video", ["mkv"]="video", ["mp3"]="audio", ["wav"]="audio", ["ogg"]="audio", ["m4a"]="audio",
        ["pdf"]="pdf", ["txt"]="text", ["log"]="text", ["csv"]="sheet", ["tsv"]="sheet", ["xlsx"]="sheet", ["xls"]="sheet", ["ods"]="sheet",
        ["md"]="markdown", ["markdown"]="markdown", ["html"]="code", ["htm"]="code", ["css"]="code", ["js"]="code", ["mjs"]="code", ["ts"]="code", ["tsx"]="code", ["jsx"]="code", ["py"]="code", ["cs"]="code", ["json"]="code", ["xml"]="code", ["yaml"]="code", ["yml"]="code", ["sh"]="code", ["sql"]="code",
        ["doc"]="doc", ["docx"]="doc", ["odt"]="doc", ["ppt"]="doc", ["pptx"]="doc", ["zip"]="archive", ["tar"]="archive", ["gz"]="archive", ["7z"]="archive", ["rar"]="archive"
    };

    private static readonly IReadOnlyDictionary<string, string> Mimes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        ["image/"]="image", ["video/"]="video", ["audio/"]="audio", ["application/pdf"]="pdf", ["text/markdown"]="markdown", ["text/plain"]="text", ["text/csv"]="sheet",
        ["application/zip"]="archive", ["application/x-7z-compressed"]="archive", ["application/vnd.ms-excel"]="sheet", ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]="sheet",
        ["application/msword"]="doc", ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]="doc", ["application/json"]="code", ["application/xml"]="code"
    };

    public static string Detect(string? name, string? mime)
    {
        var ext = Path.GetExtension(name ?? "").TrimStart('.');
        if (Extensions.TryGetValue(ext, out var kind)) return kind;
        var contentType = (mime ?? "").Trim();
        foreach (var (prefix, mapped) in Mimes)
            if (prefix.EndsWith('/') ? contentType.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) : contentType.Equals(prefix, StringComparison.OrdinalIgnoreCase)) return mapped;
        if (contentType.StartsWith("text/", StringComparison.OrdinalIgnoreCase)) return "text";
        if (contentType.StartsWith("application/vnd.", StringComparison.OrdinalIgnoreCase) && contentType.Contains("presentation", StringComparison.OrdinalIgnoreCase)) return "doc";
        return "unknown";
    }

    public static string SniffMime(ReadOnlySpan<byte> bytes, string? name = null)
    {
        if (bytes.StartsWith(new byte[] { 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a })) return "image/png";
        if (bytes.StartsWith(new byte[] { 0xff, 0xd8, 0xff })) return "image/jpeg";
        if (bytes.StartsWith("GIF87a"u8) || bytes.StartsWith("GIF89a"u8)) return "image/gif";
        if (bytes.Length >= 12 && bytes[..4].SequenceEqual("RIFF"u8) && bytes.Slice(8, 4).SequenceEqual("WEBP"u8)) return "image/webp";
        if (bytes.StartsWith("%PDF-"u8)) return "application/pdf";
        if (bytes.StartsWith("PK\u0003\u0004"u8)) return "application/zip";
        if (bytes.StartsWith(new byte[] { 0x1a, 0x45, 0xdf, 0xa3 })) return "video/webm";
        try
        {
            _ = new UTF8Encoding(false, true).GetCharCount(bytes);
            var ext = Path.GetExtension(name ?? "").TrimStart('.');
            return new[] { "txt", "log", "md", "markdown", "csv", "tsv", "json", "html", "htm", "xml", "css", "js", "mjs", "ts", "tsx", "jsx", "py", "cs", "yaml", "yml", "sh", "sql" }.Contains(ext, StringComparer.OrdinalIgnoreCase)
                ? "text/plain"
                : "application/octet-stream";
        }
        catch (DecoderFallbackException) { return "application/octet-stream"; }
    }

    public static string SanitizeName(string? name)
    {
        var leaf = (name ?? "").Replace('\\', '/').Split('/').LastOrDefault() ?? "";
        var clean = new StringBuilder(leaf.Length);
        foreach (var c in leaf)
            if (!char.IsControl(c) && c is not '/' and not '\\') clean.Append(c);
        var value = clean.ToString().Trim().Trim('.');
        if (value.Length > 255) value = value[..255];
        return string.IsNullOrWhiteSpace(value) ? "file" : value;
    }

    public static bool IsDeniedName(string? name)
    {
        var normalized = (name ?? "").Replace('\\', '/').ToLowerInvariant();
        var leaf = normalized.Split('/').LastOrDefault() ?? "";
        return leaf == ".env" || leaf.StartsWith(".env.", StringComparison.Ordinal) || leaf.EndsWith(".pem", StringComparison.Ordinal) || leaf.EndsWith(".key", StringComparison.Ordinal) ||
               leaf.StartsWith("id_", StringComparison.Ordinal) || leaf.Contains("secret", StringComparison.Ordinal) || leaf.Contains("token", StringComparison.Ordinal) ||
               leaf.Contains("credential", StringComparison.Ordinal) || leaf.Contains("cookies", StringComparison.Ordinal) ||
               normalized.Split('/').Any(part => part is ".git" or ".ssh" or "secrets" or "vault" or "browser-profile" or "browser" or "profile");
    }

    public static string ContentMime(string ext, string kind) => ext.ToLowerInvariant() switch
    {
        "png" => "image/png", "jpg" or "jpeg" => "image/jpeg", "gif" => "image/gif", "webp" => "image/webp",
        "pdf" => "application/pdf", "mp4" => "video/mp4", "webm" => "video/webm", "mp3" => "audio/mpeg", "wav" => "audio/wav",
        "txt" or "log" or "md" or "markdown" or "csv" or "tsv" or "json" or "py" or "cs" or "js" or "ts" or "tsx" or "jsx" or "css" or "sh" or "sql" or "yaml" or "yml" => "text/plain; charset=utf-8",
        "html" or "htm" => "text/html", "svg" => "image/svg+xml", "xml" => "application/xml",
        _ when kind == "image" => "application/octet-stream", _ => "application/octet-stream"
    };

    public static bool InlineSafe(string ext, string kind) => ext.ToLowerInvariant() is "png" or "jpg" or "jpeg" or "webp" or "gif" or "pdf" or "mp4" or "webm" or "mp3" or "wav" or "txt" or "md" or "markdown" or "json" or "csv" or "tsv" or "py" or "cs" or "js" or "ts" or "tsx" or "jsx" or "css" or "sh" or "sql" or "yaml" or "yml";
}
