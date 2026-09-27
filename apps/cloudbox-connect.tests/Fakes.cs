using CloudBox.Connect.Cloud;
using CloudBox.Connect.Rdp;
using CloudBox.Connect.State;

namespace CloudBox.Connect.Tests;

/// <summary>In-memory <see cref="IConnectApiClient"/>: every call is scripted or recorded, so tests
/// never touch the network (agent-notes coding-agent-instructions: fakes, not a live server).</summary>
public sealed class FakeConnectApiClient : IConnectApiClient
{
    public List<(string TenantCode, string Email)> SendCodeCalls { get; } = [];
    public List<(string TenantCode, string Email, string Code)> VerifyCalls { get; } = [];
    public List<string> ListDevicesCookies { get; } = [];
    public List<(string Cookie, string DeviceId)> SessionCalls { get; } = [];

    public Func<string, string, Task<SendCodeResponse>>? OnSendCode;
    public Func<string, string, string, Task<VerifyResponse>>? OnVerify;
    public Func<string, Task<ConnectDevicesResponse>>? OnListDevices;
    public Func<string, string, Task<RdpSessionResponse>>? OnRequestSession;

    public Task<SendCodeResponse> SendCodeAsync(Uri baseUrl, string tenantCode, string email, CancellationToken ct)
    {
        SendCodeCalls.Add((tenantCode, email));
        return OnSendCode?.Invoke(tenantCode, email) ?? Task.FromResult(new SendCodeResponse(true));
    }

    public Task<VerifyResponse> VerifyAsync(Uri baseUrl, string tenantCode, string email, string code, CancellationToken ct)
    {
        VerifyCalls.Add((tenantCode, email, code));
        return OnVerify?.Invoke(tenantCode, email, code)
            ?? Task.FromResult(new VerifyResponse("cbx_session=test-cookie", new ConnectUser("usr_1", email, "Test User"), "ten_1", tenantCode));
    }

    public Task<ConnectDevicesResponse> ListDevicesAsync(Uri baseUrl, string sessionCookie, CancellationToken ct)
    {
        ListDevicesCookies.Add(sessionCookie);
        return OnListDevices?.Invoke(sessionCookie)
            ?? Task.FromResult(new ConnectDevicesResponse("ten_1", "CBX-00001", "Test Org", new TenantPlanState("active", null), []));
    }

    public Task<RdpSessionResponse> RequestSessionAsync(Uri baseUrl, string sessionCookie, string deviceId, CancellationToken ct)
    {
        SessionCalls.Add((sessionCookie, deviceId));
        return OnRequestSession?.Invoke(sessionCookie, deviceId)
            ?? Task.FromResult(new RdpSessionResponse(deviceId, "cloud01", "test-password", DateTimeOffset.UtcNow.AddMinutes(15).ToString("O")));
    }
}

public sealed class FakeSessionStore : ISessionStore
{
    public ConnectSession? Stored { get; private set; }
    public int SaveCount { get; private set; }
    public int ClearCount { get; private set; }

    public ConnectSession? Load() => Stored;

    public void Save(ConnectSession session)
    {
        Stored = session;
        SaveCount++;
    }

    public void Clear()
    {
        Stored = null;
        ClearCount++;
    }
}

public sealed class FakeCredentialBroker : ICredentialBroker
{
    public List<(string Target, string Username, string Password)> Written { get; } = [];
    public List<string> Deleted { get; } = [];

    public void Write(string target, string username, string password) => Written.Add((target, username, password));

    public void Delete(string target) => Deleted.Add(target);
}

public sealed class FakeProcessLauncher : IProcessLauncher
{
    public List<(string FileName, IReadOnlyList<string> Arguments)> Launched { get; } = [];
    public int ExitCode { get; set; }
    public Exception? ThrowOnLaunch { get; set; }

    public Task<int> LaunchAndWaitAsync(string fileName, IReadOnlyList<string> arguments, CancellationToken ct)
    {
        Launched.Add((fileName, arguments));
        if (ThrowOnLaunch is not null) throw ThrowOnLaunch;
        return Task.FromResult(ExitCode);
    }
}
