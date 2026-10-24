namespace Teammates.Api;

public static class BotBio
{
    public const int MaxChars = 60;

    /// <summary>Single line, trimmed, at most 60 chars. Returns null when it is not acceptable (secret-shaped or too long).</summary>
    public static string? Normalize(string? raw)
    {
        var text = string.Join(' ', (raw ?? "").Split(new[] { '\r', '\n', '\t' }, StringSplitOptions.RemoveEmptyEntries)).Trim();
        if (text.Length > MaxChars) return null;
        if (text.Length > 0 && Dlp.HasStrict(text)) return null;
        return text;
    }
}
