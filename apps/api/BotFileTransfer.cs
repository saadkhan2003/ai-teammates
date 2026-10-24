namespace Teammates.Api;

public sealed class FileTransferTooLargeException : Exception { }

public static class BotFileTransfer
{
    public const long MaximumBytes = 100L * 1024 * 1024;

    /// <summary>Copies incrementally and stops as soon as a caller exceeds the configured cap.</summary>
    public static async Task<byte[]> ReadBoundedAsync(Stream input, long maximum, CancellationToken ct)
    {
        if (maximum < 0) throw new ArgumentOutOfRangeException(nameof(maximum));
        using var output = new MemoryStream((int)Math.Min(maximum, 64 * 1024));
        var buffer = new byte[64 * 1024];
        long total = 0;
        while (true)
        {
            var read = await input.ReadAsync(buffer.AsMemory(), ct);
            if (read == 0) break;
            total += read;
            if (total > maximum) throw new FileTransferTooLargeException();
            await output.WriteAsync(buffer.AsMemory(0, read), ct);
        }
        return output.ToArray();
    }

    public static string SniffContentType(string fileName, ReadOnlySpan<byte> data)
    {
        if (data.StartsWith("\x89PNG\r\n\x1a\n"u8)) return "image/png";
        if (data.StartsWith("\xff\xd8\xff"u8)) return "image/jpeg";
        if (data.StartsWith("GIF87a"u8) || data.StartsWith("GIF89a"u8)) return "image/gif";
        if (data.StartsWith("%PDF-"u8)) return "application/pdf";
        if (data.StartsWith("PK\x03\x04"u8)) return "application/zip";
        if (data.IndexOf((byte)0) >= 0) return "application/octet-stream";
        foreach (var b in data)
            if (b < 0x09 || (b > 0x0d && b < 0x20)) return "application/octet-stream";
        return "text/plain; charset=utf-8";
    }

    public static bool BlockedByDlp(string content)
    {
        if (Dlp.HasStrict(content) || content.Contains("secret://", StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    public static bool IsSafePathHeader(string? path) => !string.IsNullOrWhiteSpace(path) && !path.Contains('\0') && path.Length <= 4096;
}
