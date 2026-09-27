using CloudBox.Connect.Cloud;

namespace CloudBox.Connect.Network;

/// <summary>Hides "WireGuard, RDP addresses, VPN configs, device IPs" from the user entirely (spec
/// §4.5) behind one small seam: given a device, produce the address `mstsc` should target, after
/// making sure whatever private network gets us there is actually up.</summary>
public interface IPrivateNetwork
{
    /// <summary>Ensures the private network client is connected. A no-op for <see cref="LanDirect"/>.</summary>
    Task EnsureConnectedAsync(CancellationToken ct);

    /// <summary>The address to hand `mstsc` for this device. Never a Netmaker/WireGuard/network name
    /// the user would have to type themselves (spec §28.3).</summary>
    string ResolveAddress(ConnectDevice device);
}

/// <summary>Alpha demo network: both machines on the same LAN, address = the Agent's own reported
/// `network.lan_address` (packages/contracts/src/agent.ts, surfaced additively on `ConnectDevice`).</summary>
public sealed class LanDirect : IPrivateNetwork
{
    public Task EnsureConnectedAsync(CancellationToken ct) => Task.CompletedTask;

    public string ResolveAddress(ConnectDevice device) =>
        device.LanAddress
        ?? throw new InvalidOperationException(
            "This CloudBox has not reported a LAN address yet. Make sure its Agent is running and has recently checked in.");
}

/// <summary>Interface-only placeholder for the private overlay (ADR 0007/§4.6, WT-9's NetBird
/// build-out). Always throws — nothing here is wired to a real controller yet.</summary>
public sealed class NetBirdPlaceholder : IPrivateNetwork
{
    private const string NotConfigured = "NetBird private network is not configured.";

    public Task EnsureConnectedAsync(CancellationToken ct) =>
        throw new InvalidOperationException(NotConfigured);

    public string ResolveAddress(ConnectDevice device) =>
        throw new InvalidOperationException(NotConfigured);
}
