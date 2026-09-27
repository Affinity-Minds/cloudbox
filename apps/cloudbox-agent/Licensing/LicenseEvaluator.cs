// Slice 3.3 startup/cycle validation → normalised licence state (spec §10, §31):
//   boot → load cached entitlement → verify issuer/signature → machine binding → generation/state → validity against the
//   trusted-time high-water mark → slot allowance → publish.
// Pure: every input is passed in, so the whole state machine is unit-tested.
using CloudBox.Agent.State;

namespace CloudBox.Agent.Licensing;

public static class LicenseStates
{
    public const string Valid = "VALID";
    public const string OfflineValid = "OFFLINE_VALID";
    public const string Grace = "GRACE";
    public const string Expired = "EXPIRED";
    public const string Tamper = "TAMPER";
    public const string Revoked = "REVOKED";
    public const string NoPlan = "NO_PLAN";

    /// <summary>Spec §31: only these open the RDP gate. Everything else, and anything unknown, blocks.</summary>
    public static bool AllowsRemoteAccess(string? state) => state is Valid or OfflineValid or Grace;
}

/// <summary>Cloud wording (packages/contracts agent.ts). Shown verbatim in Status and Setup.</summary>
public static class CloudLicenseStates
{
    public const string Licensed = "licensed";
    public const string NoActivePlan = "no_active_plan";
    public const string DeviceLimitReached = "device_limit_reached";
    public const string NoActivePlanMessage = "No active plan found. Please contact the CloudBox admin.";
}

/// <summary>Normalised licence state published on the pipe and in the health document.</summary>
public sealed record LicenseSnapshot
{
    public string State { get; init; } = LicenseStates.NoPlan;

    /// <summary>Why: verifier error code, <c>clock_rollback</c>, <c>device_revoked</c>, cloud state, ...</summary>
    public string? Reason { get; init; }

    public string? Message { get; init; }
    public int? DaysRemaining { get; init; }
    public int? GraceDaysRemaining { get; init; }
    public DateTimeOffset? ValidUntil { get; init; }
    public int? MaxManagedUsers { get; init; }
    public int? RenewalWarningDays { get; init; }
    public int Generation { get; init; }
    public bool RenewalDue { get; init; }

    public bool AllowsRemoteAccess => LicenseStates.AllowsRemoteAccess(State);
}

public sealed record LicenseInputs
{
    public required AgentState State { get; init; }
    public required DateTimeOffset LocalNow { get; init; }

    /// <summary>HEALTHY or CLOCK_ROLLBACK_SUSPECTED from <see cref="TrustedTimeState.Evaluate"/>.</summary>
    public string ClockState { get; init; } = TrustedTimeState.Healthy;

    public bool CloudConnected { get; init; }

    /// <summary>Verified claims of <c>State.Entitlement</c>, or the verifier's error code.</summary>
    public EntitlementClaims? Claims { get; init; }

    public string? VerifyError { get; init; }
}

public static class LicenseEvaluator
{
    /// <summary>A lease issued "now" may be a little ahead of a slightly slow local clock.</summary>
    public static readonly TimeSpan NotBeforeTolerance = TimeSpan.FromHours(1);

    public static LicenseSnapshot Evaluate(LicenseInputs i)
    {
        var s = i.State;
        if (s.DeviceRevoked)
        {
            return new LicenseSnapshot { State = LicenseStates.Revoked, Reason = "device_revoked", Generation = s.EntitlementGeneration };
        }

        if (i.ClockState != TrustedTimeState.Healthy)
        {
            return new LicenseSnapshot { State = LicenseStates.Tamper, Reason = "clock_rollback", Generation = s.EntitlementGeneration };
        }

        if (string.IsNullOrEmpty(s.Entitlement))
        {
            if (s.EntitlementRevoked)
            {
                return new LicenseSnapshot { State = LicenseStates.Revoked, Reason = "entitlement_revoked" };
            }

            return new LicenseSnapshot
            {
                State = LicenseStates.NoPlan,
                Reason = s.CloudLicenseState ?? "not_issued",
                Message = s.CloudMessage ?? CloudLicenseStates.NoActivePlanMessage,
            };
        }

        if (i.VerifyError is not null || i.Claims is null)
        {
            return new LicenseSnapshot { State = LicenseStates.Tamper, Reason = i.VerifyError ?? "unverified", Generation = s.EntitlementGeneration };
        }

        var c = i.Claims;
        if (c.DeviceId != s.DeviceId || c.TenantId != s.TenantId)
        {
            return new LicenseSnapshot { State = LicenseStates.Tamper, Reason = EntitlementErrors.DeviceMismatch, Generation = c.Generation };
        }

        // Generation is monotonic: an older lease can never supersede a newer one (spec §33.3).
        if (c.Generation < s.HighestEntitlementGeneration || c.Generation != s.EntitlementGeneration)
        {
            return new LicenseSnapshot { State = LicenseStates.Tamper, Reason = "stale_generation", Generation = c.Generation };
        }

        var basis = new LicenseSnapshot
        {
            Generation = c.Generation,
            ValidUntil = c.ValidUntil,
            MaxManagedUsers = c.MaxManagedUsers,
            RenewalWarningDays = c.RenewalWarningDays,
        };

        if (s.EntitlementRevoked) return basis with { State = LicenseStates.Revoked, Reason = "entitlement_revoked" };

        // Never earlier than the trusted-time high-water mark (spec §11).
        var now = s.TrustedTime.HighestTrustedTime is { } trusted && trusted > i.LocalNow ? trusted : i.LocalNow;
        if (now < c.ValidFrom - NotBeforeTolerance)
        {
            return basis with { State = LicenseStates.NoPlan, Reason = "not_yet_valid", Message = CloudLicenseStates.NoActivePlanMessage };
        }

        var days = CeilDays(c.ValidUntil - now);
        if (now <= c.ValidUntil)
        {
            return basis with
            {
                State = i.CloudConnected ? LicenseStates.Valid : LicenseStates.OfflineValid,
                DaysRemaining = days,
                RenewalDue = days <= c.RenewalWarningDays,
            };
        }

        var graceEnd = c.ValidUntil.AddDays(Math.Max(0, c.OfflineGraceDays));
        if (now <= graceEnd)
        {
            return basis with
            {
                State = LicenseStates.Grace,
                DaysRemaining = 0,
                GraceDaysRemaining = CeilDays(graceEnd - now),
                RenewalDue = true,
            };
        }

        return basis with { State = LicenseStates.Expired, DaysRemaining = 0, RenewalDue = true, Reason = "valid_until_passed" };
    }

    private static int CeilDays(TimeSpan t) => Math.Max(0, (int)Math.Ceiling(t.TotalDays));
}
