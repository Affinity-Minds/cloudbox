using CloudBox.Agent.Cloud;
using CloudBox.Agent.Identity;
using CloudBox.Agent.State;
using Serilog;

namespace CloudBox.Agent.Licensing;

/// <summary>
/// Verifies the stored lease with the device key and the pinned server keys, and accepts new generations only after
/// they verify. Pinned keys are fetched once at enrollment and re-fetched (additively) only when a lease names a kid
/// that is not pinned yet, i.e. after a server key rotation (ADR 0004).
/// </summary>
public sealed class LocalLicense(IDeviceKeyStore keys, ISigningKeysClient signingKeys)
{
    private readonly ILogger _log = Log.ForContext<LocalLicense>();

    // The health loop re-evaluates every cycle; the device-key decrypt (TPM) runs only when the lease or the pinned key
    // set changed. Claims are not secret; the cache lives in this process only.
    private (string Token, int Pinned, string Thumbprint, EntitlementClaims? Claims, string? Error)? _last;

    public async Task<(EntitlementClaims? Claims, string? Error)> VerifyAsync(AgentState state, string token)
    {
        if (_last is { } c && c.Token == token && c.Pinned == state.PinnedSigningKeys.Count && c.Thumbprint == state.KeyThumbprint)
        {
            return (c.Claims, c.Error);
        }

        var result = await VerifyUncachedAsync(state, token);
        _last = (token, state.PinnedSigningKeys.Count, state.KeyThumbprint, result.Claims, result.Error);
        return result;
    }

    private async Task<(EntitlementClaims? Claims, string? Error)> VerifyUncachedAsync(AgentState state, string token)
    {
        var info = keys.TryOpen();
        using var rsa = keys.OpenPrivateKey();
        if (info is null || rsa is null) return (null, StateBinding.DeviceBindingFailed);
        try
        {
            return (await EntitlementVerifier.VerifyAsync(token, rsa, info.Jwk, state.PinnedSigningKeys), null);
        }
        catch (EntitlementException ex)
        {
            return (null, ex.Code);
        }
    }

    /// <summary>Stored lease → claims or verifier error. No token → (null, null).</summary>
    public Task<(EntitlementClaims? Claims, string? Error)> VerifyStoredAsync(AgentState state) =>
        string.IsNullOrEmpty(state.Entitlement)
            ? Task.FromResult<(EntitlementClaims?, string?)>((null, null))
            : VerifyAsync(state, state.Entitlement);

    /// <summary>Adds any server keys not pinned yet. Never removes one.</summary>
    public async Task RefreshPinnedKeysAsync(AgentState state, CancellationToken ct)
    {
        var fetched = await signingKeys.GetSigningKeysAsync(new Uri(state.BaseUrl), state.DeviceToken, ct);
        foreach (var jwk in fetched)
        {
            if (!state.PinnedSigningKeys.Contains(jwk, StringComparer.Ordinal)) state.PinnedSigningKeys.Add(jwk);
        }
    }

    /// <summary>
    /// Accepts a downloaded lease into <paramref name="state"/> only when it verifies, belongs to this device and tenant,
    /// and is not older than what is held. Returns null on success, else the reason it was refused (state unchanged).
    /// </summary>
    public async Task<string?> AcceptAsync(AgentState state, EntitlementResponse ent, DateTimeOffset now, CancellationToken ct)
    {
        var (claims, error) = await VerifyAsync(state, ent.Entitlement);
        if (error == EntitlementErrors.UnknownKid)
        {
            try
            {
                await RefreshPinnedKeysAsync(state, ct);
                (claims, error) = await VerifyAsync(state, ent.Entitlement);
            }
            catch (CloudApiException ex)
            {
                _log.Warning("Could not refresh the pinned signing keys: {Error}", ex.Message);
            }
        }

        if (error is null && claims is not null)
        {
            if (claims.DeviceId != state.DeviceId || claims.TenantId != state.TenantId) error = EntitlementErrors.DeviceMismatch;
            else if (claims.Generation != ent.Generation || claims.Generation < state.HighestEntitlementGeneration) error = "stale_generation";
        }

        if (error is not null || claims is null)
        {
            Security.Log.Warning("Downloaded entitlement generation {Generation} refused ({Reason}); keeping the current lease",
                ent.Generation, error);
            return error ?? "unverified";
        }

        state.Entitlement = ent.Entitlement;
        state.EntitlementGeneration = claims.Generation;
        state.HighestEntitlementGeneration = Math.Max(state.HighestEntitlementGeneration, claims.Generation);
        state.EntitlementFetchedAt = now;
        state.EntitlementRevoked = false;
        _log.Information("Entitlement generation {Generation} verified and stored (max users {Users}, valid until {Until:u})",
            claims.Generation, claims.MaxManagedUsers, claims.ValidUntil);
        return null;
    }
}
