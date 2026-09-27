using B64 = System.Buffers.Text.Base64Url;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using CloudBox.Agent.Identity;
using CloudBox.Agent.Licensing;
using CloudBox.Agent.State;
using Jose;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using Xunit.Abstractions;

namespace CloudBox.Agent.Tests;

/// <summary>packages/licensing-contracts/test/vectors/v1.json (WT-5, throwaway keys) against the .NET verifier.</summary>
public sealed class TestVector
{
    private static readonly Lazy<TestVector> Instance = new(() => new TestVector());

    private TestVector()
    {
        var doc = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "vectors", "v1.json")))!;
        Token = doc["token"]!.GetValue<string>();
        Device = ImportRsa(doc["devicePrivateJwk"]!.AsObject());
        OtherDevice = ImportRsa(doc["otherDevicePrivateJwk"]!.AsObject());
        ServerJwks = doc["serverPublicJwks"]!.AsArray().Select(j => j!.ToJsonString()).ToList();
        Expected = doc["expectedClaims"]!.AsObject();
    }

    public static TestVector Load() => Instance.Value;

    public string Token { get; }
    public RSA Device { get; }
    public RSA OtherDevice { get; }
    public IReadOnlyList<string> ServerJwks { get; }
    public JsonObject Expected { get; }

    public static PublicKeyJwk Public(RSA rsa) => PublicKeyJwk.FromRsa(rsa.ExportParameters(false));

    private static RSA ImportRsa(JsonObject jwk)
    {
        byte[] B(string n) => B64.DecodeFromChars(jwk[n]!.GetValue<string>());
        var rsa = RSA.Create();
        rsa.ImportParameters(new RSAParameters
        {
            Modulus = B("n"), Exponent = B("e"), D = B("d"), P = B("p"), Q = B("q"), DP = B("dp"), DQ = B("dq"),
            InverseQ = B("qi"),
        });
        return rsa;
    }

    /// <summary>The inner JWS, decrypted with the right key (to build re-encrypted / forged variants).</summary>
    public string InnerJws() => JWT.Decode(Token, Device, JweAlgorithm.RSA_OAEP_256, JweEncryption.A256GCM);

    public string Kid => Expected["kid"]!.GetValue<string>();

    /// <summary>Encrypts <paramref name="jws"/> to <paramref name="recipient"/> with the production header.</summary>
    public string EncryptTo(string jws, RSA recipient)
    {
        using var pub = RSA.Create();
        pub.ImportParameters(recipient.ExportParameters(false));
        return JWT.Encode(jws, pub, JweAlgorithm.RSA_OAEP_256, JweEncryption.A256GCM,
            extraHeaders: new Dictionary<string, object> { ["cty"] = "JWT", ["kid"] = Kid });
    }
}

public sealed class EntitlementVerifierTests(ITestOutputHelper output)
{
    private static Task<EntitlementClaims> Verify(string token, RSA key, IReadOnlyCollection<string>? jwks = null) =>
        EntitlementVerifier.VerifyAsync(token, key, TestVector.Public(key), jwks ?? TestVector.Load().ServerJwks);

    private static async Task<string> RejectCode(string token, RSA key, IReadOnlyCollection<string>? jwks = null) =>
        (await Assert.ThrowsAsync<EntitlementException>(() => Verify(token, key, jwks))).Code;

    [Fact]
    public async Task Committed_vector_verifies_to_exactly_the_expected_claims()
    {
        var v = TestVector.Load();
        var claims = await Verify(v.Token, v.Device);
        var e = v.Expected;
        Assert.Equal(e["iss"]!.GetValue<string>(), claims.Iss);
        Assert.Equal(e["kid"]!.GetValue<string>(), claims.Kid);
        Assert.Equal(e["jti"]!.GetValue<string>(), claims.Jti);
        Assert.Equal(e["iat"]!.GetValue<long>(), claims.Iat);
        Assert.Equal(e["license_id"]!.GetValue<string>(), claims.LicenseId);
        Assert.Equal(e["tenant_id"]!.GetValue<string>(), claims.TenantId);
        Assert.Equal(e["device_id"]!.GetValue<string>(), claims.DeviceId);
        Assert.Equal(e["device_key_thumbprint"]!.GetValue<string>(), claims.DeviceKeyThumbprint);
        Assert.Equal(e["max_managed_users"]!.GetValue<int>(), claims.MaxManagedUsers);
        Assert.Equal(DateTimeOffset.Parse(e["valid_from"]!.GetValue<string>()), claims.ValidFrom);
        Assert.Equal(DateTimeOffset.Parse(e["valid_until"]!.GetValue<string>()), claims.ValidUntil);
        Assert.Equal(e["renewal_warning_days"]!.GetValue<int>(), claims.RenewalWarningDays);
        Assert.Equal(e["offline_grace_days"]!.GetValue<int>(), claims.OfflineGraceDays);
        Assert.Equal(e["generation"]!.GetValue<int>(), claims.Generation);
        Assert.Equal(e["features"]!.AsArray().Select(f => f!.GetValue<string>()), claims.Features);
        // The vector's thumbprint is RFC 7638 of the vector device key: our thumbprint code agrees with jose.
        Assert.Equal(claims.DeviceKeyThumbprint, TestVector.Public(v.Device).Thumbprint());
    }

