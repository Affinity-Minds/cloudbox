using System.Buffers.Text;
using System.Security.Cryptography;
using CloudBox.Agent.Identity;
using CloudBox.Agent.State;

namespace CloudBox.Agent.Tests;

public class IdentityTests
{
    [Fact]
    public void Jwk_of_rsa_key_is_unpadded_base64url_of_modulus_and_exponent()
    {
        using var rsa = RSA.Create(2048);
        var p = rsa.ExportParameters(false);
        var jwk = PublicKeyJwk.FromRsa(p);

        Assert.Equal("RSA", jwk.Kty);
        Assert.Equal("AQAB", jwk.E);
        Assert.DoesNotContain('+', jwk.N);
        Assert.DoesNotContain('/', jwk.N);
        Assert.DoesNotContain('=', jwk.N);
        Assert.Equal(p.Modulus, Base64Url.DecodeFromChars(jwk.N));
        Assert.Equal(342, jwk.N.Length); // 256 bytes → 342 base64url chars, no padding.
    }

    [Fact]
    public void Thumbprint_matches_rfc7638_example()
    {
        var jwk = new PublicKeyJwk("RSA",
            "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
            "AQAB");
        Assert.Equal("NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs", jwk.Thumbprint());
    }

    [Fact]
    public void In_memory_key_store_is_stable_until_deleted()
    {
        var keys = new InMemoryDeviceKeyStore();
        var a = keys.OpenOrCreate();
        Assert.Equal(a.Thumbprint, keys.OpenOrCreate().Thumbprint);
        Assert.True(keys.Delete());
        Assert.False(keys.Exists());
        Assert.NotEqual(a.Thumbprint, keys.OpenOrCreate().Thumbprint);
    }
}

public sealed class StateTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("cbx-state-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    [Fact]
    public void Dpapi_state_round_trips_and_is_not_plaintext()
    {
        var path = Path.Combine(_dir, "agent-state.bin");
        var store = new FileStateStore(path, new DpapiProtector("CloudBox.Agent.State.v1"));
        var key = new InMemoryDeviceKeyStore().OpenOrCreate();
        var state = TestState.For(key);
        state.TrustedTime.ObserveServerTime(DateTimeOffset.Parse("2026-09-26T20:00:00Z"));
        state.Entitlement = "eyJ.jwe";
        state.EntitlementGeneration = 3;

        store.Save(state);
        var raw = File.ReadAllText(path);
        Assert.DoesNotContain("device-token", raw);
        Assert.DoesNotContain("dev_1", raw);

        var loaded = store.Load()!;
        Assert.Equal("device-token", loaded.DeviceToken);
        Assert.Equal(key.Thumbprint, loaded.KeyThumbprint);
        Assert.Equal(3, loaded.EntitlementGeneration);
        Assert.Equal("eyJ.jwe", loaded.Entitlement);
        Assert.Equal(DateTimeOffset.Parse("2026-09-26T20:00:00Z"), loaded.TrustedTime.HighestTrustedTime);
    }

    [Fact]
    public void State_file_copied_from_another_device_is_rejected()
    {
        // Device A writes its state.
        var keysA = new InMemoryDeviceKeyStore();
        var pathA = Path.Combine(_dir, "a.bin");
        new FileStateStore(pathA, new PassThroughProtector()).Save(TestState.For(keysA.OpenOrCreate()));

        // The file is copied onto device B, which has its own key.
        var pathB = Path.Combine(_dir, "b.bin");
        File.Copy(pathA, pathB);
        var keysB = new InMemoryDeviceKeyStore();
        keysB.OpenOrCreate();

        var (state, error) = StateBinding.LoadBound(new FileStateStore(pathB, new PassThroughProtector()), keysB);
        Assert.Null(state);
        Assert.Equal(StateBinding.DeviceBindingFailed, error);

        // Device A still loads its own state.
        var (own, ownError) = StateBinding.LoadBound(new FileStateStore(pathA, new PassThroughProtector()), keysA);
        Assert.NotNull(own);
        Assert.Null(ownError);
    }

    [Fact]
    public void Undecryptable_state_is_a_binding_failure_not_a_crash()
    {
        var path = Path.Combine(_dir, "garbage.bin");
        File.WriteAllBytes(path, [1, 2, 3, 4]);
        var keys = new InMemoryDeviceKeyStore();
        keys.OpenOrCreate();
        var (state, error) = StateBinding.LoadBound(new FileStateStore(path, new DpapiProtector("x")), keys);
        Assert.Null(state);
        Assert.Equal(StateBinding.DeviceBindingFailed, error);
    }

    [Fact]
    public void Trusted_time_only_moves_forward_and_detects_rollback()
    {
        var t = new TrustedTimeState();
        var noon = DateTimeOffset.Parse("2027-09-28T12:00:00Z");
        t.ObserveServerTime(noon);
        t.ObserveServerTime(noon.AddDays(-5));
        Assert.Equal(noon, t.HighestTrustedTime);

        Assert.Equal(TrustedTimeState.Healthy, t.Evaluate(noon.AddMinutes(1), TimeSpan.FromMinutes(10)));
        Assert.Equal(TrustedTimeState.Healthy, t.Evaluate(noon.AddMinutes(-5), TimeSpan.FromMinutes(10)));
        Assert.Equal(TrustedTimeState.ClockRollbackSuspected,
            t.Evaluate(DateTimeOffset.Parse("2027-08-01T00:00:00Z"), TimeSpan.FromMinutes(10)));
    }
}
