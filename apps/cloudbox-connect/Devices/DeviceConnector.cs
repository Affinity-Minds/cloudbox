using CloudBox.Connect.Cloud;
using CloudBox.Connect.Network;
using CloudBox.Connect.Rdp;
using CloudBox.Connect.SignIn;

namespace CloudBox.Connect.Devices;

/// <summary>The one big Connect button, end to end (spec §28.3):
/// verify SaaS session (already true — the caller only reaches here once signed in) →
/// verify membership/entitlement + mint a credential (`POST .../session`, ADR 0013) →
/// ensure the private network is up → resolve the device's address → launch RDP.
/// No step here ever sees a Netmaker/WireGuard network name or a raw RDP address the user typed.</summary>
public sealed class DeviceConnector(IConnectApiClient client, IPrivateNetwork network, RdpLauncher launcher)
{
    /// <summary>Returns null on success, or a plain-English message on failure — never a raw exception.</summary>
    public async Task<string?> ConnectAsync(Uri baseUrl, string sessionCookie, ConnectDevice device, CancellationToken ct = default)
    {
        try
        {
            await network.EnsureConnectedAsync(ct);
            var address = network.ResolveAddress(device);
            var grant = await client.RequestSessionAsync(baseUrl, sessionCookie, device.DeviceId, ct);
            await launcher.ConnectAsync(address, grant.User, grant.Password, ct);
            return null;
        }
        catch (ConnectApiException ex)
        {
            return ConnectFlow.MessageFor(ex);
        }
        catch (InvalidOperationException ex)
        {
            return ex.Message;
        }
    }
}
