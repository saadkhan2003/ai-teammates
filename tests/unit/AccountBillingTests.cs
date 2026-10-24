using Teammates.Api;

namespace Teammates.UnitTests;

public class AccountBillingTests
{
    [Fact]
    public void MockCheckoutDoesNotChargeACard()
    {
        var provider = BillingProviders.Create(null, _ => null);
        var result = provider.Checkout(new CheckoutRequest("pro", 2000, "usd", "account"));
        Assert.Equal("mock", provider.Name);
        Assert.Equal("mock", result.Provider);
        Assert.Equal("completed", result.Status);
        Assert.Null(result.CheckoutUrl);
        Assert.False(result.ChargesCard);
    }

    [Theory]
    [InlineData("paddle", "PADDLE_API_KEY")]
    [InlineData("lemonsqueezy", "LEMONSQUEEZY_API_KEY")]
    public void LiveProvidersAreNotCalled(string name, string keyName)
    {
        var secret = "live-key-should-not-leak";
        var ex = Assert.Throws<BillingProviderException>(() => BillingProviders.Create(name, key => key == keyName ? secret : null));
        Assert.DoesNotContain(secret, ex.Message);
        Assert.Contains("mock", ex.Message);
    }

    [Fact]
    public void MissingLiveKeysDoNotInventAProvider()
    {
        var ex = Assert.Throws<BillingProviderException>(() => BillingProviders.Create("paddle", _ => "  "));
        Assert.Contains("not configured", ex.Message);
        Assert.DoesNotContain("http", ex.Message);
    }

    [Fact]
    public void MeterTracksTheMonthlyGrant()
    {
        Assert.Equal(1800, BillingMath.Used(5000, 3200));
        Assert.Equal(36, BillingMath.Percent(5000, 3200));
        Assert.Equal(0, BillingMath.Percent(5000, 9000));
        Assert.Equal(100, BillingMath.Percent(0, 0));
    }

