namespace Teammates.Api;

public static class ThemeChoice
{
    public const string Default = "system";

    public static string? Normalize(string? value) => value is "light" or "dark" or "system" ? value : null;
}
