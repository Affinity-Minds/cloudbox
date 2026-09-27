namespace CloudBox.Agent.Service;

/// <summary>Read-only status document served on \\.\pipe\CloudBoxAgent and printed by <c>status</c>.</summary>
public sealed record AgentStatusSnapshot
{
    public string Service { get; init; } = "running";
    public string AgentVersion { get; init; } = AgentPaths.AgentVersion;
    public bool Enrolled { get; init; }
    public string? DeviceId { get; init; }
    public string? DeviceName { get; init; }
    public string? TenantCode { get; init; }
    public string? KeyProtection { get; init; }

    /// <summary>connected | network_unavailable | cloud_unavailable | unauthorized | error | not_enrolled | starting</summary>
    public string Cloud { get; init; } = "starting";

    /// <summary>none | DEVICE_BINDING_FAILED | CLOCK_ROLLBACK_SUSPECTED</summary>
    public string Tamper { get; init; } = "none";

    public string? LastError { get; init; }
    public DateTimeOffset? LastHeartbeatAt { get; init; }
    public DateTimeOffset? NextAttemptAt { get; init; }
    public int ConsecutiveFailures { get; init; }
    public int EntitlementGeneration { get; init; }
    public DateTimeOffset? EntitlementFetchedAt { get; init; }
    public DateTimeOffset? TrustedTime { get; init; }
    public DateTimeOffset UpdatedAt { get; init; } = DateTimeOffset.UtcNow;

    // ---- Phase 5 (Server Setup installs): read by CloudBox.Status. Null on an Agent-only install.

    /// <summary>Normalised licence (VALID | OFFLINE_VALID | GRACE | EXPIRED | TAMPER | REVOKED | NO_PLAN).</summary>
    public CloudBox.Agent.Licensing.LicenseSnapshot? License { get; init; }

    /// <summary>open | blocked | not_installed | error.</summary>
    public string? Gate { get; init; }

    public UsersView? Users { get; init; }
    public CloudBox.Agent.Rdp.RdpProbeResult? Rdp { get; init; }

    /// <summary>Private network placeholder until WT-9 (NetBird) lands.</summary>
    public string Network { get; init; } = "not_configured";

    /// <summary>Support-access banner placeholder (break-glass is a later slice).</summary>
    public bool SupportAccessActive { get; init; }

    /// <summary>Public renewal page for the QR code, only while renewal is due. Never a secret.</summary>
    public string? RenewalUrl { get; init; }
}

public sealed class AgentStatus
{
    private AgentStatusSnapshot _current = new();

    public AgentStatusSnapshot Current => Volatile.Read(ref _current);

    public void Set(AgentStatusSnapshot snapshot) => Volatile.Write(ref _current, snapshot);
}
