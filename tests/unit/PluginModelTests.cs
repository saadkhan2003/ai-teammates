namespace Teammates.UnitTests;

public class PluginModelTests
{
    [Theory]
    [InlineData("CONNECTOR", "PLUGIN_CREDENTIAL")]
    [InlineData("CONNECTOR_CREDENTIAL", "PLUGIN_CREDENTIAL")]
    [InlineData("connector credentials", "PLUGIN_CREDENTIAL")]
    [InlineData("OAUTH_CREDENTIAL", "PLUGIN_CREDENTIAL")]
    [InlineData("OAuth-Credentials", "PLUGIN_CREDENTIAL")]
    [InlineData("PLUGIN", "PLUGIN_CREDENTIAL")]
    [InlineData("PLUGIN_CREDENTIALS", "PLUGIN_CREDENTIAL")]
    [InlineData("oauth", "PLUGIN_CREDENTIAL")]
    [InlineData("API_KEY", "API_KEY")]
    [InlineData("OAUTH_REFRESH_TOKEN", "OAUTH_REFRESH_TOKEN")]
    [InlineData("PASSWORD", "PASSWORD")]
    [InlineData("", "GENERIC")]
    [InlineData(null, "GENERIC")]
    public void SecretAliasesCollapseToPluginCredential(string? input, string expected)
    {
        Assert.Equal(expected, Teammates.Api.PluginModel.NormalizeSecretType(input));
    }

    [Theory]
    [InlineData("http", "openapi")]
    [InlineData("REST", "openapi")]
    [InlineData("stdio", "mcp")]
    [InlineData("streamable-http", "mcp")]
    [InlineData("sse", "mcp")]
    [InlineData("built-in", "builtin")]
    [InlineData("oauth2", "oauth")]
    [InlineData(null, "openapi")]
    public void PluginKindsShareOneVocabulary(string? input, string expected)
    {
        Assert.Equal(expected, Teammates.Api.PluginModel.NormalizePluginKind(input));
    }
}
