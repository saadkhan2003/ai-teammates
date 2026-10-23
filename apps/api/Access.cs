namespace Teammates.Api;

public static class Access
{
    public static bool IsStaff(string? role) => role is "owner" or "admin";

    public static bool CanGrant(string? actorRole, string? targetRole)
    {
        if (actorRole == "owner") return targetRole is "admin" or "member";
        if (actorRole == "admin") return targetRole == "member";
        return false;
    }

    public static bool CanChangeStatus(string? actorRole, string? targetRole) =>
        actorRole == "owner" ? targetRole is "owner" or "admin" or "member"
        : actorRole == "admin" && targetRole == "member";
}
