using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using Npgsql;

namespace Teammates.Api;

public sealed class SecretField(string kind, byte[] value) : IDisposable
{
    public string Kind { get; } = kind;
    public byte[] Value { get; } = value;

    public void Dispose() => CryptographicOperations.ZeroMemory(Value);
}

public sealed class LoginBroker
{
    private readonly byte[] _key;
    private readonly NpgsqlDataSource? _data;
    private readonly object _gate = new();
    private readonly Dictionary<Guid, Slot> _slots = new();

    public TimeSpan Ttl { get; set; } = TimeSpan.FromMinutes(5);

    public LoginBroker(NpgsqlDataSource? data = null, byte[]? sharedKey = null)
    {
        _data = data;
        _key = sharedKey?.ToArray() ?? RandomNumberGenerator.GetBytes(32);
        if (_key.Length != 32) throw new ArgumentException("Login broker key must be 32 bytes", nameof(sharedKey));
    }

    public async Task HoldAsync(Guid id, IReadOnlyList<SecretField> fields, bool saveToVault)
    {
        if (_data == null) { Hold(id, fields, saveToVault); return; }
        var plain = Pack(fields); var nonce = RandomNumberGenerator.GetBytes(12); var cipher = new byte[plain.Length]; var tag = new byte[16]; byte[]? stored = null;
        try
        {
            using var aes = new AesGcm(_key, 16);
            aes.Encrypt(nonce, plain, cipher, tag, id.ToByteArray());
            stored = new byte[cipher.Length + tag.Length]; Buffer.BlockCopy(cipher, 0, stored, 0, cipher.Length); Buffer.BlockCopy(tag, 0, stored, cipher.Length, tag.Length);
            await using var conn = await _data.OpenConnectionAsync();
            await conn.ExecuteAsync("""
                INSERT INTO login_broker_slots(id,nonce,ciphertext,save_to_vault,created_at) VALUES(@id,@nonce,@stored,@save,clock_timestamp())
                ON CONFLICT(id) DO UPDATE SET nonce=EXCLUDED.nonce,ciphertext=EXCLUDED.ciphertext,save_to_vault=EXCLUDED.save_to_vault,created_at=clock_timestamp()
                """, new { id, nonce, stored, save = saveToVault });
        }
        finally { CryptographicOperations.ZeroMemory(plain); CryptographicOperations.ZeroMemory(cipher); CryptographicOperations.ZeroMemory(tag); if (stored != null) CryptographicOperations.ZeroMemory(stored); }
    }

    public async Task<(List<SecretField>? Fields, bool Save)> TryTakeAsync(Guid id)
    {
        if (_data == null) { var ok = TryTake(id, out var fields, out var save); return (ok ? fields : null, save); }
        await using var conn = await _data.OpenConnectionAsync();
        var row = await conn.QuerySingleOrDefaultAsync<(byte[] Nonce, byte[] Ciphertext, bool Save)>("""
            DELETE FROM login_broker_slots WHERE id=@id AND created_at > clock_timestamp()-@ttl
            RETURNING nonce AS "Nonce",ciphertext AS "Ciphertext",save_to_vault AS "Save"
            """, new { id, ttl = Ttl });
        if (row.Nonce == null)
        {
            await conn.ExecuteAsync("DELETE FROM login_broker_slots WHERE id=@id", new { id });
            return (null, false);
        }
        var plain = new byte[row.Ciphertext.Length - 16];
        try
        {
            using var aes = new AesGcm(_key, 16);
            aes.Decrypt(row.Nonce, row.Ciphertext.AsSpan(0, plain.Length), row.Ciphertext.AsSpan(plain.Length, 16), plain, id.ToByteArray());
            return (Unpack(plain), row.Save);
        }
        catch (CryptographicException) { return (null, false); }
        finally { CryptographicOperations.ZeroMemory(plain); CryptographicOperations.ZeroMemory(row.Nonce); CryptographicOperations.ZeroMemory(row.Ciphertext); }
    }

    public async Task DropAsync(Guid id)
    {
        Drop(id);
        if (_data == null) return;
        await using var conn = await _data.OpenConnectionAsync();
        await conn.ExecuteAsync("DELETE FROM login_broker_slots WHERE id=@id", new { id });
    }