    [Fact]
    public void ANewMonthRestoresTheGrant()
    {
        Assert.True(BillingMath.PeriodElapsed(new DateTime(2026, 9, 2, 0, 0, 0, DateTimeKind.Utc), new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc)));
        Assert.False(BillingMath.PeriodElapsed(new DateTime(2026, 10, 3, 0, 0, 0, DateTimeKind.Utc), new DateTime(2026, 10, 24, 0, 0, 0, DateTimeKind.Utc)));
    }

    [Fact]
    public void CheckoutAppliesThePlanGrantAndInvoicesPaidPlans()
    {
        var applied = BillingMath.ApplyPlan("pro", PlanCatalog.DefaultAllowances());
        Assert.Equal(("pro", 5000, 5000), (applied.PlanId, applied.Allowance, applied.Balance));
        Assert.True(BillingMath.CreatesInvoice(PlanCatalog.Find("pro")!));
        Assert.False(BillingMath.CreatesInvoice(PlanCatalog.Find("free")!));
        Assert.Throws<ArgumentException>(() => BillingMath.ApplyPlan("enterprise", PlanCatalog.DefaultAllowances()));
    }

    [Fact]
    public void CreditAdjustmentsStayInRange()
    {
        Assert.Equal(700, BillingMath.AdjustBalance(500, null, 200));
        Assert.Equal(40, BillingMath.AdjustBalance(500, 40, 200));
        Assert.Throws<ArgumentOutOfRangeException>(() => BillingMath.AdjustBalance(10, null, -11));
        Assert.Throws<ArgumentOutOfRangeException>(() => BillingMath.AdjustBalance(10, 1_000_001, null));
    }

    [Fact]
    public void AllowanceJsonMustCoverEveryPlan()
    {
        Assert.True(PlanCatalog.TryParseAllowances("{\"free\":100,\"pro\":200,\"team\":300}", out var parsed));
        Assert.Equal(200, parsed["pro"]);
        Assert.False(PlanCatalog.TryParseAllowances("{\"free\":100}", out _));
        Assert.False(PlanCatalog.TryParseAllowances("{\"free\":-1,\"pro\":1,\"team\":1}", out _));
        Assert.False(PlanCatalog.TryParseAllowances("nope", out _));
    }

    [Theory]
    [InlineData("anthropic/claude-haiku-5.5", true)]
    [InlineData("mock/planner", true)]
    [InlineData("", false)]
    [InlineData("has space", false)]
    public void ModelIdsStayPlain(string id, bool ok)
    {
        Assert.Equal(ok, PlatformModel.ValidId(id));
        Assert.Equal("Claude Haiku 5.5", PlatformModel.DefaultLabel);
    }

    [Fact]
    public void AccountFieldsRejectSecretsAndHugeAvatars()
    {
        Assert.True(AccountInput.ValidEmail("ada@example.com"));
        Assert.False(AccountInput.ValidEmail("ada"));
        Assert.True(AccountInput.ValidDisplayName("Ada"));
        Assert.False(AccountInput.ValidDisplayName(" "));
        Assert.True(AccountInput.ValidPassword("long-enough"));
        Assert.False(AccountInput.ValidPassword("short"));
        Assert.True(AccountInput.ValidAvatar(""));
        Assert.True(AccountInput.ValidAvatar("https://cdn.example.com/a.png"));
        Assert.False(AccountInput.ValidAvatar("javascript:alert(1)"));
        Assert.True(AccountInput.ValidAvatar("data:image/png;base64,aaaa"));
        Assert.False(AccountInput.ValidAvatar("data:image/png;base64," + new string('a', 200_000)));
    }

    [Fact]
    public void OnlyOwnerCannotLeaveTheAccountEmpty()
    {
        Assert.False(AccountInput.CanDelete("owner", 1));
        Assert.True(AccountInput.CanDelete("owner", 2));
        Assert.True(AccountInput.CanDelete("member", 1));
    }

    [Fact]
    public void SignInConnectsMockMethodsOnly()
    {
        Assert.True(SignInMethods.CanConnect("google"));
        Assert.True(SignInMethods.CanConnect("GitHub"));
        Assert.False(SignInMethods.CanConnect("password"));
        Assert.False(SignInMethods.CanConnect("saml"));
    }

    [Fact]
    public void UserSearchMatchesNameEmailOrUsername()
    {
        Assert.True(AccountSearch.Matches("  ", "saad", "Saad", "saad@example.com"));
        Assert.True(AccountSearch.Matches("SAAD@", "saad", "Owner", "saad@example.com"));
        Assert.False(AccountSearch.Matches("missing", "saad", "Owner", "saad@example.com"));
    }

    [Fact]
    public void HelpAndLegalStayMarked()
    {
        Assert.Contains(HelpContent.Faq, item => item.Answer.Contains("monthly credit grant", StringComparison.Ordinal));
        Assert.Contains(HelpContent.Docs, item => item.Href == "/docs/COMPANION.md");
        Assert.StartsWith("PLACEHOLDER", LegalContent.Banner);
        Assert.Contains("PLACEHOLDER", LegalContent.Terms.Body);
        Assert.Contains("PLACEHOLDER", LegalContent.Privacy.Body);
        Assert.NotEmpty(ChangelogContent.Entries);
        Assert.DoesNotContain(HelpContent.Faq, item => item.Answer.Contains("mock", StringComparison.OrdinalIgnoreCase));
        foreach (var word in new[] { "Haiku", "Claude", "Anthropic", "OpenRouter", "GPT" })
        {
            Assert.DoesNotContain(HelpContent.Faq, item => item.Question.Contains(word, StringComparison.OrdinalIgnoreCase) || item.Answer.Contains(word, StringComparison.OrdinalIgnoreCase));
            Assert.DoesNotContain(word, LegalContent.Terms.Body, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain(word, LegalContent.Privacy.Body, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain(ChangelogContent.Entries, item => item.Title.Contains(word, StringComparison.OrdinalIgnoreCase) || item.Body.Contains(word, StringComparison.OrdinalIgnoreCase));
            Assert.DoesNotContain(word, TaskErrors.Describe("no_openrouter_key").Text, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain(word, TaskErrors.Describe("provider_error").Text, StringComparison.OrdinalIgnoreCase);
        }
        Assert.Equal(new DateTime(2026, 11, 1, 0, 0, 0, DateTimeKind.Utc), BillingMath.RenewsAt(new DateTime(2026, 10, 15, 0, 0, 0, DateTimeKind.Utc)));
        Assert.Contains("Usage history", PlanCatalog.Find("pro")!.Features);
    }

    [Fact]
    public void UptimeMathDoesNotInventAGreenDay()
    {
        Assert.Equal("nodata", UptimeMath.DayState(0, 0, 0));
        Assert.Null(UptimeMath.UptimePercent(0, 0, 0));
        Assert.Equal("up", UptimeMath.DayState(10, 0, 0));
        Assert.Equal("degraded", UptimeMath.DayState(10, 1, 0));
        Assert.Equal("down", UptimeMath.DayState(1, 0, 9));
        Assert.Equal(90d, UptimeMath.UptimePercent(9, 0, 1));
        Assert.Equal(("empty", "No data yet"), UptimeMath.Banner(["nodata", "nodata"]));
        Assert.Equal(("none", "All systems operational"), UptimeMath.Banner(["up", "nodata"]));
        Assert.Equal(("minor", "Degraded"), UptimeMath.Banner(["up", "degraded"]));
        Assert.Equal(("major", "Outage"), UptimeMath.Banner(["up", "down"]));
        var board = UptimeBoard.Build([], new Dictionary<string, string>(), []);
        var json = System.Text.Json.JsonSerializer.Serialize(board);
        Assert.Contains("No data yet", json, StringComparison.Ordinal);
        Assert.Contains("\"state\":\"nodata\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("Haiku", json, StringComparison.OrdinalIgnoreCase);
    }
}
