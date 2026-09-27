using CloudBox.Connect.Cloud;
using CloudBox.Connect.Devices;
using CloudBox.Connect.Network;
using CloudBox.Connect.Rdp;

namespace CloudBox.Connect.Tests;

public class DeviceConnectorTests
{
    private static readonly Uri BaseUrl = new("https://box.affinity.ai.in");

    private static ConnectDevice Device(string? lanAddress = "192.168.1.42") =>
        new("dev_1", "Main CloudBox", "MAIN-PC", true, "2026-09-27T10:00:00Z", "active", lanAddress);

    [Fact]
    public async Task A_full_connect_grants_a_session_writes_the_credential_and_launches_mstsc()
    {
        var client = new FakeConnectApiClient();
        var broker = new FakeCredentialBroker();
        var launcher = new FakeProcessLauncher();
        var connector = new DeviceConnector(client, new LanDirect(), new RdpLauncher(broker, launcher));

        var error = await connector.ConnectAsync(BaseUrl, "cbx_session=abc", Device());

        Assert.Null(error);
        Assert.Single(client.SessionCalls);
        Assert.Equal(("cbx_session=abc", "dev_1"), client.SessionCalls[0]);
        Assert.Single(broker.Written);
        Assert.Single(launcher.Launched);
    }

    [Fact]
    public async Task No_lan_address_yet_fails_before_ever_asking_the_cloud_for_a_credential()
    {
        var client = new FakeConnectApiClient();
        var connector = new DeviceConnector(client, new LanDirect(), new RdpLauncher(new FakeCredentialBroker(), new FakeProcessLauncher()));

        var error = await connector.ConnectAsync(BaseUrl, "cbx_session=abc", Device(lanAddress: null));

        Assert.NotNull(error);
        Assert.Empty(client.SessionCalls);
    }

    [Fact]
    public async Task No_free_managed_slot_surfaces_the_same_plain_english_message_as_the_sign_in_flow()
    {
        var client = new FakeConnectApiClient
        {
            OnRequestSession = (_, _) => throw new ConnectApiException(ConnectFailure.NoFreeSlot, "409"),
        };
        var connector = new DeviceConnector(client, new LanDirect(), new RdpLauncher(new FakeCredentialBroker(), new FakeProcessLauncher()));

        var error = await connector.ConnectAsync(BaseUrl, "cbx_session=abc", Device());

        Assert.NotNull(error);
        Assert.Contains("slot", error.ToLowerInvariant());
    }
}
