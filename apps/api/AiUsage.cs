using System.Globalization;

namespace Teammates.Api;

public static class AiUsage
{
    // Catalog prices are USD per token. Keep provider-reported cost when present.
    public static TokenUsage Price(TokenUsage usage, AiEndpoint endpoint)
    {
        if (usage.CostUsd > 0 || endpoint.Catalog?.Pricing is not { } prices) return usage;
        decimal Rate(string key, decimal fallback = 0) => decimal.TryParse(prices.GetValueOrDefault(key), NumberStyles.Float, CultureInfo.InvariantCulture, out var n) ? Math.Max(0, n) : fallback;
        var prompt = Rate("prompt");
        var read = usage.CacheReadTokens; var write = usage.CacheCreationTokens;
        var cost = Math.Max(0, usage.PromptTokens - read - write) * prompt + read * Rate("input_cache_read", prompt) + write * Rate("input_cache_write", prompt) + usage.CompletionTokens * Rate("completion");
        return usage with { CostUsd = cost };
    }
}