    [Fact]
    public async Task Another_devices_key_cannot_decrypt_it()
    {
        var v = TestVector.Load();
        Assert.Equal(EntitlementErrors.DecryptionFailed, await RejectCode(v.Token, v.OtherDevice));
    }

    [Fact]
    public async Task One_changed_character_in_any_segment_is_rejected()
    {
        var v = TestVector.Load();
        var parts = v.Token.Split('.');
        for (var segment = 0; segment < 5; segment++)
        {
            var p = (string[])parts.Clone();
            if (p[segment].Length == 0) continue; // compact JWE has no empty segments here, but stay safe
            var i = p[segment].Length / 2;
            p[segment] = p[segment][..i] + (p[segment][i] == 'A' ? 'B' : 'A') + p[segment][(i + 1)..];
            var code = await RejectCode(string.Join('.', p), v.Device);
            output.WriteLine($"segment {segment}: {code}");
            Assert.Contains(code, new[]
            {
                EntitlementErrors.Malformed, EntitlementErrors.UnsupportedAlgorithm, EntitlementErrors.DecryptionFailed,
            });
        }
    }

    [Fact]
    public async Task Lease_re_encrypted_to_another_device_fails_the_thumbprint_binding()
    {
        var v = TestVector.Load();
        var moved = v.EncryptTo(v.InnerJws(), v.OtherDevice);
        Assert.Equal(EntitlementErrors.DeviceMismatch, await RejectCode(moved, v.OtherDevice));
    }

    [Fact]
    public async Task Edited_claims_under_the_original_signature_fail_the_signature()
    {
        var v = TestVector.Load();
        var jws = v.InnerJws().Split('.');
        var claims = JsonNode.Parse(B64.DecodeFromChars(jws[1]))!.AsObject();
        claims["max_managed_users"] = 60;
        jws[1] = B64.EncodeToString(Encoding.UTF8.GetBytes(claims.ToJsonString()));
        var forged = v.EncryptTo(string.Join('.', jws), v.Device);
        Assert.Equal(EntitlementErrors.SignatureInvalid, await RejectCode(forged, v.Device));
    }

    [Fact]
    public async Task Unpinned_server_key_is_unknown_kid()
    {
        var v = TestVector.Load();
        Assert.Equal(EntitlementErrors.UnknownKid, await RejectCode(v.Token, v.Device, []));
    }

    [Fact]
    public async Task Wrong_outer_algorithm_is_refused_before_any_cryptography()
    {
        var v = TestVector.Load();
        var parts = v.Token.Split('.');
        var header = JsonNode.Parse(B64.DecodeFromChars(parts[0]))!.AsObject();
        header["alg"] = "RSA-OAEP";
        parts[0] = B64.EncodeToString(Encoding.UTF8.GetBytes(header.ToJsonString()));
        Assert.Equal(EntitlementErrors.UnsupportedAlgorithm, await RejectCode(string.Join('.', parts), v.Device));
    }