    public async Task<bool> IsHeldAsync(Guid id)
    {
        if (_data == null) return IsHeld(id);
        await using var conn = await _data.OpenConnectionAsync();
        return await conn.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM login_broker_slots WHERE id=@id AND created_at > clock_timestamp()-@ttl)", new { id, ttl = Ttl });
    }

    public void Hold(Guid id, IReadOnlyList<SecretField> fields, bool saveToVault)
    {
        var plain = Pack(fields);
        try
        {
            var nonce = RandomNumberGenerator.GetBytes(12);
            var cipher = new byte[plain.Length];
            var tag = new byte[16];
            using var aes = new AesGcm(_key, 16);
            aes.Encrypt(nonce, plain, cipher, tag);
            var stored = new byte[cipher.Length + tag.Length];
            Buffer.BlockCopy(cipher, 0, stored, 0, cipher.Length);
            Buffer.BlockCopy(tag, 0, stored, cipher.Length, tag.Length);
            CryptographicOperations.ZeroMemory(cipher);
            lock (_gate)
            {
                if (_slots.Remove(id, out var previous)) Zero(previous);
                _slots[id] = new Slot(stored, nonce, DateTimeOffset.UtcNow, saveToVault);
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plain);
        }
    }

    public bool TryTake(Guid id, out List<SecretField>? fields, out bool saveToVault)
    {
        Slot? slot;
        lock (_gate)
        {
            if (!_slots.Remove(id, out slot))
            {
                fields = null;
                saveToVault = false;
                return false;
            }
        }
        if (DateTimeOffset.UtcNow - slot.At > Ttl)
        {
            Zero(slot);
            fields = null;
            saveToVault = false;
            return false;
        }
        byte[] plain;
        try
        {
            plain = Open(slot);
        }
        catch (CryptographicException)
        {
            Zero(slot);
            fields = null;
            saveToVault = false;
            return false;
        }
        try
        {
            fields = Unpack(plain);
            saveToVault = slot.Save;
            return fields != null;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plain);
            Zero(slot);
        }
    }

    public void Drop(Guid id)
    {
        lock (_gate)
        {
            if (_slots.Remove(id, out var slot)) Zero(slot);
        }
    }

    public bool IsHeld(Guid id)
    {
        lock (_gate)
        {
            if (!_slots.TryGetValue(id, out var slot)) return false;
            if (DateTimeOffset.UtcNow - slot.At > Ttl)
            {
                _slots.Remove(id);
                Zero(slot);
                return false;
            }
            return true;
        }
    }

    private byte[] Open(Slot slot)
    {
        var cipher = slot.Cipher;
        var body = cipher.AsSpan(0, cipher.Length - 16);
        var tag = cipher.AsSpan(cipher.Length - 16);
        var plain = new byte[body.Length];
        using var aes = new AesGcm(_key, 16);
        aes.Decrypt(slot.Nonce, body, tag, plain);
        return plain;
    }

    internal static byte[] Pack(IReadOnlyList<SecretField> fields)
    {
        var size = 1;
        foreach (var field in fields)
            size += 1 + Encoding.UTF8.GetByteCount(field.Kind) + 2 + field.Value.Length;
        var buffer = new byte[size];
        var span = buffer.AsSpan();
        span[0] = (byte)fields.Count;
        var offset = 1;
        foreach (var field in fields)
        {
            var kind = Encoding.UTF8.GetBytes(field.Kind);
            span[offset++] = (byte)kind.Length;
            kind.CopyTo(span[offset..]);
            offset += kind.Length;
            span[offset++] = (byte)(field.Value.Length >> 8);
            span[offset++] = (byte)field.Value.Length;
            field.Value.CopyTo(span[offset..]);
            offset += field.Value.Length;
            CryptographicOperations.ZeroMemory(kind);
        }
        return buffer;
    }

    internal static List<SecretField>? Unpack(ReadOnlySpan<byte> plain)
    {
        if (plain.Length < 1) return null;
        var count = plain[0];
        var fields = new List<SecretField>(count);
        var offset = 1;
        for (var i = 0; i < count; i++)
        {
            if (offset >= plain.Length) return null;
            var kindLength = plain[offset++];
            if (offset + kindLength + 2 > plain.Length) return null;
            var kind = Encoding.UTF8.GetString(plain.Slice(offset, kindLength));
            offset += kindLength;
            var valueLength = (plain[offset] << 8) | plain[offset + 1];
            offset += 2;
            if (offset + valueLength > plain.Length) return null;
            var value = plain.Slice(offset, valueLength).ToArray();
            offset += valueLength;
            fields.Add(new SecretField(kind, value));
        }
        return fields;
    }

    private static void Zero(Slot slot)
    {
        CryptographicOperations.ZeroMemory(slot.Cipher);
        CryptographicOperations.ZeroMemory(slot.Nonce);
    }

    private sealed class Slot(byte[] cipher, byte[] nonce, DateTimeOffset at, bool save)
    {
        public byte[] Cipher { get; } = cipher;
        public byte[] Nonce { get; } = nonce;
        public DateTimeOffset At { get; } = at;
        public bool Save { get; } = save;
    }
}

