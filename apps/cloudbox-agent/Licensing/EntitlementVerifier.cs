// Slice 3.3 local verifier. Format: docs/slices/3.2-entitlement-format.md (ES256 JWS nested in an RSA-OAEP-256/A256GCM
// JWE to the device key). Same check order and error codes as the TypeScript reference verifier
// (packages/licensing-contracts/src/entitlement.ts); acceptance = packages/licensing-contracts/test/vectors/v1.json.
//
// Library split (proved on windows-latest by EntitlementVerifierTests.IdentityModel_refuses_RSA_OAEP_256):
// Microsoft.IdentityModel 8.x has no RSA-OAEP-256 key unwrap (its RSA key-wrap set is RSA1_5 / RSA-OAEP only), so the
// JWE decrypt step uses the standard jose-jwt package; the inner ES256 JWS is verified with JsonWebTokenHandler.
// No RSA-OAEP, AES-GCM or ECDSA framing is implemented here.
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CloudBox.Agent.Identity;
using Jose;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace CloudBox.Agent.Licensing;

/// <summary>Entitlement claims (snake_case on the wire). Not secret; the JWE is.</summary>
public sealed record EntitlementClaims
{
    public string Iss { get; init; } = "";
    public string Kid { get; init; } = "";
    public string Jti { get; init; } = "";
    public long Iat { get; init; }
    public string LicenseId { get; init; } = "";
    public string TenantId { get; init; } = "";
    public string DeviceId { get; init; } = "";
    public string DeviceKeyThumbprint { get; init; } = "";
    public int MaxManagedUsers { get; init; }
    public DateTimeOffset ValidFrom { get; init; }
    public DateTimeOffset ValidUntil { get; init; }
    public int RenewalWarningDays { get; init; }
    public int OfflineGraceDays { get; init; }
    public int Generation { get; init; }
    public IReadOnlyList<string> Features { get; init; } = [];
}

/// <summary>Codes match the TypeScript <c>EntitlementError</c>.</summary>
public static class EntitlementErrors
{
    public const string Malformed = "malformed";
    public const string UnsupportedAlgorithm = "unsupported_algorithm";
    public const string DecryptionFailed = "decryption_failed";
    public const string UnknownKid = "unknown_kid";
    public const string SignatureInvalid = "signature_invalid";
    public const string ClaimsInvalid = "claims_invalid";
    public const string DeviceMismatch = "device_mismatch";
}

public sealed class EntitlementException(string code, string message, Exception? inner = null) : Exception(message, inner)
{
    public string Code { get; } = code;
}

public static class EntitlementVerifier
{
    public const string JweAlg = "RSA-OAEP-256";
    public const string JweEnc = "A256GCM";
    public const string JwsAlg = "ES256";
    public const string JwsTyp = "cbx-entitlement+jwt";
    public const string Issuer = "cloudbox";

