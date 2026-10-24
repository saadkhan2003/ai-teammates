using System.Text.Json;
using System.Text.RegularExpressions;

namespace Teammates.Api;

/// <summary>The "Learn from demonstration" skill chip: a user message that carries a screen recording.</summary>
public static class DemoSkill
{
    public const string Id = "learn-from-demonstration";
    public const string Label = "Learn from demonstration";
    private static readonly Regex SafePath = new(@"^/workspace/(?:recordings|teach-sessions)/[A-Za-z0-9._\-/ ]{1,180}\.(?:webm|mp4)$", RegexOptions.Compiled);

    public static bool ValidRecording(string? path) => path != null && SafePath.IsMatch(path) && !path.Contains("..");

    public static string Instruction(string content, string recording) =>
        "Skill: Learn from demonstration.\n" +
        $"The user recorded a screen demonstration of a task, saved at {recording}.\n" +
        "1. Watch the recording: sample frames (for example with ffmpeg) and note each step the user took.\n" +
        "2. Extract the steps as a short ordered list, with the app or site, the action, and the expected result.\n" +
        "3. Write a reusable skill draft to /workspace/skills/<short-name>/SKILL.md with a name, a one-line description of when to use it, and the numbered steps. Mark anything you are unsure about.\n" +
        $"4. Delete the raw recording {recording} once the draft is saved, and tell the user where the draft is and what it covers.\n" +
        "Do not include passwords, card numbers or other private values you may have seen; refer to them as placeholders.\n\n" +
        content;

    public static string Metadata(string recording) => JsonSerializer.Serialize(new
    {
        skill = new { id = Id, label = Label },
        attachments = new[] { new { path = recording, name = Path.GetFileName(recording), mime = recording.EndsWith(".mp4", StringComparison.OrdinalIgnoreCase) ? "video/mp4" : "video/webm" } },
    });
}
