using System.Text.Json;
using System.Text.RegularExpressions;

namespace Teammates.Api;

public interface IActionReviewer
{
    Task<string?> ReviewAsync(string tool, JsonElement args, CancellationToken ct);
}

/// <summary>Deterministic default reviewer; production model review can be injected behind IActionReviewer.</summary>
public sealed class RuleBasedActionReviewer : IActionReviewer
{
    private static readonly Regex RiskyShell = new(@"\b(rm|sudo|curl|wget|chmod|chown|kill|systemctl|shutdown|reboot|git\s+push)\b|[>]{1,2}", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly HashSet<string> ReviewTools = new(StringComparer.OrdinalIgnoreCase)
    {
        "launch_app", "open_app", "browser_click", "computer_click", "computer_type", "computer_key", "computer_use",
        "write_file", "edit_file", "delete_file", "automation_write", "delegate", "message_bot",
        "create_bot", "create_routine", "update_routine"
    };

    public Task<string?> ReviewAsync(string tool, JsonElement args, CancellationToken ct)
    {
        if (tool is "shell" or "setup_env")
        {
            var command = args.ValueKind == JsonValueKind.Object && args.TryGetProperty("command", out var node) && node.ValueKind == JsonValueKind.String
                ? node.GetString() ?? "" : "";
            if (command.Length > 16_384 || RiskyShell.IsMatch(command)) return Task.FromResult<string?>("ask");
        }
        return Task.FromResult<string?>(ReviewTools.Contains(tool) ? "ask" : null);
    }
}
