using Teammates.Api;

namespace Teammates.UnitTests;

public class WebBotAuthTests
{
    [Fact]
    public void SignsRfc9421ProfileWithEd25519AndVerifiesWithinTwoMinutes()
    {
        using var key = WebBotAuthKey.Generate();
        var now = DateTimeOffset.FromUnixTimeSeconds(1_800_000_000);
        var signed = WebBotAuth.SignRequest("example.test", "https://bot.example/", key, now);

        Assert.Contains("tag=\"web-bot-auth\"", signed.SignatureInput, StringComparison.Ordinal);
        Assert.Contains("expires=1800000120", signed.SignatureInput, StringComparison.Ordinal);
        Assert.True(WebBotAuth.VerifyRequest("example.test", signed, key.PublicKey, now));
        var forged = signed with { Signature = "sig1=:Zm9yZ2Vk:" };
        Assert.False(WebBotAuth.VerifyRequest("example.test", forged, key.PublicKey, now));
        Assert.False(WebBotAuth.VerifyRequest("example.test", signed, key.PublicKey, now.AddMinutes(3)));
    }

    [Fact]
    public void PublishesPublicJwkWithoutPrivateMaterial()
    {
        using var key = WebBotAuthKey.Generate();
        var jwks = WebBotAuth.DirectoryJwks(key);
        Assert.Contains("\"kty\":\"OKP\"", jwks, StringComparison.Ordinal);
        Assert.Contains("\"crv\":\"Ed25519\"", jwks, StringComparison.Ordinal);
        Assert.DoesNotContain("\"d\"", jwks, StringComparison.Ordinal);
    }
}
