namespace Teammates.Api;

public static class RunBudget
{
    public sealed record Budget(int MaxSteps, int MaxSeconds, string Label);
    public static Budget Resolve(int? taskSteps, int? taskSeconds, int? botSteps, int? botSeconds)
    {
        var steps = Clamp(taskSteps ?? botSteps ?? 200, 4, 1000);
        var seconds = Clamp(taskSeconds ?? botSeconds ?? 3600, 30, 21600);
        return new Budget(steps, seconds, $"{steps} steps · {Math.Max(1, (int)Math.Ceiling(seconds / 60d))} min");
    }
    private static int Clamp(int value, int min, int max) => Math.Clamp(value, min, max);
}

public enum StallDecision { None, Nudge, Block }
public static class StallPolicy
{
    public static StallDecision Decide(TimeSpan sinceProgress, int nudges, TimeSpan window) =>
        nudges >= 1 && sinceProgress >= window + window ? StallDecision.Block :
        nudges == 0 && sinceProgress >= window ? StallDecision.Nudge : StallDecision.None;
}

public static class TestGate
{
    public static bool Check(bool required, DateTimeOffset? passedAt, bool overridden) => !required || passedAt != null || overridden;
}

public static class ChildTaskPolicy
{
    public const int MaxActiveChildren = 3;
    public const int MaxDepth = 1;
    public static string Worktree(string repo, string childId) => $"{repo.TrimEnd('/')}/.worktrees/{childId[..8]}";
    public static string Branch(string childId) => "task/" + childId[..8];
}

public static class DurationEstimate
{
    public static (double LowSeconds, double HighSeconds, int Count)? Range(IReadOnlyList<double> seconds)
    {
        if (seconds.Count < 3) return null;
        var sorted = seconds.Where(double.IsFinite).Where(x => x >= 0).Order().ToArray();
        if (sorted.Length < 3) return null;
        static double P(double[] a, double p) => a[(int)Math.Floor((a.Length - 1) * p)];
        static double Round(double s) => s < 60 ? Math.Round(s / 5) * 5 : Math.Round(s / 60) * 60;
        return (Round(P(sorted, .25)), Round(P(sorted, .75)), sorted.Length);
    }
}

public static class CiSummary
{
    public static (string State, object[] Checks) From(string json)
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            var checks = doc.RootElement.ValueKind == System.Text.Json.JsonValueKind.Array ? doc.RootElement.EnumerateArray().ToArray() : [];
            var state = checks.Any(x => Read(x, "state") is "FAILURE" or "ERROR") ? "failing" :
                checks.Length > 0 && checks.All(x => Read(x, "state") is "SUCCESS" or "NEUTRAL" or "SKIPPED") ? "passing" :
                checks.Length > 0 ? "pending" : "unknown";
            return (state, checks.Select(x => (object)new { name = Read(x, "name"), state = Read(x, "state"), link = Read(x, "link") }).ToArray());
        }
        catch { return ("unknown", []); }
    }
    private static string Read(System.Text.Json.JsonElement e, string name) => e.TryGetProperty(name, out var v) ? v.ToString() : "";
}
