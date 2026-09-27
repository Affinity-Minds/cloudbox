using CloudBox.Connect.Cloud;
using CloudBox.Connect.State;

namespace CloudBox.Connect.SignIn;

public enum ConnectStage
{
    Credentials,
    Code,
    Devices,
}

/// <summary>The whole sign-in + device-list state machine (spec §59: "login → authorized device →
/// Connect"). Plain C# — no WPF types — so it is exercised directly by xUnit against a fake
/// <see cref="IConnectApiClient"/> and a fake <see cref="ISessionStore"/>.</summary>
public sealed class ConnectFlow : ObservableObject
{
    /// <summary>design/ux-patterns.md "One-time codes": 30 s, visible and counting.</summary>
    public static readonly TimeSpan ResendCooldown = TimeSpan.FromSeconds(30);

    private readonly IConnectApiClient _client;
    private readonly ISessionStore _sessionStore;
    private readonly Func<DateTimeOffset> _now;

    public ConnectFlow(IConnectApiClient client, ISessionStore sessionStore, Uri baseUrl, Func<DateTimeOffset>? now = null)
    {
        _client = client;
        _sessionStore = sessionStore;
        _now = now ?? (() => DateTimeOffset.UtcNow);
        BaseUrl = baseUrl;

        var existing = _sessionStore.Load();
        if (existing is not null && existing.BaseUrl == baseUrl.ToString())
        {
            _session = existing;
            _stage = ConnectStage.Devices;
        }
    }

    public Uri BaseUrl { get; }

    private ConnectStage _stage = ConnectStage.Credentials;
    public ConnectStage Stage
    {
        get => _stage;
        private set => SetField(ref _stage, value);
    }

    private string _tenantCode = "";
    public string TenantCode
    {
        get => _tenantCode;
        set => SetField(ref _tenantCode, value);
    }

    private string _email = "";
    public string Email
    {
        get => _email;
        set => SetField(ref _email, value);
    }

    private string? _error;
    public string? Error
    {
        get => _error;
        private set => SetField(ref _error, value);
    }

    private bool _busy;
    public bool Busy
    {
        get => _busy;
        private set => SetField(ref _busy, value);
    }

    private DateTimeOffset? _resendAvailableAt;
    public DateTimeOffset? ResendAvailableAt
    {
        get => _resendAvailableAt;
        private set => SetField(ref _resendAvailableAt, value);
    }

    public bool CanResend => ResendAvailableAt is null || _now() >= ResendAvailableAt;

    private ConnectSession? _session;
    public ConnectSession? Session
    {
        get => _session;
        private set => SetField(ref _session, value);
    }

    private ConnectDevicesResponse? _devices;
    public ConnectDevicesResponse? Devices
    {
        get => _devices;
        private set => SetField(ref _devices, value);
    }

    public bool IsSignedIn => Session is not null;

    /// <summary>Sends the one-time code (always answers success, per contract) and moves to the
    /// code-entry screen. Normalises the tenant ID the way the server does, so a resend and the
    /// eventual verify both use the exact string the user first typed.</summary>
    public async Task<bool> RequestCodeAsync(CancellationToken ct = default)
    {
        TenantCode = TenantCode.Trim().ToUpperInvariant();
        Email = Email.Trim();
        if (TenantCode.Length == 0 || Email.Length == 0)
        {
            Error = "Enter your Tenant ID and email.";
            return false;
        }

        Error = null;
        Busy = true;
        try
        {
            await _client.SendCodeAsync(BaseUrl, TenantCode, Email, ct);
            Stage = ConnectStage.Code;
            ResendAvailableAt = _now() + ResendCooldown;
            return true;
        }
        catch (ConnectApiException ex)
        {
            Error = MessageFor(ex);
            return false;
        }
        finally
        {
            Busy = false;
        }
    }

    /// <summary>Only succeeds once <see cref="CanResend"/> is true; the UI's timer enforces the
    /// visible countdown, but the flow enforces it too so a fast double-click can't burn a second code.</summary>
    public Task<bool> ResendCodeAsync(CancellationToken ct = default) =>
        CanResend ? RequestCodeAsync(ct) : Task.FromResult(false);

    public async Task<bool> VerifyAsync(string code, CancellationToken ct = default)
    {
        Error = null;
        Busy = true;
        try
        {
            var result = await _client.VerifyAsync(BaseUrl, TenantCode, Email, code, ct);
            var session = new ConnectSession(
                BaseUrl.ToString(),
                result.Token,
                result.User.Id,
                result.User.Email,
                result.User.Name,
                result.TenantId,
                result.TenantCode);
            _sessionStore.Save(session);
            Session = session;
            Stage = ConnectStage.Devices;
            await LoadDevicesAsync(ct);
            return true;
        }
        catch (ConnectApiException ex)
        {
            // ADR 0009: a wrong code, unknown tenant/email and a non-member are all identical.
            Error = ex.Failure == ConnectFailure.InvalidCode
                ? "That tenant ID, email or code is not right. Double-check them and try again."
                : MessageFor(ex);
            return false;
        }
        finally
        {
            Busy = false;
        }
    }

    public async Task LoadDevicesAsync(CancellationToken ct = default)
    {
        if (Session is null) return;
        Error = null;
        Busy = true;
        try
        {
            Devices = await _client.ListDevicesAsync(BaseUrl, Session.SessionCookie, ct);
        }
        catch (ConnectApiException ex)
        {
            if (ex.Failure == ConnectFailure.SessionExpired) SignOut();
            Error = MessageFor(ex);
        }
        finally
        {
            Busy = false;
        }
    }

    public void SignOut()
    {
        _sessionStore.Clear();
        Session = null;
        Devices = null;
        Stage = ConnectStage.Credentials;
        Error = null;
    }

    /// <summary>Plain-English text for every distinguishable failure (spec §59: "clear
    /// offline/expired/network errors"). Never a raw exception message or status code.</summary>
    public static string MessageFor(ConnectApiException ex) => ex.Failure switch
    {
        ConnectFailure.NetworkUnavailable => "No network connection. Check your connection and try again.",
        ConnectFailure.CloudUnavailable => "CloudBox is temporarily unavailable. Please try again shortly.",
        ConnectFailure.InvalidCode => "That tenant ID, email or code is not right. Double-check them and try again.",
        ConnectFailure.RateLimited => "Too many attempts. Please try again in a minute.",
        ConnectFailure.SessionExpired => "Your session has expired. Please sign in again.",
        ConnectFailure.Forbidden => "You do not have access to that CloudBox.",
        ConnectFailure.NotFound => "That CloudBox could not be found.",
        ConnectFailure.NoActiveSubscription => "No active plan found. Please contact your CloudBox admin.",
        ConnectFailure.NoFreeSlot => "Every managed user slot on this CloudBox is in use right now. Please try again shortly.",
        ConnectFailure.DeviceNotEnrolled => "This CloudBox is no longer enrolled.",
        _ => "Something went wrong. Please try again.",
    };
}
