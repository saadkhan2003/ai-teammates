namespace Teammates.Api;

public static class ToolDedupe
{
    private static readonly HashSet<string> NonIdempotentTools = new(StringComparer.Ordinal)
    {
        "shell", "write_file", "edit_file", "delete_file", "git_commit", "setup_env", "run_tests"
    };

    public static bool Applies(string tool, string? idempotencyKey) =>
        idempotencyKey is { Length: > 0 } && NonIdempotentTools.Contains(tool);

    public static string Decide(string? status) => Decide(status, 0);

    public static string Decide(string? status, double ageSeconds) => status switch
    {
        "completed" => "replay",
        "in_progress" when ageSeconds <= 300 => "in_progress",
        _ => "execute"
    };
}
