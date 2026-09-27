using System.Text.Json.Serialization;

namespace CloudBox.Connect.Cloud;

// Mirrors packages/contracts/src/connect.ts exactly (field-for-field; camelCase on the wire). This
// file has no logic — it is the C# shape of the fixed contract WT-14 built, plus WT-11's own
// additions (lanAddress, the RDP session broker) documented in that same file.

public sealed record SendCodeRequest(string TenantCode, string Email);

/// <summary>Always `{"success":true}` — see connect.ts: unknown tenant/email look identical.</summary>
public sealed record SendCodeResponse(bool Success);

public sealed record VerifyRequest(string TenantCode, string Email, string Code);

public sealed record ConnectUser(string Id, string Email, string Name);

public sealed record VerifyResponse(string Token, ConnectUser User, string TenantId, string TenantCode);

/// <summary>The exact body CONNECT_INVALID sends for any failure (connect.ts) — wrong code, unknown
/// tenant, unknown email, non-member are all indistinguishable, by design (ADR 0009/0011).</summary>
public sealed record ConnectErrorBody(string? Code, string? Message, string? Error);

public sealed record TenantPlanState(
    [property: JsonPropertyName("state")] string State,
    string? Message
);

public sealed record ConnectDevice(
    string DeviceId,
    string Name,
    string Hostname,
    bool Online,
    string? LastSeenAt,
    /// <summary>`none` | `active` | `expired` (packages/contracts/src/devices.ts LicenseState).</summary>
    string LicenseState,
    /// <summary>WT-11 additive: the Agent's last reported LAN address, or null.</summary>
    string? LanAddress
);

public sealed record ConnectDevicesResponse(
    string TenantId,
    string TenantCode,
    string TenantName,
    TenantPlanState Plan,
    IReadOnlyList<ConnectDevice> Devices
);

/// <summary>`POST /connect/devices/:deviceId/session` (ADR 0013). `Password` is returned exactly
/// once — the caller must hand it to Windows Credential Manager immediately and never log it.</summary>
public sealed record RdpSessionResponse(string DeviceId, string User, string Password, string ExpiresAt);
