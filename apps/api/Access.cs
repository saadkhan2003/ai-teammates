namespace Teammates.Api;

public static class Access
{
    public static bool IsStaff(string? role) => role is "owner" or "admin";

    public static bool CanEnterAdmin(string? role) => role is "owner" or "admin" or "support" or "readonly";

    public static bool CanSupport(string? role) => role is "owner" or "admin" or "support";

    public static bool CanOperate(string? role) => IsStaff(role);

    public static bool CanOwn(string? role) => role == "owner";

    public static bool RequiresTotp(string? role) => IsStaff(role);

    public static bool Allows(string? role, string action) => action switch
    {
        "read" => CanEnterAdmin(role),
        "totp" => RequiresTotp(role),
        "note" or "ticket" or "announce" => CanSupport(role),
        "suspend" or "ban" or "reset" or "impersonate" or "kill" or "flag" or "grant" or "plan" or "plugin" or "template" or "alert" or "export" or "org" or "transcript" => CanOperate(role),
        "delete" or "refund" or "maintenance" or "secret" or "gdpr" or "apikey" or "cleanup" or "backup" => CanOwn(role),
        _ => false
    };

    public static bool BlocksUntilTotp(string? role, string action, bool enrolled) =>
        RequiresTotp(role) && action is not ("read" or "totp") && !enrolled;

    public static bool CanGrant(string? actorRole, string? targetRole)
    {
        if (actorRole == "owner") return targetRole is "admin" or "support" or "readonly" or "member";
        if (actorRole == "admin") return targetRole == "member";
        return false;
    }

    public static bool CanChangeStatus(string? actorRole, string? targetRole) =>
        actorRole == "owner" ? targetRole is "owner" or "admin" or "member"
        : actorRole == "admin" && targetRole == "member";
}
