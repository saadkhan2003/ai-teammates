using Teammates.Api;

namespace Teammates.UnitTests;

public sealed class LoginLimitTests
{
    [Fact]
    public void Production_blocks_at_thirty_attempts_in_ten_minutes()
    {
        Assert.Equal((30, 8), LoginRateLimiter.LimitsFor(false));
        Assert.Equal(TimeSpan.FromMinutes(10), LoginRateLimiter.Window);
        var limiter = new LoginRateLimiter();
        var now = DateTimeOffset.UtcNow;
        for (var i = 0; i < 29; i++) limiter.NoteAttempt("ip", now);
        Assert.False(limiter.IsBlocked("ip", now));
        limiter.NoteAttempt("ip", now);
        Assert.True(limiter.IsBlocked("ip", now));
        Assert.False(limiter.IsBlocked("ip", now.AddMinutes(11)));
    }

    [Fact]
    public void Only_test_hooks_relax_attempts_and_failures()
    {
        var test = new LoginRateLimiter(testHooks: true);
        var now = DateTimeOffset.UtcNow;
        for (var i = 0; i < 100; i++) { test.NoteAttempt("ip", now); test.NoteFailure("ip", now); }
        Assert.False(test.IsBlocked("ip", now));
        for (var i = 100; i < LoginRateLimiter.LimitsFor(true).Failures; i++) test.NoteFailure("ip", now);
        Assert.True(test.IsBlocked("ip", now));
        var platform = File.ReadAllText(Path.Combine(MigrationManifestTests.Root(), "apps/api/Platform.cs"));
        Assert.Contains("LoginRateLimiter.LimitsFor(TestHooks)", platform);
        Assert.Contains("config[\"ENABLE_TEST_HOOKS\"], \"true\"", platform);
    }
}
