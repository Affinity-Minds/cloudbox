using CloudBox.Agent.Cloud;
using CloudBox.Agent.Identity;
using CloudBox.Agent.State;
using Serilog;

namespace CloudBox.Agent.Service;

/// <summary>One iteration of the health loop. Returns how long to wait before the next one.</summary>
public sealed class HeartbeatCycle(
    ILocalStateStore stateStore,
    IDeviceKeyStore keys,
    IHeartbeatClient heartbeat,
    IEntitlementClient entitlements,
    AgentStatus status,
    TimeProvider clock,
    Random rng,
    Func<long?>? freeBytes = null,
    ServerRuntime? server = null)
{
    // Generous so an unsynchronised lab clock is not reported as tampering; Slice 4.1 tunes this.
    private static readonly TimeSpan ClockTolerance = TimeSpan.FromHours(1);
    private readonly ILogger _log = Log.ForContext<HeartbeatCycle>();
    private readonly Func<long?> _freeBytes = freeBytes ?? HealthBuilder.SystemDriveFreeBytes;
    private bool _bindingReported;
    private bool _lastConnected;

    public int ConsecutiveFailures { get; private set; }

    public async Task<TimeSpan> RunOnceAsync(CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        var (state, bindingError) = StateBinding.LoadBound(stateStore, keys);
        if (bindingError is not null)
        {
            if (!_bindingReported)
            {
                Security.Log.Error("Agent state does not match this machine's device key ({Tamper}); refusing to use it", bindingError);
                _bindingReported = true;
            }

            status.Set(new AgentStatusSnapshot { Cloud = "error", Tamper = bindingError, LastError = "State/device binding failed", UpdatedAt = now });
            return Backoff.Interval;
        }

        if (state is null)
        {
            status.Set(new AgentStatusSnapshot { Cloud = "not_enrolled", UpdatedAt = now });
            return Backoff.Interval;
        }

        var clockState = state.TrustedTime.Evaluate(now, ClockTolerance);
        var tamper = clockState == TrustedTimeState.Healthy ? "none" : clockState;
        if (tamper != "none") Security.Log.Warning("Local clock is behind the trusted-time high-water mark ({Tamper})", tamper);

        // Boot-time gate (spec §10.1): the local lease is validated and enforced before and independently of the cloud.
        LocalReport? local = null;
        if (server is not null)
        {
            var lic = await server.EvaluateAsync(state, now, clockState, _lastConnected);
            local = server.Enforce(lic);
        }

        string cloud;
        string? error = null;
        try
        {
            var health = local is null
                ? HealthBuilder.Build(state.DeviceId, state.KeyProtection, tamper, _freeBytes())
                : HealthBuilder.Build(state.DeviceId, state.KeyProtection, tamper, _freeBytes(),
                    new LicensePart(local.License.State, local.License.DaysRemaining),
                    new RdpPart(local.Rdp.State, local.Rdp.Listener),
                    new UsersPart(local.Users.Configured, local.Users.Limit, local.Users.ActiveSessions),
                    new StatePart("not_configured"));
            var baseUrl = new Uri(state.BaseUrl);
            var res = await heartbeat.HeartbeatAsync(baseUrl, state.DeviceToken, health, ct);
            state.TrustedTime.ObserveServerTime(res.ServerTime);
            state.LastHeartbeatAt = now;
            state.DeviceRevoked = false;
            if (res.LicenseState is not null)
            {
                state.CloudLicenseState = res.LicenseState;
                state.CloudMessage = res.Message;
            }

            if (res.EntitlementGeneration is null && state.EntitlementGeneration > 0 && !state.EntitlementRevoked)
            {
                // The cloud holds no live lease for a device that has one: it was revoked (spec §32).
                state.EntitlementRevoked = true;
                Security.Log.Warning("Cloud reports no live entitlement; generation {Generation} treated as revoked", state.EntitlementGeneration);
            }

            if (server is not null && state.PinnedSigningKeys.Count == 0)
            {
                // Enrolled before keys could be pinned (or by an older agent): pin them now, over this authenticated channel.
                try
                {
                    await server.License.RefreshPinnedKeysAsync(state, ct);
                }
                catch (CloudApiException ex)
                {
                    _log.Warning("Could not pin the server signing keys yet: {Error}", ex.Message);
                }
            }

            if (res.EntitlementGeneration is { } gen && gen > state.EntitlementGeneration)
            {
                var ent = await entitlements.GetEntitlementAsync(baseUrl, state.DeviceToken, ct);
                if (ent is not null)
                {
                    if (server is null)
                    {
                        state.Entitlement = ent.Entitlement;
                        state.EntitlementGeneration = ent.Generation;
                        state.EntitlementFetchedAt = now;
                        _log.Information("Entitlement generation {Generation} downloaded", ent.Generation);
                    }
                    else
                    {
                        await server.License.AcceptAsync(state, ent, now, ct);
                    }
                }
            }

            ConsecutiveFailures = 0;
            cloud = "connected";
        }
        catch (CloudApiException ex)
        {
            ConsecutiveFailures++;
            cloud = ex.State;
            error = ex.Message;
            // 401 only: requireDevice answers 401 for a revoked device; a 403 can be an edge/WAF refusal.
            if (ex.Status == 401 && !state.DeviceRevoked)
            {
                state.DeviceRevoked = true;
                Security.Log.Warning("Cloud refused this device's credential; remote access treated as revoked");
            }

            _log.Warning("Heartbeat failed ({Cloud}, attempt {Failures}): {Error}", cloud, ConsecutiveFailures, ex.Message);
        }

        _lastConnected = cloud == "connected";
        stateStore.Save(state); // Persists trusted-time marks even when the cloud is unreachable.
        if (server is not null)
        {
            // Re-evaluate with what the cloud just said (new generation, revocation, connectivity).
            var lic = await server.EvaluateAsync(state, now, clockState, _lastConnected);
            local = server.Enforce(lic);
        }

        var delay = Backoff.Next(ConsecutiveFailures, rng);
        status.Set(new AgentStatusSnapshot
        {
            Enrolled = true,
            DeviceId = state.DeviceId,
            DeviceName = state.DeviceName,
            TenantCode = state.TenantCode,
            KeyProtection = state.KeyProtection,
            Cloud = cloud,
            Tamper = tamper,
            LastError = error,
            LastHeartbeatAt = state.LastHeartbeatAt,
            NextAttemptAt = now + delay,
            ConsecutiveFailures = ConsecutiveFailures,
            EntitlementGeneration = state.EntitlementGeneration,
            EntitlementFetchedAt = state.EntitlementFetchedAt,
            TrustedTime = state.TrustedTime.HighestTrustedTime,
            UpdatedAt = now,
            License = local?.License,
            Gate = local?.Gate,
            Users = local?.Users,
            Rdp = local?.Rdp,
            RenewalUrl = local?.License.RenewalDue == true
                ? $"{state.BaseUrl.TrimEnd('/')}/portal?renew={Uri.EscapeDataString(state.TenantCode)}"
                : null,
        });
        return delay;
    }
}