    /// <summary>
    /// Verifies <paramref name="token"/> for this device. <paramref name="deviceKey"/> is the device's private RSA key
    /// (RSACng over the CNG/TPM key in production; the private operation stays in CNG). <paramref name="pinnedJwks"/>
    /// are the server's public ES256 JWKs as JSON, each carrying its <c>kid</c>. Throws <see cref="EntitlementException"/>.
    /// </summary>
    public static async Task<EntitlementClaims> VerifyAsync(
        string token, RSA deviceKey, PublicKeyJwk devicePublicKey, IReadOnlyCollection<string> pinnedJwks)
    {
        // 1. Five segments.
        var parts = token.Split('.');
        if (parts.Length != 5) throw new EntitlementException(EntitlementErrors.Malformed, "JWE must have 5 segments");

        // 2. Header gate before any cryptography.
        var header = ParseSegment(parts[0], "JWE header");
        if (Str(header, "alg") != JweAlg || Str(header, "enc") != JweEnc || header.ContainsKey("zip"))
        {
            throw new EntitlementException(EntitlementErrors.UnsupportedAlgorithm,
                $"JWE must be {JweAlg}/{JweEnc} without compression");
        }

        if (!string.Equals(Str(header, "cty"), "JWT", StringComparison.OrdinalIgnoreCase))
        {
            throw new EntitlementException(EntitlementErrors.Malformed, "JWE cty must be JWT");
        }

        var outerKid = Str(header, "kid");

        // 3. Decrypt with the device key, restricted to exactly these algorithms.
        string jws;
        try
        {
            jws = JWT.Decode(token, deviceKey, JweAlgorithm.RSA_OAEP_256, JweEncryption.A256GCM);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            throw new EntitlementException(EntitlementErrors.DecryptionFailed, "Entitlement could not be decrypted with this device key", ex);
        }

        // 4. Inner header: ES256, kid present, equal to the outer kid, and pinned.
        var inner = jws.Split('.');
        if (inner.Length != 3) throw new EntitlementException(EntitlementErrors.Malformed, "Inner JWS must have 3 segments");
        var jwsHeader = ParseSegment(inner[0], "JWS header");
        if (Str(jwsHeader, "alg") != JwsAlg)
        {
            throw new EntitlementException(EntitlementErrors.UnsupportedAlgorithm, "Inner JWS must be ES256");
        }

        var kid = Str(jwsHeader, "kid");
        if (string.IsNullOrEmpty(kid) || kid != outerKid)
        {
            throw new EntitlementException(EntitlementErrors.UnknownKid, "JWS kid missing or different from the JWE kid");
        }

        var keys = new List<SecurityKey>();
        foreach (var json in pinnedJwks)
        {
            try
            {
                var jwk = new JsonWebKey(json);
                if (jwk.Kid == kid && jwk.Kty == "EC" && jwk.Crv == "P-256") keys.Add(jwk);
            }
            catch (ArgumentException)
            {
                // Unparseable pinned entry: ignored, never trusted.
            }
        }

        if (keys.Count == 0) throw new EntitlementException(EntitlementErrors.UnknownKid, $"Signing key {kid} is not pinned on this device");

        // 5. Signature, typ, issuer. No lifetime rules: trusted-time logic decides validity (spec §10, §11).
        var result = await new JsonWebTokenHandler().ValidateTokenAsync(jws, new TokenValidationParameters
        {
            IssuerSigningKeys = keys,
            TryAllIssuerSigningKeys = false,
            ValidAlgorithms = [JwsAlg],
            ValidTypes = [JwsTyp],
            ValidIssuer = Issuer,
            ValidateIssuer = true,
            ValidateAudience = false,
            ValidateLifetime = false,
            RequireExpirationTime = false,
            RequireSignedTokens = true,
            ValidateIssuerSigningKey = false,
        });
        if (!result.IsValid)
        {
            var code = result.Exception switch
            {
                SecurityTokenSignatureKeyNotFoundException => EntitlementErrors.UnknownKid,
                SecurityTokenInvalidTypeException or SecurityTokenInvalidIssuerException => EntitlementErrors.ClaimsInvalid,
                SecurityTokenInvalidAlgorithmException => EntitlementErrors.UnsupportedAlgorithm,
                _ => EntitlementErrors.SignatureInvalid,
            };
            throw new EntitlementException(code, "Entitlement signature/claims rejected", result.Exception);
        }

        // 6. Claim consistency.
        EntitlementClaims? claims;
        try
        {
            claims = JsonSerializer.Deserialize<EntitlementClaims>(System.Buffers.Text.Base64Url.DecodeFromChars(inner[1]), Json.Snake);
        }
        catch (Exception ex) when (ex is JsonException or FormatException)
        {
            throw new EntitlementException(EntitlementErrors.ClaimsInvalid, "Claims are not valid JSON", ex);
        }

        if (claims is null || claims.Kid != kid || claims.Jti != claims.LicenseId || claims.Generation < 1 ||
            string.IsNullOrEmpty(claims.DeviceId) || string.IsNullOrEmpty(claims.TenantId) || claims.MaxManagedUsers < 0)
        {
            throw new EntitlementException(EntitlementErrors.ClaimsInvalid, "Entitlement claims are inconsistent");
        }

        // 7. Bound to THIS device key (RFC 7638 over kty, n, e).
        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(claims.DeviceKeyThumbprint), Encoding.ASCII.GetBytes(devicePublicKey.Thumbprint())))
        {
            throw new EntitlementException(EntitlementErrors.DeviceMismatch, "Entitlement is bound to another device key");
        }

        return claims;
    }

    private static Dictionary<string, JsonElement> ParseSegment(string segment, string what)
    {
        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(System.Buffers.Text.Base64Url.DecodeFromChars(segment))
                   ?? throw new EntitlementException(EntitlementErrors.Malformed, $"{what} is empty");
        }
        catch (Exception ex) when (ex is JsonException or FormatException)
        {
            throw new EntitlementException(EntitlementErrors.Malformed, $"{what} is not base64url JSON", ex);
        }
    }

    private static string? Str(Dictionary<string, JsonElement> obj, string name) =>
        obj.TryGetValue(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}
