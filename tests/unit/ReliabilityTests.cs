using System.Text.Json;
using Teammates.Api;
namespace Teammates.UnitTests;

public class ReliabilityTests
{
    [Theory]
    [InlineData("waiting_resource", "connect_openrouter", true)]
    [InlineData("waiting_resource", "computer_recovering", false)]
    [InlineData("failed", "connect_openrouter", false)]
    public void OnlyKeyWaitersResume(string status, string reason, bool expected) =>
        Assert.Equal(expected, Reliability.WaitsForKey(status, reason));

    [Theory]
    [InlineData("connect_openrouter", "no_openrouter_key", "Settings > Vault")]
    [InlineData("provider_error", "provider_error", "rejected")]
    [InlineData("Traceback: secret sensitive exception", "worker_error", "could not finish")]
    public void ErrorsAreReadableAndDoNotEchoDetails(string input, string code, string text)
    {
        var error = TaskErrors.Describe(input);
        Assert.Equal(code, error.Code);
        Assert.Contains(text, error.Text);
        Assert.DoesNotContain("Traceback", error.Text);
        Assert.DoesNotContain("sensitive", error.Text);
    }

    [Fact]
    public void BrowserConsentIsPerRunAndPerOrigin()
    {
        using var doc = JsonDocument.Parse("""{"url":"https://example.com/a"}""");
        var seenThisRun = new HashSet<string> { "https://example.com" };
        Assert.Equal(PolicyEngine.Allow, PolicyEngine.Decide("browser_open", doc.RootElement, seenThisRun));
        Assert.Equal(PolicyEngine.Ask, PolicyEngine.Decide("browser_open", doc.RootElement, new HashSet<string>()));
        using var port = JsonDocument.Parse("""{"url":"https://example.com:8443/a"}""");
        Assert.Equal(PolicyEngine.Ask, PolicyEngine.Decide("browser_open", port.RootElement, seenThisRun));
        using var scheme = JsonDocument.Parse("""{"url":"http://example.com/a"}""");
        Assert.Equal(PolicyEngine.Ask, PolicyEngine.Decide("browser_open", scheme.RootElement, seenThisRun));
    }

    [Theory]
    [InlineData("{\"status\":503,\"retrySafe\":true}", true)]
    [InlineData("{\"status\":503,\"retrySafe\":false}", false)]
    [InlineData("{\"status\":400,\"retrySafe\":true}", false)]
    public void OnlyConfirmedIdempotentTransientCallsCanRetry(string json, bool expected)
    {
        using var doc = JsonDocument.Parse(json);
        Assert.Equal(expected, RetryContract.CanRetry(doc.RootElement));
    }
}
