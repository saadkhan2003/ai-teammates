using System.Text.Json;
using Teammates.Api;
using Xunit;

public sealed class WidgetsTests
{
    [Fact]
    public void ValidatesVersionTypeAndImageScheme()
    {
        using var valid = JsonDocument.Parse("""{"version":1,"id":"photo","type":"image-grid","images":[{"url":"https://example.com/a.png","alt":"A"}]}""");
        Assert.Null(WidgetSchema.Validate(valid.RootElement));
        using var invalid = JsonDocument.Parse("""{"version":1,"id":"photo","type":"image-grid","images":[{"url":"javascript:alert(1)","alt":"A"}]}""");
        Assert.Equal("unsafe_image_url", WidgetSchema.Validate(invalid.RootElement));
        using var version = JsonDocument.Parse("""{"version":2,"id":"w","type":"card"}""");
        Assert.Equal("unsupported_widget_version", WidgetSchema.Validate(version.RootElement));
    }

    [Fact]
    public void EnforcesWidgetPayloadSizeAndDepth()
    {
        using var large = JsonDocument.Parse("""{"version":1,"id":"c","type":"code","language":"txt","code":""" + new string('x', 48_000) + """""}");
        Assert.Equal("widget_too_large", WidgetSchema.Validate(large.RootElement));
        using var deep = JsonDocument.Parse("""{"version":1,"id":"w","type":"card","x":{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":{}}}}}}}}}}""");
        Assert.Equal("widget_too_deep", WidgetSchema.Validate(deep.RootElement));
    }
}
