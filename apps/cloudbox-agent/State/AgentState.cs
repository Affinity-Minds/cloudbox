using System.Security.Cryptography;
using System.Text.Json;
using CloudBox.Agent.Identity;

namespace CloudBox.Agent.State;

/// <summary>Persistent agent state. Stored DPAPI-protected; never the authority for entitlement (spec §12).</summary>
public sealed class AgentState
{
    public required string BaseUrl { get; set; }
    public required string DeviceId { get; set; }
    public required string TenantId { get; set; }
    public required string TenantCode { get; set; }
    public required string DeviceName { get; set; }
    public required string DeviceToken { get; set; }
    public required string KeyProtection { get; set; }

    /// <summary>RFC 7638 thumbprint of the device key this state belongs to (device binding).</summary>
    public required string KeyThumbprint { get; set; }

    public DateTimeOffset EnrolledAt { get; set; }
    public DateTimeOffset? LastHeartbeatAt { get; set; }
    public TrustedTimeState TrustedTime { get; set; } = new();
    public int EntitlementGeneration { get; set; }

    /// <summary>Compact JWE as received. Verification is Slice 3.3; never logged.</summary>
    public string? Entitlement { get; set; }

    public DateTimeOffset? EntitlementFetchedAt { get; set; }
}

/// <summary>
/// Trusted-time high-water mark (spec §11, Slice 4.1 seed). Only authenticated server time raises
/// <see cref="HighestTrustedTime"/>; the local wall clock raises <see cref="HighestLocalTime"/>.
/// </summary>
public sealed class TrustedTimeState
{
    public const string Healthy = "HEALTHY";
    public const string ClockRollbackSuspected = "CLOCK_ROLLBACK_SUSPECTED";

    public DateTimeOffset? HighestTrustedTime { get; set; }
    public DateTimeOffset? HighestLocalTime { get; set; }

    public void ObserveServerTime(DateTimeOffset serverTime)
    {
        if (HighestTrustedTime is null || serverTime > HighestTrustedTime) HighestTrustedTime = serverTime;
    }

    /// <summary>Checks the local clock against both marks, then advances the local mark.</summary>
    public string Evaluate(DateTimeOffset localNow, TimeSpan tolerance)
    {
        var floor = new[] { HighestTrustedTime, HighestLocalTime }.Max();
        var result = floor is not null && localNow < floor.Value - tolerance ? ClockRollbackSuspected : Healthy;
        if (HighestLocalTime is null || localNow > HighestLocalTime) HighestLocalTime = localNow;
        return result;
    }
}

public interface ILocalStateStore
{
    AgentState? Load();
    void Save(AgentState state);
    void Delete();
}

/// <summary>Wraps the bytes written to disk. DPAPI in production, pass-through in tests.</summary>
public interface IBlobProtector
{
    byte[] Protect(byte[] data);
    byte[] Unprotect(byte[] data);
}

/// <summary>DPAPI, machine scope: only this machine can decrypt; folder ACL limits it to SYSTEM/Administrators.</summary>
public sealed class DpapiProtector(string purpose) : IBlobProtector
{
    private readonly byte[] _entropy = System.Text.Encoding.UTF8.GetBytes(purpose);

    public byte[] Protect(byte[] data) => ProtectedData.Protect(data, _entropy, DataProtectionScope.LocalMachine);

    public byte[] Unprotect(byte[] data) => ProtectedData.Unprotect(data, _entropy, DataProtectionScope.LocalMachine);
}

/// <summary>JSON state in one protected file, written atomically (temp file + replace).</summary>
public sealed class FileStateStore(string path, IBlobProtector protector) : ILocalStateStore
{
    public static FileStateStore CreateDefault() =>
        new(AgentPaths.StateFile, new DpapiProtector("CloudBox.Agent.State.v1"));

    public AgentState? Load()
    {
        if (!File.Exists(path)) return null;
        var json = protector.Unprotect(File.ReadAllBytes(path));
        return JsonSerializer.Deserialize<AgentState>(json, Json.Options);
    }

    public void Save(AgentState state)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var tmp = path + ".tmp";
        File.WriteAllBytes(tmp, protector.Protect(JsonSerializer.SerializeToUtf8Bytes(state, Json.Options)));
        File.Move(tmp, path, overwrite: true);
    }

    public void Delete() => File.Delete(path);
}

public static class StateBinding
{
    public const string DeviceBindingFailed = "DEVICE_BINDING_FAILED";

    /// <summary>
    /// Loads state and proves it belongs to this machine's device key. A state file copied from another device
    /// carries that device's key thumbprint and is rejected (spec §11 DEVICE_BINDING_FAILED).
    /// </summary>
    public static (AgentState? State, string? Error) LoadBound(ILocalStateStore store, IDeviceKeyStore keys)
    {
        AgentState? state;
        try
        {
            state = store.Load();
        }
        catch (Exception ex) when (ex is CryptographicException or JsonException)
        {
            return (null, DeviceBindingFailed); // Not decryptable here (DPAPI machine scope) or tampered.
        }

        if (state is null) return (null, null);
        var key = keys.TryOpen();
        return key is not null && key.Thumbprint == state.KeyThumbprint
            ? (state, null)
            : (null, DeviceBindingFailed);
    }
}
