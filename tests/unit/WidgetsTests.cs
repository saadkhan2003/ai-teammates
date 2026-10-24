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
    public void DeclaredActionsAreTheOnlyAcceptedAndCanRequireApproval()
    {
        using var widget = JsonDocument.Parse("""{"version":1,"id":"w","type":"buttons","actions":[{"id":"safe","label":"Continue","action":"continue"},{"id":"danger","label":"Delete","action":"delete","requires_approval":true}]}""");
        Assert.False(WidgetRoutes.TryFindAction(widget.RootElement, "unknown", out _));
        Assert.True(WidgetRoutes.TryFindAction(widget.RootElement, "delete", out var action));
        Assert.True(WidgetRoutes.RequiresApproval(action));
        Assert.True(WidgetRoutes.TryFindAction(widget.RootElement, "continue", out action));
        Assert.False(WidgetRoutes.RequiresApproval(action));
    }

    [Fact]
    public void ValidatesButtonPayloadAndTypedFormFields()
    {
        using var buttons = JsonDocument.Parse("""{"version":1,"id":"w","type":"buttons","actions":[{"id":"go","label":"Go","action":"go","payload":{"scope":"today"}}]}""");
        Assert.True(WidgetRoutes.TryFindAction(buttons.RootElement, "go", out var button));
        using var ok = JsonDocument.Parse("""{"scope":"today"}""");
        using var tampered = JsonDocument.Parse("""{"scope":"all"}""");
        Assert.True(WidgetRoutes.TryValidateActionPayload(buttons.RootElement, button, ok.RootElement, out _));
        Assert.False(WidgetRoutes.TryValidateActionPayload(buttons.RootElement, button, tampered.RootElement, out _));

        using var form = JsonDocument.Parse("""{"version":1,"id":"f","type":"form","fields":[{"name":"email","label":"Email","type":"email","required":true}],"submit":{"id":"send","label":"Send","action":"send"}}""");
        var submit = form.RootElement.GetProperty("submit");
        using var formOk = JsonDocument.Parse("""{"values":{"email":"person@example.test"}}""");
        using var formBad = JsonDocument.Parse("""{"values":{"email":"bad address"}}""");
        Assert.True(WidgetRoutes.TryValidateActionPayload(form.RootElement, submit, formOk.RootElement, out _));
        Assert.False(WidgetRoutes.TryValidateActionPayload(form.RootElement, submit, formBad.RootElement, out _));
    }

    [Fact]
    public void EnforcesWidgetPayloadSizeAndDepth()
    {
        using var large = JsonDocument.Parse(JsonSerializer.Serialize(new { version = 1, id = "c", type = "code", language = "txt", code = new string('x', 48_000) }));
        Assert.Equal("widget_too_large", WidgetSchema.Validate(large.RootElement));
        using var deep = JsonDocument.Parse("""{"version":1,"id":"w","type":"card","x":{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":{}}}}}}}}}}""");
        Assert.Equal("widget_too_deep", WidgetSchema.Validate(deep.RootElement));
    }
}
