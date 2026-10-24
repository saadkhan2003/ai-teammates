namespace Teammates.UnitTests;

public class ThemeChoiceTests
{
    [Theory]
    [InlineData("light")]
    [InlineData("dark")]
    [InlineData("system")]
    public void AcceptsTheThreeModes(string value)
    {
        Assert.Equal(value, Teammates.Api.ThemeChoice.Normalize(value));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("Follow system")]
    [InlineData("auto")]
    public void RejectsAnythingElse(string? value)
    {
        Assert.Null(Teammates.Api.ThemeChoice.Normalize(value));
    }

    [Fact]
    public void DefaultsToSystem()
    {
        Assert.Equal("system", Teammates.Api.ThemeChoice.Default);
    }
}
