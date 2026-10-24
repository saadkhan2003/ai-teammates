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

    [Fact]
    public void SignsDirectoryBodyAndBindsDigestAndSignatureAgent()
    {
        using var key = WebBotAuthKey.Generate();
        var body = "{\"keys\":[]}"u8.ToArray();
        const string agent = "https://bot.example/.well-known/http-message-signatures-directory";
        var signed = WebBotAuth.SignDirectoryResponse("bot.example", "application/json", body, agent, key, DateTimeOffset.FromUnixTimeSeconds(1_800_000_000));
        Assert.Contains("@status", signed.SignatureInput, StringComparison.Ordinal);
        Assert.Contains("expires=1800000120", signed.SignatureInput, StringComparison.Ordinal);
        Assert.Equal("\"" + agent + "\"", signed.SignatureAgent);
        Assert.Equal("sha-256=:" + Convert.ToBase64String(System.Security.Cryptography.SHA256.HashData(body)) + ":", signed.ContentDigest);
        var signature = Convert.FromBase64String(signed.Signature[6..^1]);
        var parameters = signed.SignatureInput[5..];
        var signatureBase = System.Text.Encoding.UTF8.GetBytes($"\"@status\": 200\n\"content-type\": application/json\n\"content-digest\": {signed.ContentDigest}\n\"signature-agent\": {signed.SignatureAgent}\n\"@signature-params\": {parameters}");
        var publicKey = NSec.Cryptography.PublicKey.Import(NSec.Cryptography.SignatureAlgorithm.Ed25519, key.PublicKey, NSec.Cryptography.KeyBlobFormat.RawPublicKey);
        Assert.True(NSec.Cryptography.SignatureAlgorithm.Ed25519.Verify(publicKey, signatureBase, signature));
        Assert.False(NSec.Cryptography.SignatureAlgorithm.Ed25519.Verify(publicKey, signatureBase.Concat(new byte[] { 1 }).ToArray(), signature));
    }

    [Fact]
    public void RejectsSignatureAgentStructuredFieldInjection()
    {
        using var key = WebBotAuthKey.Generate();
        Assert.Throws<ArgumentException>(() => WebBotAuth.SignRequest("example.test", "https://bot.example/\"\r\nX-Evil: yes", key));
    }
}
