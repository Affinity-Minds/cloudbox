using CloudBox.Connect.Cloud;
using CloudBox.Connect.Network;

namespace CloudBox.Connect.Tests;

public class NetworkTests
{
    private static ConnectDevice Device(string? lanAddress) =>
        new("dev_1", "Main CloudBox", "MAIN-PC", true, "2026-09-27T10:00:00Z", "active", lanAddress);

    [Fact]
    public void LanDirect_resolves_the_devices_reported_lan_address()
    {
        var network = new LanDirect();
        Assert.Equal("192.168.1.42", network.ResolveAddress(Device("192.168.1.42")));
    }

    [Fact]
    public void LanDirect_throws_a_plain_english_error_when_no_address_has_been_reported_yet()
    {
        var network = new LanDirect();
        var ex = Assert.Throws<InvalidOperationException>(() => network.ResolveAddress(Device(null)));
        Assert.DoesNotContain("NullReferenceException", ex.Message);
    }

    [Fact]
    public async Task LanDirect_never_needs_to_connect_anything()
    {
        await new LanDirect().EnsureConnectedAsync(CancellationToken.None); // must not throw
    }

    [Fact]
    public async Task NetBirdPlaceholder_always_refuses_because_it_is_not_wired_up_yet()
    {
        var network = new NetBirdPlaceholder();
        await Assert.ThrowsAsync<InvalidOperationException>(() => network.EnsureConnectedAsync(CancellationToken.None));
        Assert.Throws<InvalidOperationException>(() => network.ResolveAddress(Device("192.168.1.42")));
    }
}
