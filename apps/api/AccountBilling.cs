using System.Text.Json;
using System.Text.RegularExpressions;

namespace Teammates.Api;

public sealed record Plan(string Id, string Name, string Detail, int PriceCents, int MonthlyCredits, string[] Features);

public sealed record CheckoutRequest(string PlanId, int AmountCents, string Currency, string AccountId);

public sealed record BillingCheckout(string Provider, string Status, string? CheckoutUrl, bool ChargesCard);

public interface IBillingProvider
{
    string Name { get; }
    BillingCheckout Checkout(CheckoutRequest request);
}

public sealed class MockBillingProvider : IBillingProvider
{
    public string Name => BillingProviders.Mock;

    public BillingCheckout Checkout(CheckoutRequest request) =>
        new(BillingProviders.Mock, "completed", null, false);
}

public sealed class BillingProviderException : Exception
{
    public BillingProviderException(string message) : base(message)
    {
    }
}

public static class BillingProviders
{
    public const string Mock = "mock";
    public const string Paddle = "paddle";
    public const string LemonSqueezy = "lemonsqueezy";

    public static IBillingProvider Create(string? name, Func<string, string?> readConfig)
    {
        var chosen = string.IsNullOrWhiteSpace(name) ? Mock : name.Trim().ToLowerInvariant();
        if (chosen is Paddle or LemonSqueezy)
        {
            var keyName = chosen == Paddle ? "PADDLE_API_KEY" : "LEMONSQUEEZY_API_KEY";
            var key = readConfig(keyName);
            if (string.IsNullOrWhiteSpace(key))
                throw new BillingProviderException($"{chosen} is not configured. This build does not call a live payment provider.");
            throw new BillingProviderException($"{chosen} is not included in this build. Use the mock provider.");
        }
        if (chosen != Mock)
            throw new BillingProviderException("Unknown billing provider.");
        return new MockBillingProvider();
    }
}

public static class PlanCatalog
{
    public static readonly Plan[] All =
    [
        new("free", "Free", "Try a teammate with a small monthly credit grant.", 0, 500, ["500 credits each month", "One teammate", "Email help"]),
        new("pro", "Pro", "Daily work with your teammates.", 2000, 5000, ["5,000 credits each month", "Daily teammates", "Usage history"]),
        new("team", "Team", "A shared pool of monthly credits.", 8000, 20000, ["20,000 credits each month", "Shared credit pool", "A workspace for the group"]),
    ];

    public static Plan? Find(string? id) => All.FirstOrDefault(plan => plan.Id == id);

    public static Dictionary<string, int> DefaultAllowances() =>
        All.ToDictionary(plan => plan.Id, plan => plan.MonthlyCredits);

    public static bool TryParseAllowances(string? json, out Dictionary<string, int> allowances)
    {
        allowances = [];
        if (string.IsNullOrWhiteSpace(json)) return false;
        try
        {
            var parsed = JsonSerializer.Deserialize<Dictionary<string, int>>(json);
            if (parsed == null) return false;
            foreach (var plan in All)
            {
                if (!parsed.TryGetValue(plan.Id, out var credits) || credits < 0 || credits > 1_000_000) return false;
                allowances[plan.Id] = credits;
            }
            return allowances.Count == All.Length;
        }
        catch (JsonException)
        {
            return false;
        }
    }
}

public static class BillingMath
{
    public static int Used(int allowance, int balance) => Math.Max(0, allowance - Math.Max(0, balance));

    public static int Percent(int allowance, int balance)
    {
        if (allowance <= 0) return balance <= 0 ? 100 : 0;
        return (int)Math.Clamp(Math.Round(Used(allowance, balance) * 100.0 / allowance), 0, 100);
    }

    public static bool PeriodElapsed(DateTime periodStart, DateTime now) =>
        periodStart.Year < now.Year || (periodStart.Year == now.Year && periodStart.Month < now.Month);

    public static (int Balance, int Allowance, string PlanId) ApplyPlan(string planId, IReadOnlyDictionary<string, int> allowances)
    {
        var plan = PlanCatalog.Find(planId) ?? throw new ArgumentException("unknown plan");
        var allowance = allowances.TryGetValue(plan.Id, out var credits) ? credits : plan.MonthlyCredits;
        return (allowance, allowance, plan.Id);
    }

    public static int AdjustBalance(int current, int? setTo, int? delta)
    {
        var next = setTo ?? current + (delta ?? 0);
        if (next < 0 || next > 1_000_000) throw new ArgumentOutOfRangeException(nameof(setTo));
        return next;
    }

    public static bool CreatesInvoice(Plan plan) => plan.PriceCents > 0;

    public static DateTime RenewsAt(DateTime periodStart)
    {
        var start = DateTime.SpecifyKind(periodStart, DateTimeKind.Utc);
        return new DateTime(start.Year, start.Month, 1, 0, 0, 0, DateTimeKind.Utc).AddMonths(1);
    }
}

public static class PlatformModel
{
    public const string DefaultId = "anthropic/claude-haiku-5.5";
    public const string DefaultLabel = "Claude Haiku 5.5";

