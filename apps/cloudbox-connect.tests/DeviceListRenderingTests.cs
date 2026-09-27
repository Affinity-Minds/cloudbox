using CloudBox.Connect.Cloud;
using CloudBox.Connect.Devices;

namespace CloudBox.Connect.Tests;

public class DeviceListRenderingTests
{
    private static ConnectDevice Device(bool online = true, string licenseState = "active", string? lanAddress = "192.168.1.42") =>
        new("dev_1", "Main CloudBox", "MAIN-PC", online, online ? "2026-09-27T10:00:00Z" : "2026-09-27T08:00:00Z", licenseState, lanAddress);

    [Fact]
    public void An_online_fully_licensed_device_has_nothing_to_explain_and_can_connect()
    {
        var row = DeviceListPresenter.ToRow(Device());

        Assert.Equal("Online", row.OnlinePill);
        Assert.True(row.Online);
        Assert.Equal("", row.Explanation);
        Assert.True(row.CanConnect);
    }

    [Fact]
    public void An_offline_device_explains_offline_plainly_and_cannot_connect()
    {
        var row = DeviceListPresenter.ToRow(Device(online: false));

        Assert.Equal("Offline", row.OnlinePill);
        Assert.False(row.Online);
        Assert.Contains("Offline", row.Explanation);
        Assert.False(row.CanConnect);
    }

    [Fact]
    public void A_device_with_no_active_plan_says_so_and_cannot_connect_even_while_online()
    {
        var row = DeviceListPresenter.ToRow(Device(licenseState: "none"));

        Assert.True(row.Online);
        Assert.Contains("No active plan", row.Explanation);
        Assert.False(row.CanConnect);
    }

    [Fact]
    public void A_device_with_an_expired_licence_says_so_and_cannot_connect()
    {
        var row = DeviceListPresenter.ToRow(Device(licenseState: "expired"));

        Assert.Contains("expired", row.Explanation.ToLowerInvariant());
        Assert.False(row.CanConnect);
    }

    [Fact]
    public void An_offline_device_with_no_plan_explains_both()
    {
        var row = DeviceListPresenter.ToRow(Device(online: false, licenseState: "none"));

        Assert.Contains("Offline", row.Explanation);
        Assert.Contains("No active plan", row.Explanation);
    }

    [Fact]
    public void No_devices_gets_an_honest_empty_state_pointing_at_the_admin()
    {
        Assert.Contains("admin", DeviceListPresenter.NoDevicesMessage.ToLowerInvariant());
    }

    [Fact]
    public void The_tenant_banner_appears_only_when_the_plan_state_is_no_active_plan()
    {
        var noPlan = new ConnectDevicesResponse("ten_1", "CBX-00001", "Org", new TenantPlanState("no_active_plan", "No active plan found. Please contact the CloudBox admin."), []);
        var active = new ConnectDevicesResponse("ten_1", "CBX-00001", "Org", new TenantPlanState("active", null), []);

        Assert.NotNull(DeviceListPresenter.TenantBanner(noPlan));
        Assert.Null(DeviceListPresenter.TenantBanner(active));
    }
}
