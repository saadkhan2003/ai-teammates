using Dapper;

namespace Teammates.Api;

/// <summary>Compatibility for Origin console restrictions; v0.5 routing, budgets and policy gates remain authoritative.</summary>
public static class AdminModelAdmission
{
    public const string Paused = "AI requests are temporarily paused.";
    public const string Limit = "The spending limit has been reached. Please try again later.";

    public static string? Reason(bool globalKill, bool enabled, bool killed, int capCents, decimal spentUsd) =>
        globalKill || !enabled || killed ? Paused : capCents > 0 && spentUsd * 100 >= capCents ? Limit : null;

    public static async Task<string?> Check(Platform platform, string model, CancellationToken ct)
    {
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var row = await conn.QuerySingleAsync<(bool GlobalKill, bool Enabled, bool Killed, int Cap, decimal Spent)>("""
            SELECT coalesce((SELECT enabled FROM feature_flags WHERE key='model_kill'),false),
                coalesce(r.enabled,true),coalesce(r.killed,false),coalesce(r.daily_spend_cap_cents,0),
                coalesce((SELECT sum(cost_usd) FROM model_calls
                    WHERE coalesce(served_model,model)=@model AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)
            FROM (SELECT 1) singleton LEFT JOIN model_registry r ON r.id=@model
            """, new { model });
        return Reason(row.GlobalKill, row.Enabled, row.Killed, row.Cap, row.Spent);
    }
}