    public static bool ValidId(string? id) =>
        id != null && Regex.IsMatch(id, "^[a-zA-Z0-9][a-zA-Z0-9._/-]{1,80}$");

    public static bool ValidLabel(string? label) =>
        !string.IsNullOrWhiteSpace(label) && label.Trim().Length <= 80;
}

public static class AccountInput
{
    public static bool ValidEmail(string? email) =>
        !string.IsNullOrWhiteSpace(email)
        && email.Length <= 200
        && Regex.IsMatch(email, "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$");

    public static bool ValidDisplayName(string? name)
    {
        var trimmed = name?.Trim() ?? "";
        return trimmed.Length is >= 1 and <= 80;
    }

    public static bool ValidAvatar(string? url)
    {
        if (string.IsNullOrEmpty(url)) return true;
        if (url.Contains(' ') || url.Contains('\n')) return false;
        if (url.StartsWith("https://", StringComparison.OrdinalIgnoreCase) && url.Length <= 500) return true;
        return url.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase)
            && url.Contains(";base64,", StringComparison.Ordinal)
            && url.Length <= 180_000;
    }

    public static bool ValidPassword(string? password) => password != null && password.Length is >= 8 and <= 200;

    public static bool CanDelete(string? role, int activeOwners) => !(role == "owner" && activeOwners <= 1);
}

public static class SignInMethods
{
    public static readonly string[] Optional = ["google", "github"];

    public static bool CanConnect(string? provider) =>
        provider != null && Optional.Contains(provider, StringComparer.OrdinalIgnoreCase);

    public static string Label(string provider) => provider.ToLowerInvariant() switch
    {
        "google" => "Google",
        "github" => "GitHub",
        "password" => "Password",
        _ => provider
    };
}

public static class AccountSearch
{
    public static bool Matches(string? query, string username, string displayName, string email)
    {
        if (string.IsNullOrWhiteSpace(query)) return true;
        var needle = query.Trim();
        return username.Contains(needle, StringComparison.OrdinalIgnoreCase)
            || displayName.Contains(needle, StringComparison.OrdinalIgnoreCase)
            || email.Contains(needle, StringComparison.OrdinalIgnoreCase);
    }
}

public static class HelpContent
{
    public static readonly (string Id, string Question, string Answer)[] Faq =
    [
        ("credits", "Where do monthly credits come from?", "Each plan includes a monthly credit grant. The platform spends those credits when a teammate works. You do not paste a key on this page."),
        ("answers", "Who chooses how a teammate answers?", "The platform chooses. You do not pick or paste an id."),
        ("payments", "How do payments work?", "Open Billing, compare the plans, and choose one. Paid plans renew monthly. Invoices are listed on the same page."),
        ("password", "How do I change my password?", "Open Account, enter the current password and a new one of at least 8 characters, then choose Update password."),
        ("delete", "How do I delete my account?", "The danger card at the bottom of Account asks for your password and the word DELETE. The only owner cannot delete the account."),
        ("admin", "Where are users and credits managed?", "Owners and admins use a separate admin site. It is not a page in this app."),
    ];

    public static readonly (string Href, string Title, string Detail)[] Docs =
    [
        ("/docs/COMPANION.md", "Companion app", "Install the desktop companion."),
        ("/settings/usage", "Usage", "Credits left for this account."),
        ("/account/status", "Status", "Whether the platform is up."),
        ("/account/changelog", "Changelog", "What shipped recently."),
    ];

    public static readonly string[] Topics = ["account", "billing", "bug", "other"];
}

public static class LegalContent
{
    public const string Banner = "PLACEHOLDER. This text is not a legal agreement and it is not legal advice.";

    public static readonly (string Title, string Body) Terms = (
        "Terms of use",
        """
        PLACEHOLDER. These terms are sample copy for the product interface. They do not bind anyone.

        AI Teammates lets an account owner run bots on the platform. Plans grant monthly credits and renew on the first of each month.

        Replace this page with counsel-reviewed terms before a public launch. PLACEHOLDER.
        """);

    public static readonly (string Title, string Body) Privacy = (
        "Privacy",
        """
        PLACEHOLDER. This privacy note is sample copy for the product interface. It is not a privacy policy.

        The account page stores a display name, email, avatar, and a password hash. Billing stores a plan, a credit balance, and invoices. Support stores the message you send from Help.

        Replace this page with a counsel-reviewed policy before a public launch. PLACEHOLDER.
        """);
}

public static class ChangelogContent
{
    public static readonly (string Id, string Date, string Title, string Body)[] Entries =
    [
        ("account-pages", "2026-10-24", "Account, billing, and support", "Profile, billing, help, legal pages, status, and changelog. Owners and admins use a separate admin site."),
        ("themes", "2026-10-23", "Light, dark, and system", "Every surface follows the theme. System tracks the device."),
        ("credits", "2026-10-23", "Platform credits", "Plans grant monthly credits. Usage on this site shows credits only."),
    ];
}

