using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using NSec.Cryptography;

namespace Teammates.Api;

/// <summary>In-memory view of one tenant's Ed25519 key. Persist PrivateKey only via the encrypted secret store.</summary>
public sealed class WebBotAuthKey : IDisposable
{
    private readonly Key _key;
    public byte[] PublicKey => _key.PublicKey.Export(KeyBlobFormat.RawPublicKey);
    public string KeyId => WebBotAuth.Thumbprint(PublicKey);

    private WebBotAuthKey(Key key) => _key = key;

    public static WebBotAuthKey Generate() => new(Key.Create(SignatureAlgorithm.Ed25519, new KeyCreationParameters
    {
        ExportPolicy = KeyExportPolicies.AllowPlaintextExport
    }));

    public static WebBotAuthKey Import(byte[] rawPrivateKey)
    {
        if (rawPrivateKey is null || rawPrivateKey.Length != 32) throw new ArgumentException("invalid Web Bot Auth private key", nameof(rawPrivateKey));
        return new WebBotAuthKey(Key.Import(SignatureAlgorithm.Ed25519, rawPrivateKey, KeyBlobFormat.RawPrivateKey));
    }

    internal byte[] Sign(byte[] message) => SignatureAlgorithm.Ed25519.Sign(_key, message);
    internal byte[] ExportPrivateKey() => _key.Export(KeyBlobFormat.RawPrivateKey);
    public void Dispose() => _key.Dispose();
}

public sealed record WebBotAuthHeaders(string SignatureAgent, string SignatureInput, string Signature);

/// <summary>RFC 9421 profile used by Web Bot Auth. Header lifetime is capped at 120 seconds.</summary>
public static class WebBotAuth
{
    public const int MaxLifetimeSeconds = 120;

    public static async Task<WebBotAuthKey> GetOrCreateTenantKeyAsync(Platform platform, Guid tenant, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(platform);
        if (tenant == Guid.Empty) throw new ArgumentException("tenant is required", nameof(tenant));
        await using var connection = await platform.Data.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await connection.ExecuteAsync(
            "SELECT pg_advisory_xact_lock(hashtextextended(@key, 0))",
            new { key = "web-bot-auth:" + tenant.ToString("N") }, transaction);
        var row = await connection.QuerySingleOrDefaultAsync<(Guid Id, int KeyVersion, byte[] Ciphertext, byte[] Nonce, bool Revoked)>(
            "SELECT id, key_version, ciphertext, nonce, revoked_at IS NOT NULL AS revoked FROM secrets WHERE owner_user_id=@tenant AND provider='web_bot_auth' AND name='ed25519' AND scope='USER'",
            new { tenant }, transaction);
        if (row.Id != Guid.Empty && !row.Revoked)
        {
            var raw = KeyEncryption.Decrypt(platform.MasterKey, row.Id, tenant, "GENERIC", row.KeyVersion, row.Ciphertext, row.Nonce);
            try
            {
                var key = WebBotAuthKey.Import(raw);
                await transaction.CommitAsync(cancellationToken);
                return key;
            }
            finally
            {
                CryptographicOperations.ZeroMemory(raw);
            }
        }

        var generated = WebBotAuthKey.Generate();
        var privateBytes = generated.ExportPrivateKey();
        var id = row.Id == Guid.Empty ? Guid.NewGuid() : row.Id;
        var eventName = row.Id == Guid.Empty ? "secret.created" : "secret.rotated";
        try
        {
            var (ciphertext, nonce) = KeyEncryption.Encrypt(platform.MasterKey, id, tenant, "GENERIC", KeyEncryption.KeyVersion, privateBytes);
            if (row.Id == Guid.Empty)
            {
                await connection.ExecuteAsync(
                    """
                    INSERT INTO secrets (id, owner_user_id, name, provider, description, type, scope, ciphertext, nonce, key_version, masked_suffix, allowed_tools, allowed_domains, allowed_bot_ids, validation_status)
                    VALUES (@id, @tenant, 'ed25519', 'web_bot_auth', 'Web Bot Auth signing key', 'GENERIC', 'USER', @ciphertext, @nonce, @version, NULL, ARRAY['web_bot_auth_internal']::text[], ARRAY[]::text[], NULL, 'valid')
                    """,
                    new { id, tenant, ciphertext, nonce, version = KeyEncryption.KeyVersion }, transaction);
            }
            else
            {
                await connection.ExecuteAsync(
                    "UPDATE secrets SET ciphertext=@ciphertext, nonce=@nonce, key_version=@version, revoked_at=NULL, expires_at=NULL, validation_status='valid', rotated_at=now(), updated_at=now() WHERE id=@id AND owner_user_id=@tenant",
                    new { id, tenant, ciphertext, nonce, version = KeyEncryption.KeyVersion }, transaction);
            }
            await transaction.CommitAsync(cancellationToken);
        }
        catch
        {
            generated.Dispose();
            throw;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(privateBytes);
        }
        await platform.SecretEvent(id, eventName, tenant.ToString(), null, null, null, null, "allow", null);
        return generated;
    }

