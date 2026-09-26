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
    Func<long?>? freeBytes = null)
{
    // Generous so an unsynchronised lab clock is not reported as tampering; Slice 4.1 tunes this.
    private static readonly TimeSpan ClockTolerance = TimeSpan.FromHours(1);
    private readonly ILogger _log = Log.ForContext<HeartbeatCycle>();
    private readonly Func<long?> _freeBytes = freeBytes ?? HealthBuilder.SystemDriveFreeBytes;
    private bool _bindingReported;

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

        string cloud;
        string? error = null;
        try
        {
            var health = HealthBuilder.Build(state.DeviceId, state.KeyProtection, tamper, _freeBytes());
            var baseUrl = new Uri(state.BaseUrl);
            var res = await heartbeat.HeartbeatAsync(baseUrl, state.DeviceToken, health, ct);
            state.TrustedTime.ObserveServerTime(res.ServerTime);
            state.LastHeartbeatAt = now;
            if (res.EntitlementGeneration is { } gen && gen > state.EntitlementGeneration)
            {
                var ent = await entitlements.GetEntitlementAsync(baseUrl, state.DeviceToken, ct);
                if (ent is not null)
                {
                    state.Entitlement = ent.Entitlement;
                    state.EntitlementGeneration = ent.Generation;
                    state.EntitlementFetchedAt = now;
                    _log.Information("Entitlement generation {Generation} downloaded", ent.Generation);
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
            _log.Warning("Heartbeat failed ({Cloud}, attempt {Failures}): {Error}", cloud, ConsecutiveFailures, ex.Message);
        }

        stateStore.Save(state); // Persists trusted-time marks even when the cloud is unreachable.
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
        });
        return delay;
    }
}
