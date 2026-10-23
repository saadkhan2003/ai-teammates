using System.Text.Json.Nodes;

namespace Teammates.Api;

public static class TaskCheckpoint
{
    public const int MaxBytes = 8192;

    public static JsonObject Read(string? json)
    {
        try { return JsonNode.Parse(json ?? "{}") as JsonObject ?? new JsonObject(); }
        catch { return new JsonObject(); }
    }

    public static string Bounded(JsonObject ledger)
    {
        var json = ledger.ToJsonString();
        if (System.Text.Encoding.UTF8.GetByteCount(json) <= MaxBytes) return json;
        // Historical attempt metadata is bounded; keep the newest records and counters.
        if (ledger["attempts"] is JsonArray attempts)
            while (attempts.Count > 1 && System.Text.Encoding.UTF8.GetByteCount(ledger.ToJsonString()) > MaxBytes)
                attempts.RemoveAt(0);
        json = ledger.ToJsonString();
        if (System.Text.Encoding.UTF8.GetByteCount(json) <= MaxBytes) return json;
        var keep = new JsonObject { ["v"] = 1 };
        foreach (var key in new[] { "stepsUsed", "secondsUsed", "secondsBeforeAttempt", "attemptStepsAtStart", "modelRounds", "attempts", "lastToolCallId", "lastProgressAt", "attemptStartedAt", "lastLeaseAt", "lastAttemptProgress", "snapshotRef", "snapshotAt", "inFlightToolStartedAt", "inFlightToolTimeoutSeconds", "compactions", "lastCompactionAt", "compactionsWithoutRelief" })
            if (ledger[key] is { } value) keep[key] = value.DeepClone();
        return keep.ToJsonString();
    }

    public static string Id(string? value) => string.IsNullOrWhiteSpace(value)
        ? ""
        : new string(value.Where(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-').Take(100).ToArray());
}
