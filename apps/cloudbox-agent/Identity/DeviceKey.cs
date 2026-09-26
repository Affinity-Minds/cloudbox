using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;

namespace CloudBox.Agent.Identity;

/// <summary>Public half of an RSA key as a JWK (RFC 7517), serialised as <c>{ kty, n, e }</c>.</summary>
public sealed record PublicKeyJwk(string Kty, string N, string E)
{
    public static PublicKeyJwk FromRsa(RSAParameters p) =>
        new("RSA",
            Base64Url.EncodeToString(p.Modulus ?? throw new ArgumentException("Modulus missing", nameof(p))),
            Base64Url.EncodeToString(p.Exponent ?? throw new ArgumentException("Exponent missing", nameof(p))));

    /// <summary>RFC 7638 JWK thumbprint: SHA-256 over the required members in lexicographic order, no whitespace.
    /// Matches the server's <c>device_key_thumbprint</c>.</summary>
    public string Thumbprint() =>
        Base64Url.EncodeToString(SHA256.HashData(Encoding.UTF8.GetBytes(
            $"{{\"e\":\"{E}\",\"kty\":\"{Kty}\",\"n\":\"{N}\"}}")));
}

/// <summary>Public view of the device key plus how it is protected ("tpm" or "software").</summary>
public sealed record DeviceKeyInfo(string KeyProtection, PublicKeyJwk Jwk)
{
    public string Thumbprint => Jwk.Thumbprint();
}

public interface IDeviceKeyStore
{
    /// <summary>Opens the machine's device key or creates it (TPM first, software fallback).</summary>
    DeviceKeyInfo OpenOrCreate();

    DeviceKeyInfo? TryOpen();

    bool Exists();

    /// <summary>Deletes the key. Returns false when there was no key.</summary>
    bool Delete();
}

/// <summary>
/// CNG machine key, RSA 2048, non-exportable. Tries the Microsoft Platform Crypto Provider (TPM) and falls back
/// to the Microsoft Software Key Storage Provider, which is reported as <c>keyProtection = "software"</c>
/// (lower assurance, flagged DEGRADED in Fleet). No custom cryptography: the platform does all of it.
/// </summary>
public sealed class CngDeviceKeyStore(string keyName, bool allowTpm = true) : IDeviceKeyStore
{
    private IEnumerable<(CngProvider Provider, string Protection)> Providers()
    {
        if (allowTpm) yield return (CngProvider.MicrosoftPlatformCryptoProvider, "tpm");
        yield return (CngProvider.MicrosoftSoftwareKeyStorageProvider, "software");
    }

    public DeviceKeyInfo OpenOrCreate()
    {
        var existing = TryOpen();
        if (existing is not null) return existing;

        Exception? tpmError = null;
        foreach (var (provider, protection) in Providers())
        {
            try
            {
                var p = new CngKeyCreationParameters
                {
                    Provider = provider,
                    KeyCreationOptions = CngKeyCreationOptions.MachineKey,
                };
                p.Parameters.Add(new CngProperty("Length", BitConverter.GetBytes(2048), CngPropertyOptions.None));
                if (protection == "software")
                {
                    // TPM keys are inherently non-exportable; the software KSP needs it stated.
                    p.ExportPolicy = CngExportPolicies.None;
                    p.KeyUsage = CngKeyUsages.AllUsages;
                }

                using var key = CngKey.Create(CngAlgorithm.Rsa, keyName, p);
                return Describe(key, protection);
            }
            catch (CryptographicException ex) when (protection == "tpm")
            {
                tpmError = ex; // No TPM / PCP unavailable: fall back to software and report it.
            }
        }

        throw new CryptographicException("Could not create device key", tpmError);
    }

    public DeviceKeyInfo? TryOpen()
    {
        foreach (var (provider, protection) in Providers())
        {
            if (!SafeExists(provider)) continue;
            using var key = CngKey.Open(keyName, provider, CngKeyOpenOptions.MachineKey);
            return Describe(key, protection);
        }

        return null;
    }

    public bool Exists() => Providers().Any(x => SafeExists(x.Provider));

    public bool Delete()
    {
        var deleted = false;
        foreach (var (provider, _) in Providers())
        {
            if (!SafeExists(provider)) continue;
            using var key = CngKey.Open(keyName, provider, CngKeyOpenOptions.MachineKey);
            key.Delete();
            deleted = true;
        }

        return deleted;
    }

    private bool SafeExists(CngProvider provider)
    {
        try
        {
            return CngKey.Exists(keyName, provider, CngKeyOpenOptions.MachineKey);
        }
        catch (CryptographicException)
        {
            return false; // Provider not present (e.g. no TPM).
        }
    }

    private static DeviceKeyInfo Describe(CngKey key, string protection)
    {
        using var rsa = new RSACng(key);
        return new DeviceKeyInfo(protection, PublicKeyJwk.FromRsa(rsa.ExportParameters(false)));
    }
}
