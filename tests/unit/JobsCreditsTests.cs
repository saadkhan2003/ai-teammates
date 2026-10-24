using System.Text.Json;
using Teammates.Api;

namespace Teammates.UnitTests;

public sealed class JobsCreditsTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 1, 0, 0, 0, TimeSpan.Zero);
    private static JsonElement Empty => JsonDocument.Parse("{}").RootElement.Clone();

    private static CreditSummary Sum(decimal aiUsd = 0, long minutes = 0, decimal gbDaysOver = 0, decimal? limit = null, decimal priorUsd = 0, BillingPlan? plan = null) =>
        Credits.Compute(plan ?? BillingPlan.Standard, CreditRates.Default, new UsageInputs(aiUsd, minutes, 0, gbDaysOver, priorUsd), limit, T0, T0.AddDays(7), T0.AddDays(2.5));

    [Fact]
    public void Everything_converts_to_credits_at_real_cost()
    {
        var s = Sum(aiUsd: 1.5m, minutes: 600, gbDaysOver: 14m);
        Assert.Equal(1500m, s.AiCredits);          // $0.001 = 1 credit
        Assert.Equal(60m, s.ComputerCredits);      // 0.1 credit per awake minute
        Assert.Equal(100m, s.StorageCredits);      // 2 GB over for 7 days at 50/GB-week
        Assert.Equal(1660m, s.UsedCredits);
        Assert.Equal(4500, s.Allowance);
        Assert.Equal(Math.Round(1660m / 4500m * 100m, 1), s.Percent);
        Assert.Equal("ok", s.State);
        Assert.False(s.Paused);
        Assert.Equal(5, s.ResetsInDays);
    }

    [Fact]
    public void At_the_allowance_without_on_demand_heavy_work_pauses_and_the_message_explains_top_up()
    {
        var s = Sum(aiUsd: 4.5m);
        Assert.True(s.Paused);
        Assert.Equal("paused", s.State);
        var message = Credits.PausedMessage(s);
        Assert.Contains("on-demand monthly limit", message);
        Assert.Contains("Usage", message);
        Assert.DoesNotContain("openrouter", message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal("warning", Sum(aiUsd: 3.7m).State);
    }

    [Fact]
    public void On_demand_continues_until_the_monthly_limit_capped_by_the_plan()
    {
        var running = Sum(aiUsd: 5m, limit: 10m);
        Assert.False(running.Paused);
        Assert.Equal("on_demand", running.State);
        Assert.Equal(0.5m, running.OnDemandUsedUsd);
        Assert.True(Sum(aiUsd: 5m, limit: 10m, priorUsd: 9.6m).Paused);
        Assert.Equal(100m, Sum(limit: 5000m).OnDemandLimitUsd);   // clamped to the plan cap
    }

    [Fact]
    public void Weekly_windows_roll_from_the_anchor()
    {
        var (start, end) = Credits.Window(T0, T0.AddDays(15.2));
        Assert.Equal(T0.AddDays(14), start);
        Assert.Equal(T0.AddDays(21), end);
        Assert.Equal(0m, Credits.StorageGbOver(4L * 1_073_741_824, 5m));
        Assert.Equal(1m, Credits.StorageGbOver(6L * 1_073_741_824, 5m));
    }

    [Fact]
    public void Default_standard_plan_keeps_a_heavy_user_profitable()
    {
        // A full week of allowance is $4.50 of real cost; ~4.33 weeks/month ≈ $19.5 < $30 plan price.
        var plan = BillingPlan.Standard;
        Assert.True(plan.WeeklyCredits * CreditRates.Default.UsdPerCredit * 52m / 12m < plan.PriceUsd * 0.7m);
    }

    [Fact]
    public void Job_run_time_uses_plan_default_and_ceiling()
    {
        var plan = BillingPlan.Standard;
        Assert.Equal(3600, JobRules.MaxSeconds(plan, null));
        Assert.Equal(600, JobRules.MaxSeconds(plan, 10));
        Assert.Equal(240 * 60, JobRules.MaxSeconds(plan, 10_000));
        Assert.Equal(30, JobRules.MaxSeconds(plan, 0.01));
    }

    [Fact]
    public void Job_outcomes_from_probes()
    {
        Assert.Null(JobRules.Outcome(new JobProbe(null, true, 10), T0, 60, T0.AddSeconds(30)));
        Assert.Equal(("done", (string?)null), JobRules.Outcome(new JobProbe(0, false, 10), T0, 60, T0.AddSeconds(5)));
        Assert.Equal("failed", JobRules.Outcome(new JobProbe(2, false, 10), T0, 60, T0.AddSeconds(5))!.Value.Status);
        Assert.Equal("timed_out", JobRules.Outcome(new JobProbe(124, false, 10), T0, 60, T0.AddSeconds(61))!.Value.Status);
        Assert.Equal("failed", JobRules.Outcome(new JobProbe(124, false, 10), T0, 600, T0.AddSeconds(5))!.Value.Status);
        Assert.Equal(("failed", (string?)"lost"), JobRules.Outcome(new JobProbe(null, false, 0), T0, 60, T0.AddSeconds(5)));
        Assert.Equal("timed_out", JobRules.Outcome(new JobProbe(null, true, 0), T0, 60, T0.AddSeconds(121))!.Value.Status);
    }

    [Fact]
    public void Job_notices_and_names_are_plain()
    {
        Assert.Equal("1m 5s", JobRules.Elapsed(TimeSpan.FromSeconds(65)));
        Assert.Equal("2h 0m", JobRules.Elapsed(TimeSpan.FromHours(2)));
        Assert.Contains("finished in 5s", JobRules.Notice("scan", "done", TimeSpan.FromSeconds(5), "/r"));
        Assert.Equal("Background job", JobRules.CleanName("\u0001", "\u0002"));
        Assert.Equal(80, JobRules.CleanName(new string('x', 200), "c").Length);
    }

    [Fact]
    public void Job_tools_are_classified_reviewed_and_gated()
    {
        Assert.Equal(ActionClasses.Read, ActionClassifier.Classify("job_status", Empty));
        Assert.Equal(ActionClasses.Read, ActionClassifier.Classify("job_logs", Empty));
        Assert.Equal(ActionClasses.Write, ActionClassifier.Classify("job_start", JsonDocument.Parse("{\"command\":\"python3 a.py\"}").RootElement.Clone()));
        Assert.Equal(ActionClasses.Write, ActionClassifier.Classify("job_cancel", Empty));
        Assert.True(ComputerNeed.Needs("job_start"));
        Assert.True(ComputerNeed.Needs("browser_open"));
        Assert.False(ComputerNeed.Needs("job_status"));
        Assert.False(ComputerNeed.Needs("save_memory"));
        var names = ToolSchema.Builtins().Select(tool => JsonSerializer.SerializeToElement(tool).GetProperty("function").GetProperty("name").GetString()).ToHashSet();
        Assert.Subset(names, new HashSet<string?> { "job_start", "job_status", "job_logs", "job_cancel" });
    }

    [Fact]
    public async Task Risky_job_commands_go_to_review()
    {
        var reviewer = new RuleBasedActionReviewer();
        Assert.Equal("ask", await reviewer.ReviewAsync("job_start", JsonDocument.Parse("{\"command\":\"rm -rf /\"}").RootElement.Clone(), default));
    }

    [Fact]
    public void Routines_and_bot_to_bot_tasks_wake_lazily()
    {
        Assert.True(ComputerNeed.EagerWake("work", null));
        Assert.False(ComputerNeed.EagerWake("work", Guid.NewGuid()));
        Assert.False(ComputerNeed.EagerWake("peer", null));
        Assert.False(ComputerNeed.EagerWake("peer_reply", null));
        Assert.Contains(10m, UsageRoutes.OnDemandOptions(100m));
        Assert.DoesNotContain(200m, UsageRoutes.OnDemandOptions(100m));
    }
}
