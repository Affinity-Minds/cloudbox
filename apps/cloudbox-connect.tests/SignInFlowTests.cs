using CloudBox.Connect.Cloud;
using CloudBox.Connect.SignIn;
using CloudBox.Connect.State;

namespace CloudBox.Connect.Tests;

public class SignInFlowTests
{
    private static readonly Uri BaseUrl = new("https://box.affinityminds.in");

    private static ConnectFlow NewFlow(FakeConnectApiClient client, FakeSessionStore store, Func<DateTimeOffset>? now = null) =>
        new(client, store, BaseUrl, now);

    [Fact]
    public async Task RequestCode_moves_to_code_stage_and_sends_the_normalised_tenant_code()
    {
        var client = new FakeConnectApiClient();
        var flow = NewFlow(client, new FakeSessionStore());
        flow.TenantCode = "  cbx-00001 ";
        flow.Email = " Someone@Example.com ";

        var ok = await flow.RequestCodeAsync();

        Assert.True(ok);
        Assert.Equal(ConnectStage.Code, flow.Stage);
        Assert.Equal(("CBX-00001", "Someone@Example.com"), client.SendCodeCalls[0]);
        Assert.Null(flow.Error);
    }

    [Fact]
    public async Task RequestCode_refuses_empty_fields_without_calling_the_api()
    {
        var client = new FakeConnectApiClient();
        var flow = NewFlow(client, new FakeSessionStore());

        var ok = await flow.RequestCodeAsync();

        Assert.False(ok);
        Assert.Empty(client.SendCodeCalls);
        Assert.NotNull(flow.Error);
    }

    [Fact]
    public async Task Resend_is_blocked_until_the_cooldown_elapses()
    {
        var client = new FakeConnectApiClient();
        var now = DateTimeOffset.UtcNow;
        var flow = NewFlow(client, new FakeSessionStore(), () => now);
        flow.TenantCode = "CBX-00001";
        flow.Email = "a@example.com";
        await flow.RequestCodeAsync();
        Assert.Single(client.SendCodeCalls);

        Assert.False(flow.CanResend);
        var resent = await flow.ResendCodeAsync();
        Assert.False(resent);
        Assert.Single(client.SendCodeCalls); // still one — the cooldown blocked the second call

        now = now + ConnectFlow.ResendCooldown;
        Assert.True(flow.CanResend);
        resent = await flow.ResendCodeAsync();
        Assert.True(resent);
        Assert.Equal(2, client.SendCodeCalls.Count);
    }

    [Fact]
    public async Task Verify_success_persists_the_session_and_loads_devices()
    {
        var client = new FakeConnectApiClient();
        var store = new FakeSessionStore();
        var flow = NewFlow(client, store);
        flow.TenantCode = "CBX-00001";
        flow.Email = "a@example.com";

        var ok = await flow.VerifyAsync("123456");

        Assert.True(ok);
        Assert.Equal(ConnectStage.Devices, flow.Stage);
        Assert.True(flow.IsSignedIn);
        Assert.Equal(1, store.SaveCount);
        Assert.Equal(("CBX-00001", "a@example.com", "123456"), client.VerifyCalls[0]);
        Assert.Single(client.ListDevicesCookies); // the stored cookie was used, without re-parsing it
        Assert.Equal(store.Stored!.SessionCookie, client.ListDevicesCookies[0]);
    }

    [Theory]
    [InlineData(ConnectFailure.InvalidCode)]
    [InlineData(ConnectFailure.RateLimited)]
    public async Task Verify_failure_never_leaks_which_of_tenant_email_or_code_was_wrong(ConnectFailure failure)
    {
        var client = new FakeConnectApiClient
        {
            OnVerify = (_, _, _) => throw new ConnectApiException(failure, "wire message, ignored by the UI"),
        };
        var flow = NewFlow(client, new FakeSessionStore());
        flow.TenantCode = "CBX-00001";
        flow.Email = "a@example.com";

        var ok = await flow.VerifyAsync("000000");

        Assert.False(ok);
        Assert.False(flow.IsSignedIn);
        Assert.NotNull(flow.Error);
        if (failure == ConnectFailure.InvalidCode)
        {
            Assert.DoesNotContain("wire message", flow.Error);
        }
    }

    [Fact]
    public async Task A_session_expiring_while_loading_devices_signs_the_user_back_out()
    {
        var client = new FakeConnectApiClient
        {
            OnListDevices = _ => throw new ConnectApiException(ConnectFailure.SessionExpired, "expired"),
        };
        var store = new FakeSessionStore();
        var flow = NewFlow(client, store);
        flow.TenantCode = "CBX-00001";
        flow.Email = "a@example.com";
        await flow.VerifyAsync("123456"); // succeeds, then the immediate device load 401s

        Assert.False(flow.IsSignedIn);
        Assert.Equal(ConnectStage.Credentials, flow.Stage);
        Assert.Equal(1, store.ClearCount);
        Assert.NotNull(flow.Error);
    }

    [Fact]
    public void An_existing_session_for_the_same_base_url_is_restored_on_startup()
    {
        var store = new FakeSessionStore();
        store.Save(new ConnectSession(
            BaseUrl.ToString(), "cbx_session=abc", "usr_1", "a@example.com", "A", "ten_1", "CBX-00001"));

        var flow = NewFlow(new FakeConnectApiClient(), store);

        Assert.True(flow.IsSignedIn);
        Assert.Equal(ConnectStage.Devices, flow.Stage);
    }

    [Fact]
    public async Task SignOut_clears_the_stored_session_and_returns_to_the_credentials_screen()
    {
        var client = new FakeConnectApiClient();
        var store = new FakeSessionStore();
        var flow = NewFlow(client, store);
        flow.TenantCode = "CBX-00001";
        flow.Email = "a@example.com";
        await flow.VerifyAsync("123456");
        Assert.True(flow.IsSignedIn);

        flow.SignOut();

        Assert.False(flow.IsSignedIn);
        Assert.Equal(ConnectStage.Credentials, flow.Stage);
        Assert.Equal(1, store.ClearCount);
        Assert.Null(store.Stored);
    }
}
