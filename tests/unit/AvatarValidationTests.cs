using System.Text.RegularExpressions;

namespace Teammates.UnitTests;

public sealed class AvatarValidationTests
{
    [Theory]
    [InlineData("blob1", true)]
    [InlineData("blob9", true)]
    [InlineData("blob10", true)]
    [InlineData("blob15", true)]
    [InlineData("blob0", false)]
    [InlineData("blob16", false)]
    [InlineData("blobx", false)]
    public void ShapeMustBeOneOfThePickerIds(string shape, bool expected) =>
        Assert.Equal(expected, Regex.IsMatch(shape, @"^blob(1[0-5]|[1-9])$"));

    [Theory]
    [InlineData("#abcdef", true)]
    [InlineData("#ABCDEF", true)]
    [InlineData("#abc", false)]
    [InlineData("red", false)]
    public void ColorMustBeHexToken(string color, bool expected) =>
        Assert.Equal(expected, Regex.IsMatch(color, @"^#[0-9a-fA-F]{6}$"));
}
