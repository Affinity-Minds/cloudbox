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
    string DeviceToken);

public sealed record HeartbeatRequest(AgentHealth Health);

public sealed record HeartbeatResponse(DateTimeOffset ServerTime, int? EntitlementGeneration, IReadOnlyList<object>? Commands);

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

    /// <summary>Tonight: real values for device/agent/storage/security; everything else "unknown".</summary>
    public static AgentHealth Build(string deviceId, string keyProtection, string tamper, long? freeBytes) => new(
        deviceId,
        new AgentPart(AgentPaths.AgentVersion, tamper == "none"),
        new LicensePart(Unknown, null),
        new StatePart(Unknown),
        new RdpPart(Unknown, null),
        new UsersPart(null, null, null),
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
