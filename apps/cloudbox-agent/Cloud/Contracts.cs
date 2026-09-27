using CloudBox.Agent.Identity;

namespace CloudBox.Agent.Cloud;

// Fixed Agent API contract (docs/plans/PLAN_5AM.md §7). WT-3 implements the server side. Do not deviate.

public sealed record EnrollDevice(
    string Hostname,
    string WindowsBuild,
    string AgentVersion,
    string KeyProtection,
    PublicKeyJwk PublicKeyJwk);

public sealed record EnrollRequest(string Token, EnrollDevice Device);

public sealed record EnrollResponse(
    string DeviceId,
    string TenantId,
    string TenantCode,
    string DeviceName,
    string DeviceToken,
    string? LicenseState = null,
    string? Message = null);

public sealed record HeartbeatRequest(AgentHealth Health);

/// <summary>WT-14 (additive): <c>licenseState</c> is licensed | no_active_plan | device_limit_reached; <c>message</c> is
/// human text when the state needs action.</summary>
public sealed record HeartbeatResponse(
    DateTimeOffset ServerTime,
    int? EntitlementGeneration,
    IReadOnlyList<object>? Commands,
    string? LicenseState = null,
    string? Message = null);

/// <summary><c>GET /api/v1/agent/signing-keys</c> (WT-10, additive): public ES256 JWKs.</summary>
public sealed record SigningKeysResponse(IReadOnlyList<SigningKeyItem> Keys);

public sealed record SigningKeyItem(string Kid, string Alg, string Status, System.Text.Json.Nodes.JsonObject Jwk);

public sealed record EntitlementResponse(string Entitlement, int Generation);

// Spec §29 health document (serialised snake_case). Unknown values are "unknown" states and null numbers.
public sealed record AgentHealth(
    string Device,
    AgentPart Agent,
    LicensePart License,
    StatePart Network,
    RdpPart Rdp,
    UsersPart Users,
    BackupPart Backup,
    StoragePart Storage,
    UpdatesPart Updates,
    SecurityPart Security);

public sealed record AgentPart(string Version, bool Healthy);
public sealed record LicensePart(string State, int? DaysRemaining);
public sealed record StatePart(string State);
public sealed record RdpPart(string State, bool? Listener);
public sealed record UsersPart(int? Configured, int? Limit, int? ActiveSessions);
public sealed record BackupPart(string State, DateTimeOffset? LastSuccess);
public sealed record StoragePart(long? FreeBytes);
public sealed record UpdatesPart(string State, bool? RebootRequired);
public sealed record SecurityPart(string DeviceKey, string Tamper);

public static class HealthBuilder
{
    public const string Unknown = "unknown";

    /// <summary>Real values for device/agent/storage/security; licence, RDP and users when the server runtime reports
    /// them (Phase 5), otherwise "unknown"/null.</summary>
    public static AgentHealth Build(string deviceId, string keyProtection, string tamper, long? freeBytes,
        LicensePart? license = null, RdpPart? rdp = null, UsersPart? users = null, StatePart? network = null) => new(
        deviceId,
        new AgentPart(AgentPaths.AgentVersion, tamper == "none"),
        license ?? new LicensePart(Unknown, null),
        network ?? new StatePart(Unknown),
        rdp ?? new RdpPart(Unknown, null),
        users ?? new UsersPart(null, null, null),
        new BackupPart(Unknown, null),
        new StoragePart(freeBytes),
        new UpdatesPart(Unknown, null),
        new SecurityPart(keyProtection, tamper));

    public static long? SystemDriveFreeBytes()
    {
        try
        {
            var root = Path.GetPathRoot(Environment.SystemDirectory) ?? "C:\\";
            return new DriveInfo(root).AvailableFreeSpace;
        }
        catch (IOException)
        {
            return null;
        }
    }
}