public static class LoginBody
{
    public const int MaxBytes = 16 * 1024;
    private static readonly HashSet<string> Kinds = new(StringComparer.Ordinal) { "username", "email", "password", "otp" };

    public static bool TryParse(ReadOnlySpan<byte> utf8, out List<SecretField> fields, out bool saveToVault, out string error)
    {
        fields = new List<SecretField>();
        saveToVault = false;
        error = "";
        var reader = new Utf8JsonReader(utf8);
        try
        {
            if (!reader.Read() || reader.TokenType != JsonTokenType.StartObject)
            {
                error = "invalid json";
                return false;
            }
            while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
            {
                if (reader.TokenType != JsonTokenType.PropertyName)
                {
                    error = "invalid json";
                    return false;
                }
                var name = reader.GetString() ?? "";
                if (!reader.Read())
                {
                    error = "invalid json";
                    return false;
                }
                if (name == "saveToVault")
                {
                    if (reader.TokenType is JsonTokenType.True or JsonTokenType.False) saveToVault = reader.GetBoolean();
                    else reader.Skip();
                    continue;
                }
                if (name == "values" && reader.TokenType == JsonTokenType.StartObject)
                {
                    if (!ReadValues(ref reader, fields, out error)) return false;
                    continue;
                }
                reader.Skip();
            }
        }
        catch (JsonException)
        {
            error = "invalid json";
            return false;
        }
        if (fields.Count == 0)
        {
            error = "missing_field";
            return false;
        }
        return true;
    }

    private static bool ReadValues(ref Utf8JsonReader reader, List<SecretField> fields, out string error)
    {
        error = "";
        Span<byte> scratch = stackalloc byte[512];
        while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
        {
            if (reader.TokenType != JsonTokenType.PropertyName)
            {
                error = "invalid json";
                return false;
            }
            var kind = (reader.GetString() ?? "").Trim().ToLowerInvariant();
            if (!reader.Read())
            {
                error = "invalid json";
                return false;
            }
            if (reader.TokenType != JsonTokenType.String || !Kinds.Contains(kind))
            {
                reader.Skip();
                continue;
            }
            int written;
            try
            {
                written = reader.CopyString(scratch);
            }
            catch (ArgumentException)
            {
                error = "missing_field";
                return false;
            }
            if (written == 0)
            {
                scratch.Clear();
                continue;
            }
            var copy = scratch[..written].ToArray();
            scratch[..written].Clear();
            fields.Add(new SecretField(kind, copy));
        }
        return true;
    }
}

public static class OwnerPasswordGuard
{
    public const string DevDefault = "teammates-dev";

    public static void Ensure(bool required, string? password)
    {
        if (!required) return;
        if (string.IsNullOrWhiteSpace(password) || password == DevDefault)
            throw new InvalidOperationException("OWNER_PASSWORD must be a generated secret. The dev default is refused when REQUIRE_OWNER_PASSWORD=true.");
    }
}

public static class CredentialGrants
{
    public static string Host(string? target)
    {
        if (string.IsNullOrWhiteSpace(target)) return "";
        if (Uri.TryCreate(target, UriKind.Absolute, out var uri) && !string.IsNullOrWhiteSpace(uri.Host))
            return uri.IdnHost.ToLowerInvariant();
        return "";
    }

    public static string HostOf(JsonElement args)
    {
        var url = Arg(args, "url");
        var host = Host(url);
        if (host.Length > 0) return host;
        var domain = Arg(args, "domain").Trim().TrimEnd('.').ToLowerInvariant();
        if (domain.Length == 0 || domain.Contains('/') || domain.Contains(' ') || domain.Contains(':')) return "";
        return domain;
    }

    public static bool Covers(string risk, JsonElement args, ISet<string>? grants)
    {
        if (grants == null || grants.Count == 0 || risk != ActionClasses.CredentialUse) return false;
        var host = HostOf(args);
        if (host.Length == 0 || CredentialSites.IsLookAlike(host)) return false;
        foreach (var grant in grants)
        {
            if (host.Equals(grant, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static string Arg(JsonElement args, string name) =>
        args.ValueKind == JsonValueKind.Object && args.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";
}