    public static WebBotAuthHeaders SignRequest(string authority, string signatureAgent, WebBotAuthKey key, DateTimeOffset? timestamp = null)
    {
        if (!ValidAuthority(authority)) throw new ArgumentException("invalid authority", nameof(authority));
        if (!Uri.TryCreate(signatureAgent, UriKind.Absolute, out var agentUri) || agentUri.Scheme != Uri.UriSchemeHttps || agentUri.UserInfo.Length != 0 || agentUri.Fragment.Length != 0 || signatureAgent.Length > 512)
            throw new ArgumentException("Signature-Agent must be an HTTPS URI", nameof(signatureAgent));
        ArgumentNullException.ThrowIfNull(key);
        var created = (timestamp ?? DateTimeOffset.UtcNow).ToUnixTimeSeconds();
        var expires = checked(created + MaxLifetimeSeconds);
        var keyId = key.KeyId;
        var input = $"sig1=(\"@authority\" \"signature-agent\");created={created};expires={expires};keyid=\"{keyId}\";tag=\"web-bot-auth\"";
        var agent = $"\"{signatureAgent}\"";
        var signature = key.Sign(SignatureBase(authority, agent, created, expires, keyId));
        return new WebBotAuthHeaders(agent, input, $"sig1=:{Convert.ToBase64String(signature)}:");
    }

    public static bool VerifyRequest(string authority, WebBotAuthHeaders headers, byte[] publicKey, DateTimeOffset? timestamp = null)
    {
        if (!ValidAuthority(authority) || publicKey is null || publicKey.Length != 32 || headers is null) return false;
        try
        {
            if (headers.SignatureAgent.Length > 514 || !headers.SignatureAgent.StartsWith("\"https://", StringComparison.Ordinal) || !headers.SignatureAgent.EndsWith('"')) return false;
            var fields = ParseSignatureInput(headers.SignatureInput);
            if (fields == null) return false;
            var now = (timestamp ?? DateTimeOffset.UtcNow).ToUnixTimeSeconds();
            if (fields.Value.Expires - fields.Value.Created is < 0 or > MaxLifetimeSeconds || fields.Value.Created > now + 30 || fields.Value.Created < now - 180 || fields.Value.Expires < now) return false;
            var sigText = headers.Signature;
            if (!sigText.StartsWith("sig1=:", StringComparison.Ordinal) || !sigText.EndsWith(':') || sigText.Length > 256) return false;
            var signature = Convert.FromBase64String(sigText[6..^1]);
            var imported = PublicKey.Import(SignatureAlgorithm.Ed25519, publicKey, KeyBlobFormat.RawPublicKey);
            var message = SignatureBase(authority, headers.SignatureAgent, fields.Value.Created, fields.Value.Expires, fields.Value.KeyId);
            return SignatureAlgorithm.Ed25519.Verify(imported, message, signature);
        }
        catch (Exception ex) when (ex is ArgumentException or FormatException or CryptographicException)
        {
            return false;
        }
    }

    public static string DirectoryJwks(WebBotAuthKey key)
    {
        ArgumentNullException.ThrowIfNull(key);
        var jwk = JsonSerializer.Serialize(new
        {
            kty = "OKP",
            crv = "Ed25519",
            x = Base64Url(key.PublicKey),
            kid = key.KeyId,
            use = "sig",
            alg = "EdDSA"
        });
        return "{\"keys\":[" + jwk + "]}";
    }

    public static string Thumbprint(byte[] publicKey)
    {
        if (publicKey.Length != 32) throw new ArgumentException("invalid Ed25519 public key", nameof(publicKey));
        var canonical = "{\"crv\":\"Ed25519\",\"kty\":\"OKP\",\"x\":\"" + Base64Url(publicKey) + "\"}";
        return Base64Url(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)));
    }

    private static byte[] SignatureBase(string authority, string signatureAgent, long created, long expires, string keyId)
    {
        var parameters = $"(\"@authority\" \"signature-agent\");created={created};expires={expires};keyid=\"{keyId}\";tag=\"web-bot-auth\"";
        return Encoding.UTF8.GetBytes($"\"@authority\": {authority.ToLowerInvariant()}\n\"signature-agent\": {signatureAgent}\n\"@signature-params\": {parameters}");
    }

    private static (long Created, long Expires, string KeyId)? ParseSignatureInput(string? input)
    {
        if (input is null || input.Length > 512) return null;
        const string prefix = "sig1=(\"@authority\" \"signature-agent\");created=";
        if (!input.StartsWith(prefix, StringComparison.Ordinal) || !input.EndsWith(";tag=\"web-bot-auth\"", StringComparison.Ordinal)) return null;
        var remaining = input[prefix.Length..^";tag=\"web-bot-auth\"".Length];
        var sections = remaining.Split(";expires=", StringSplitOptions.None);
        if (sections.Length != 2 || !long.TryParse(sections[0], out var created)) return null;
        var keySections = sections[1].Split(";keyid=\"", StringSplitOptions.None);
        if (keySections.Length != 2 || !keySections[1].EndsWith('"') || keySections[1].Length > 130 || !long.TryParse(keySections[0], out var expires)) return null;
        var keyId = keySections[1][..^1];
        if (keyId.Length is < 1 or > 128 || keyId.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('-' or '_'))) return null;
        return (created, expires, keyId);
    }

    private static bool ValidAuthority(string authority) => authority.Length is > 0 and <= 253 && !authority.Any(char.IsWhiteSpace) && !authority.Contains('/') && !authority.Contains('@');

    private static string Base64Url(byte[] value) => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
