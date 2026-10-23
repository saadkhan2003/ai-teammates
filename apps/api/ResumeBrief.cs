using Teammates.Compute;

namespace Teammates.Api;

public static class ResumeBrief
{
    public static string Build(int attempt, string reason, int stepsUsed, int maxSteps, string instruction,
        IReadOnlyList<(int Index, string Title, string Status)> plan, string? lastCommit)
    {
        static string Clean(string? value, int limit = int.MaxValue)
        {
            var clean = InjectionFilter.Strip(Dlp.Redact(OutputRedactor.Redact(value ?? "")));
            return clean[..Math.Min(limit, clean.Length)];
        }

        var current = plan.FirstOrDefault(x => x.Status == "in_progress");
        if (current == default) current = plan.FirstOrDefault(x => x.Status is "pending" or "blocked");
        var planText = plan.Count == 0 ? "(no plan items)" : string.Join("\n", plan.Select(item =>
            $"[{(item.Status == "done" ? "x" : " ")}] {item.Index} {Clean(item.Title)}{(item.Index == current.Index && item.Status != "done" ? " ← current" : "")}"));
        var commit = string.IsNullOrWhiteSpace(lastCommit) ? "unknown" : Clean(lastCommit, 160);
        return InjectionFilter.Strip(Dlp.Redact(OutputRedactor.Redact($"""
            You were interrupted and restarted (attempt {attempt}, reason {Clean(reason, 80)}, at step {Math.Max(0, stepsUsed)} of the {Math.Max(0, maxSteps)} step budget).
            Goal: {Clean(instruction, 1000)}
            Plan:
            {planText}
            Repo state: last commit {commit}.
            Calls with unknown outcome may have partly run. Check their result before repeating them. Do not repeat sends, payments, or deletes without verifying.
            Next: check the current plan item and continue. Do not restart finished items.
            """)));
    }
}