    /// <summary>
    /// Evidence for the library split in Licensing/EntitlementVerifier.cs: Microsoft.IdentityModel (8.x) cannot unwrap
    /// RSA-OAEP-256, so the decrypt step uses jose-jwt. If this ever starts passing validation, the fallback can go.
    /// </summary>
    [Fact]
    public async Task IdentityModel_refuses_RSA_OAEP_256()
    {
        var v = TestVector.Load();
        var result = await new JsonWebTokenHandler().ValidateTokenAsync(v.Token, new TokenValidationParameters
        {
            TokenDecryptionKey = new RsaSecurityKey(v.Device),
            IssuerSigningKeys = v.ServerJwks.Select(j => (SecurityKey)new JsonWebKey(j)).ToList(),
            ValidTypes = [EntitlementVerifier.JwsTyp],
            ValidIssuer = EntitlementVerifier.Issuer,
            ValidateAudience = false,
            ValidateLifetime = false,
            RequireExpirationTime = false,
        });
        output.WriteLine($"IdentityModel: IsValid={result.IsValid} {result.Exception?.GetType().Name}: {result.Exception?.Message}");
        Assert.False(result.IsValid);
    }
}

public sealed class LocalLicenseTests
{
    private sealed class Keys(IReadOnlyList<string> jwks) : Cloud.ISigningKeysClient
    {
        public int Calls { get; private set; }

        public Task<IReadOnlyList<string>> GetSigningKeysAsync(Uri baseUrl, string deviceToken, CancellationToken ct)
        {
            Calls++;
            return Task.FromResult(jwks);
        }
    }

    private static AgentState StateFor(TestVector v, InMemoryDeviceKeyStore keys)
    {
        var s = TestState.For(keys.TryOpen()!);
        s.DeviceId = v.Expected["device_id"]!.GetValue<string>();
        s.TenantId = v.Expected["tenant_id"]!.GetValue<string>();
        return s;
    }

    [Fact]
    public async Task Accepts_a_verified_lease_fetching_the_server_key_on_first_use()
    {
        var v = TestVector.Load();
        var keys = new InMemoryDeviceKeyStore(key: v.Device);
        var server = new Keys(v.ServerJwks);
        var state = StateFor(v, keys);

        var error = await new LocalLicense(keys, server).AcceptAsync(state, new Cloud.EntitlementResponse(v.Token, 1), DateTimeOffset.UtcNow, CancellationToken.None);

        Assert.Null(error);
        Assert.Equal(1, server.Calls);
        Assert.Equal(v.Token, state.Entitlement);
        Assert.Equal(1, state.HighestEntitlementGeneration);
        Assert.Single(state.PinnedSigningKeys);
    }

    [Fact]
    public async Task Refuses_a_stale_generation_and_keeps_the_current_lease()
    {
        var v = TestVector.Load();
        var keys = new InMemoryDeviceKeyStore(key: v.Device);
        var state = StateFor(v, keys);
        state.PinnedSigningKeys.AddRange(v.ServerJwks);
        state.Entitlement = "current";
        state.EntitlementGeneration = 2;
        state.HighestEntitlementGeneration = 2;

        var error = await new LocalLicense(keys, new Keys([])).AcceptAsync(state, new Cloud.EntitlementResponse(v.Token, 1), DateTimeOffset.UtcNow, CancellationToken.None);

        Assert.Equal("stale_generation", error);
        Assert.Equal("current", state.Entitlement);
        Assert.Equal(2, state.EntitlementGeneration);
    }

    [Fact]
    public async Task Refuses_a_lease_issued_to_another_device_id()
    {
        var v = TestVector.Load();
        var keys = new InMemoryDeviceKeyStore(key: v.Device);
        var state = StateFor(v, keys);
        state.DeviceId = "dev_somebody_else";
        state.PinnedSigningKeys.AddRange(v.ServerJwks);

        var error = await new LocalLicense(keys, new Keys([])).AcceptAsync(state, new Cloud.EntitlementResponse(v.Token, 1), DateTimeOffset.UtcNow, CancellationToken.None);

        Assert.Equal(EntitlementErrors.DeviceMismatch, error);
        Assert.Null(state.Entitlement);
    }

    [Fact]
    public async Task A_copied_lease_is_refused_on_another_machine()
    {
        // Slice 3.4 copy protection: device B holds device A's state and lease but its own key.
        var v = TestVector.Load();
        var deviceB = new InMemoryDeviceKeyStore(key: v.OtherDevice);
        var state = StateFor(v, deviceB);
        state.PinnedSigningKeys.AddRange(v.ServerJwks);
        state.Entitlement = v.Token;
        state.EntitlementGeneration = 1;

        var (claims, error) = await new LocalLicense(deviceB, new Keys([])).VerifyStoredAsync(state);

        Assert.Null(claims);
        Assert.Equal(EntitlementErrors.DecryptionFailed, error);
    }
}
