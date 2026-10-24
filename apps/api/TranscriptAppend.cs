using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Teammates.Api;

public enum TranscriptWriteKind { Append, Rewrite }

public readonly record struct TranscriptWriteDecision(TranscriptWriteKind Kind, int FromIndex)
{
    public static TranscriptWriteDecision Append(int fromIndex) => new(TranscriptWriteKind.Append, fromIndex);
    public static TranscriptWriteDecision Rewrite => new(TranscriptWriteKind.Rewrite, 0);
}

/// <summary>Determines whether a full transcript upload extends the durable transcript.</summary>
public static class TranscriptAppend
{
    public static TranscriptWriteDecision Decide(IReadOnlyList<string> storedDigests, IReadOnlyList<string> incomingDigests)
    {
        if (incomingDigests.Count < storedDigests.Count) return TranscriptWriteDecision.Rewrite;
        for (var i = 0; i < storedDigests.Count; i++)
            if (!StringComparer.Ordinal.Equals(storedDigests[i], incomingDigests[i]))
                return TranscriptWriteDecision.Rewrite;
        return TranscriptWriteDecision.Append(storedDigests.Count);
    }

    public static string Digest(string? role, string? content, string? toolCalls, string? toolCallId, string? name)
    {
        var canonicalTools = string.IsNullOrWhiteSpace(toolCalls) ? "" : CanonicalJson(toolCalls);
        var fields = new[] { role ?? "", content ?? "", canonicalTools, toolCallId ?? "", name ?? "" };
        var builder = new StringBuilder();
        foreach (var field in fields) builder.Append(field.Length).Append(':').Append(field);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(builder.ToString())));
    }

    private static string CanonicalJson(string json)
    {
        using var document = JsonDocument.Parse(json);
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream)) WriteCanonical(writer, document.RootElement);
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static void WriteCanonical(Utf8JsonWriter writer, JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var property in value.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
                {
                    writer.WritePropertyName(property.Name);
                    WriteCanonical(writer, property.Value);
                }
                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in value.EnumerateArray()) WriteCanonical(writer, item);
                writer.WriteEndArray();
                break;
            default:
                value.WriteTo(writer);
                break;
        }
    }
}
