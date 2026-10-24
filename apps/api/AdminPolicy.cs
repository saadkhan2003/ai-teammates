using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;

namespace Teammates.Api;

public static class AdminLimits
{
    public const int MaxStorageMb = 50 * 1024;
    public const int MaxRamMb = 8 * 1024;
    public const int MaxCpuMillis = 8_000;

    public static bool StorageOk(int mb) => mb is >= 1 and <= MaxStorageMb;

    public static bool RamOk(int mb) => mb is >= 256 and <= MaxRamMb;

    public static bool CpuOk(int millis) => millis is >= 100 and <= MaxCpuMillis;

    public static bool PriceOk(int cents) => cents is >= 0 and <= 1_000_000;

    public static bool WeeklyCreditsOk(int credits) => credits is >= 0 and <= 1_000_000;

    public static bool PlanOk(int priceCents, int weeklyCredits, int storageMb, int ramMb, int cpuMillis) =>
        PriceOk(priceCents) && WeeklyCreditsOk(weeklyCredits) && StorageOk(storageMb) && RamOk(ramMb) && CpuOk(cpuMillis);

    public static bool RefundFits(int invoiceCents, int alreadyRefunded, int next) =>
        next > 0 && alreadyRefunded >= 0 && alreadyRefunded + next <= invoiceCents;
}

public static class AdminNet
{
    public static bool ValidCidr(string? cidr)
    {
        if (string.IsNullOrWhiteSpace(cidr) || cidr.Length > 80) return false;
        var parts = cidr.Trim().Split('/');
        if (!IPAddress.TryParse(parts[0], out _)) return false;
        if (parts.Length == 1) return true;
        if (parts.Length != 2 || !int.TryParse(parts[1], out var bits)) return false;
        var family = IPAddress.Parse(parts[0]).AddressFamily;
        var max = family == AddressFamily.InterNetwork ? 32 : 128;
        return bits >= 0 && bits <= max;
    }

    public static bool Allows(string? ip, IReadOnlyList<string> cidrs)
    {
        if (cidrs.Count == 0) return true;
        if (!IPAddress.TryParse(ip, out var address)) return false;
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        foreach (var cidr in cidrs)
        {
            if (Contains(cidr, address)) return true;
        }
        return false;
    }

    static bool Contains(string cidr, IPAddress address)
    {
        var parts = cidr.Trim().Split('/');
        if (!IPAddress.TryParse(parts[0], out var network)) return false;
        if (network.IsIPv4MappedToIPv6) network = network.MapToIPv4();
        if (network.AddressFamily != address.AddressFamily) return false;
        if (parts.Length == 1) return network.Equals(address);
        if (!int.TryParse(parts[1], out var bits)) return false;
        var net = network.GetAddressBytes();
        var ip = address.GetAddressBytes();
        if (net.Length != ip.Length) return false;
        var whole = bits / 8;
        var rest = bits % 8;
        for (var i = 0; i < whole; i++)
        {
            if (net[i] != ip[i]) return false;
        }
        if (rest == 0) return true;
        var mask = (byte)(0xFF << (8 - rest));
        return (net[whole] & mask) == (ip[whole] & mask);
    }
}

public static class AdminTotp
{
    const string Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    public static string GenerateSecret() => EncodeBase32(RandomNumberGenerator.GetBytes(20));

    public static int Code(byte[] secret, long counter)
    {
        Span<byte> counterBytes = stackalloc byte[8];
        for (var i = 7; i >= 0; i--)
        {
            counterBytes[i] = (byte)(counter & 0xff);
            counter >>= 8;
        }
        var hash = HMACSHA1.HashData(secret, counterBytes);
        var offset = hash[^1] & 0x0f;
        var bin = ((hash[offset] & 0x7f) << 24)
            | (hash[offset + 1] << 16)
            | (hash[offset + 2] << 8)
            | hash[offset + 3];
        return bin % 1_000_000;
    }

    public static bool Verify(string secret, string? code, DateTimeOffset now, int skew = 1)
    {
        if (string.IsNullOrWhiteSpace(code) || code.Length != 6 || !code.All(char.IsDigit)) return false;
        byte[] key;
        try
        {
            key = DecodeBase32(secret);
        }
        catch (FormatException)
        {
            return false;
        }
        var counter = now.ToUnixTimeSeconds() / 30;
        for (var delta = -skew; delta <= skew; delta++)
        {
            if (Code(key, counter + delta).ToString("000000") == code) return true;
        }
        return false;
    }

    public static string EncodeBase32(byte[] data)
    {
        var bits = 0;
        var value = 0;
        var output = new StringBuilder();
        foreach (var bite in data)
        {
            value = (value << 8) | bite;
            bits += 8;
            while (bits >= 5)
            {
                output.Append(Alphabet[(value >> (bits - 5)) & 31]);
                bits -= 5;
            }
        }
        if (bits > 0) output.Append(Alphabet[(value << (5 - bits)) & 31]);
        return output.ToString();
    }

    public static byte[] DecodeBase32(string text)
    {
        var cleaned = text.Trim().TrimEnd('=').ToUpperInvariant();
        var bits = 0;
        var value = 0;
        var output = new List<byte>(cleaned.Length);
        foreach (var ch in cleaned)
        {
            var index = Alphabet.IndexOf(ch);
            if (index < 0) throw new FormatException("secret");
            value = (value << 5) | index;
            bits += 5;
            if (bits >= 8)
            {
                output.Add((byte)((value >> (bits - 8)) & 0xff));
                bits -= 8;
            }
        }
        return output.ToArray();
    }

    public static string Protect(byte[] master, Guid userId, string secret)
    {
        var (cipher, nonce) = KeyEncryption.Encrypt(master, userId, userId, "totp", KeyEncryption.KeyVersion, Encoding.UTF8.GetBytes(secret));
        return Convert.ToBase64String(nonce) + "." + Convert.ToBase64String(cipher);
    }

    public static string Unprotect(byte[] master, Guid userId, string stored)
    {
        var parts = stored.Split('.', 2);
        if (parts.Length != 2) throw new CryptographicException("totp secret");
        var plain = KeyEncryption.Decrypt(master, userId, userId, "totp", KeyEncryption.KeyVersion, Convert.FromBase64String(parts[1]), Convert.FromBase64String(parts[0]));
        return Encoding.UTF8.GetString(plain);
    }
}
