using System.Text.Json;
using Teammates.Api;
namespace Teammates.UnitTests;

public class ReliabilityTests
{
    [Fact]
    public void ResumePolicyBoundsRetriesAndExcludesHumanStates()
    {
        Assert.Equal(2, Reliability.BackoffSeconds(0));
        Assert.Equal(2, Reliability.BackoffSeconds(1));
        Assert.Equal(4, Reliability.BackoffSeconds(2));
        Assert.Equal(60, Reliability.BackoffSeconds(20));
        Assert.True(Reliability.IsExcluded("waiting_approval"));
        Assert.True(Reliability.IsExcluded("waiting_human"));
        Assert.True(Reliability.IsExcluded("cancelled"));
        Assert.False(Reliability.IsExcluded("queued"));
        Assert.True(Reliability.IsAutoResumeReason("lease_expired"));
        Assert.False(Reliability.IsAutoResumeReason("waiting_approval"));
    }

    [Fact]
    public void ResumeWindowAndNoProgressBreakerUseRecentAutoAttemptsOnly()
    {
        var now = DateTimeOffset.UtcNow;
        var ledger = System.Text.Json.Nodes.JsonNode.Parse("""
            [{"endedAt":"2026-10-24T09:30:00Z","endReason":"lease_expired","progress":false},
             {"endedAt":"2026-10-24T09:40:00Z","endReason":"lease_expired","progress":false},
             {"endedAt":"2026-10-24T07:00:00Z","endReason":"lease_expired","progress":false}]
            """)!.AsArray();
        var adjusted = new System.Text.Json.Nodes.JsonArray(
            new System.Text.Json.Nodes.JsonObject { ["endedAt"] = now.AddMinutes(-10).ToString("O"), ["endReason"] = "lease_expired", ["progress"] = false },
            new System.Text.Json.Nodes.JsonObject { ["endedAt"] = now.AddMinutes(-5).ToString("O"), ["endReason"] = "network_interrupted", ["progress"] = false },
            new System.Text.Json.Nodes.JsonObject { ["endedAt"] = now.AddMinutes(-2).ToString("O"), ["endReason"] = "lease_expired", ["progress"] = true });
        Assert.Equal(3, Reliability.RecentAutoResumes(adjusted, now));
        Assert.Equal(0, Reliability.ConsecutiveNoProgress(adjusted));
        Assert.Equal(3, Reliability.ConsecutiveNoProgress(ledger));
    }

    [Fact]
    public void CheckpointLedgerIsCappedAndContainsOnlyBoundedMetadata()
    {
        var ledger = TaskCheckpoint.Read(null);
        ledger["stepsUsed"] = 12;
        ledger["lastToolCallId"] = new string('x', 100);
        var attempts = new System.Text.Json.Nodes.JsonArray();
        for (var i = 0; i < 200; i++) attempts.Add(new System.Text.Json.Nodes.JsonObject { ["n"] = i, ["endReason"] = "lease_expired", ["progress"] = false });
        ledger["attempts"] = attempts;
        var bounded = TaskCheckpoint.Bounded(ledger);
        Assert.True(System.Text.Encoding.UTF8.GetByteCount(bounded) <= TaskCheckpoint.MaxBytes);
        Assert.DoesNotContain("tool output", bounded, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void CodingWorkPoliciesHaveExpectedBoundaries()
    {
        Assert.Equal(200, RunBudget.Resolve(null,null,null,null).MaxSteps);
        Assert.Equal(3600, RunBudget.Resolve(null,null,null,null).MaxSeconds);
        Assert.Equal(4, RunBudget.Resolve(1,1,null,null).MaxSteps);
        Assert.Equal(21600, RunBudget.Resolve(null,99999,null,null).MaxSeconds);
        Assert.Equal(StallDecision.Nudge, StallPolicy.Decide(TimeSpan.FromMinutes(5),0,TimeSpan.FromMinutes(5)));
        Assert.Equal(StallDecision.Block, StallPolicy.Decide(TimeSpan.FromMinutes(10),1,TimeSpan.FromMinutes(5)));
        Assert.False(TestGate.Check(true,null,false));
        Assert.True(TestGate.Check(true,null,true));
        Assert.True(TestGate.Check(false,null,false));
        Assert.NotNull(DurationEstimate.Range([60,120,180,300]));
        Assert.Null(DurationEstimate.Range([60,120]));
        Assert.Equal("passing", CiSummary.From("""[{"name":"unit","state":"SUCCESS","link":"x"}]""").State);
    }
    [Theory]
    [InlineData("waiting_resource", "connect_openrouter", true)]
    [InlineData("waiting_resource", "computer_recovering", false)]
    [InlineData("failed", "connect_openrouter", false)]
    public void OnlyKeyWaitersResume(string status, string reason, bool expected) =>
        Assert.Equal(expected, Reliability.WaitsForKey(status, reason));

    [Theory]
    [InlineData("connect_openrouter", "no_openrouter_key", "Settings > Vault")]
    [InlineData("provider_error", "provider_error", "provider")]
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
