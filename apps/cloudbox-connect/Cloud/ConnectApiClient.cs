using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.NetworkInformation;
using System.Text.Json;

namespace CloudBox.Connect.Cloud;

/// <summary>Every distinguishable way a call can fail, so the UI never collapses everything into
/// one generic "something went wrong" (same discipline as the Agent's CloudApiException, spec §30).</summary>
public enum ConnectFailure
{
    NetworkUnavailable,
    CloudUnavailable,
    /// <summary>CONNECT_INVALID: wrong code, unknown tenant/email, or a non-member — all identical by design.</summary>
    InvalidCode,
    RateLimited,
    /// <summary>Session cookie missing/expired: the stored session must be cleared and the user signed in again.</summary>
    SessionExpired,
    Forbidden,
    NotFound,
    NoActiveSubscription,
    NoFreeSlot,
    DeviceNotEnrolled,
    BadResponse,
}

public sealed class ConnectApiException(ConnectFailure failure, string message, int? status = null, Exception? inner = null)
    : Exception(message, inner)
{
    public ConnectFailure Failure { get; } = failure;
    public int? Status { get; } = status;
}

public interface IConnectApiClient
{
    Task<SendCodeResponse> SendCodeAsync(Uri baseUrl, string tenantCode, string email, CancellationToken ct);

    Task<VerifyResponse> VerifyAsync(Uri baseUrl, string tenantCode, string email, string code, CancellationToken ct);

    Task<ConnectDevicesResponse> ListDevicesAsync(Uri baseUrl, string sessionCookie, CancellationToken ct);

    Task<RdpSessionResponse> RequestSessionAsync(Uri baseUrl, string sessionCookie, string deviceId, CancellationToken ct);
}

/// <summary>Real HTTP implementation. The session cookie is handled explicitly (never a hidden
/// CookieContainer) so exactly one value crosses the DPAPI boundary and nothing else leaks into logs.</summary>
public sealed class ConnectApiClient(HttpClient http, Func<bool>? networkAvailable = null) : IConnectApiClient
{
    private readonly Func<bool> _networkAvailable = networkAvailable ?? NetworkInterface.GetIsNetworkAvailable;

    public static HttpClient CreateHttpClient()
    {
        // UseCookies = false: the session cookie is handled entirely by hand (captured once at
        // verify, sent back explicitly per request) so there is exactly one place it exists in
        // memory — no hidden CookieContainer that could also inject it somewhere unexpected.
        var http = new HttpClient(new SocketsHttpHandler
        {
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            UseCookies = false,
        })
        {
            Timeout = TimeSpan.FromSeconds(30),
        };
        http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("CloudBox.Connect", ConnectPaths.AppVersion));
        return http;
    }

    public async Task<SendCodeResponse> SendCodeAsync(Uri baseUrl, string tenantCode, string email, CancellationToken ct)
    {
        using var req = OriginPost(baseUrl, "/api/auth/connect/send-code", new SendCodeRequest(tenantCode, email));
        using var res = await SendAsync(req, ct);
        if (res.StatusCode == HttpStatusCode.TooManyRequests) throw RateLimited();
        if (!res.IsSuccessStatusCode) throw await FromStatusAsync(res, ct);
        return await ReadAsync<SendCodeResponse>(res, ct);
    }

    public async Task<VerifyResponse> VerifyAsync(Uri baseUrl, string tenantCode, string email, string code, CancellationToken ct)
    {
        using var req = OriginPost(baseUrl, "/api/auth/connect/verify", new VerifyRequest(tenantCode, email, code));
        using var res = await SendAsync(req, ct);
        if (res.StatusCode == HttpStatusCode.TooManyRequests) throw RateLimited();
        if (res.StatusCode == HttpStatusCode.BadRequest)
        {
            // CONNECT_INVALID is the one and only 400 shape on this path (connect.ts).
            throw new ConnectApiException(ConnectFailure.InvalidCode, "Invalid tenant ID, email or code.", 400);
        }
        if (!res.IsSuccessStatusCode) throw await FromStatusAsync(res, ct);

        var body = await ReadAsync<VerifyResponse>(res, ct);
        var cookie = ExtractSessionCookie(res)
            ?? throw new ConnectApiException(ConnectFailure.BadResponse, "Sign-in succeeded but no session cookie was returned.");
        return body with { Token = cookie };
    }

    public async Task<ConnectDevicesResponse> ListDevicesAsync(Uri baseUrl, string sessionCookie, CancellationToken ct)
    {
        using var req = Authed(HttpMethod.Get, baseUrl, "/api/v1/connect/devices", sessionCookie);
        using var res = await SendAsync(req, ct);
        if (!res.IsSuccessStatusCode) throw await FromStatusAsync(res, ct);
        return await ReadAsync<ConnectDevicesResponse>(res, ct);
    }

    public async Task<RdpSessionResponse> RequestSessionAsync(Uri baseUrl, string sessionCookie, string deviceId, CancellationToken ct)
    {
        using var req = Authed(HttpMethod.Post, baseUrl, $"/api/v1/connect/devices/{Uri.EscapeDataString(deviceId)}/session", sessionCookie);
        using var res = await SendAsync(req, ct);
        if (!res.IsSuccessStatusCode) throw await FromStatusAsync(res, ct);
        return await ReadAsync<RdpSessionResponse>(res, ct);
    }

    private static HttpRequestMessage OriginPost<T>(Uri baseUrl, string path, T body)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, new Uri(baseUrl, path))
        {
            Content = JsonContent.Create(body, options: Json.Options),
        };
        // Login-CSRF rule (connect.ts header comment): both auth writes need a same-origin Origin.
        req.Headers.TryAddWithoutValidation("Origin", baseUrl.GetLeftPart(UriPartial.Authority));
        return req;
    }

    private static HttpRequestMessage Authed(HttpMethod method, Uri baseUrl, string path, string sessionCookie)
    {
        var req = new HttpRequestMessage(method, new Uri(baseUrl, path));
        // The verbatim Set-Cookie value captured at verify time (name varies: cbx_session locally,
        // __Secure-cbx_session over https) — never parsed apart or logged.
        req.Headers.TryAddWithoutValidation("Cookie", sessionCookie);
        return req;
    }

    /// <summary>The session cookie's `name=value` pair, verbatim, from a `Set-Cookie` response header.</summary>
    internal static string? ExtractSessionCookie(HttpResponseMessage res)
    {
        if (!res.Headers.TryGetValues("Set-Cookie", out var values)) return null;
        foreach (var value in values)
        {
            var nameValue = value.Split(';', 2)[0].Trim();
            if (nameValue.Contains("session", StringComparison.OrdinalIgnoreCase)) return nameValue;
        }
        return null;
    }

    private async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        try
        {
            return await http.SendAsync(req, ct);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            var network = !_networkAvailable()
                          || ex is HttpRequestException { HttpRequestError: HttpRequestError.NameResolutionError };
            throw network
                ? new ConnectApiException(ConnectFailure.NetworkUnavailable, "No network connection.", inner: ex)
                : new ConnectApiException(ConnectFailure.CloudUnavailable, "CloudBox cloud is unreachable right now.", inner: ex);
        }
    }

    private static ConnectApiException RateLimited() =>
        new(ConnectFailure.RateLimited, "Too many attempts. Please try again in a minute.", 429);

    /// <summary>Reads the `{"error": "..."}` body (worker-api's `ErrorBody`) to distinguish the
    /// several 409s the RDP session broker can return; falls back to a generic message per status.</summary>
    private static async Task<ConnectApiException> FromStatusAsync(HttpResponseMessage res, CancellationToken ct)
    {
        var code = (int)res.StatusCode;
        string? error = null;
        try
        {
            var body = await res.Content.ReadFromJsonAsync<JsonElement>(Json.Options, ct);
            if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("error", out var e))
            {
                error = e.GetString();
            }
        }
        catch (JsonException)
        {
            // No JSON body (or not the expected shape): fall through to the generic per-status message.
        }

        return (code, error) switch
        {
            (401, _) => new ConnectApiException(ConnectFailure.SessionExpired, "Your session has expired. Please sign in again.", 401),
            (403, _) => new ConnectApiException(ConnectFailure.Forbidden, "You do not have access to that CloudBox.", 403),
            (404, _) => new ConnectApiException(ConnectFailure.NotFound, "That CloudBox could not be found.", 404),
            (409, "device_not_enrolled") => new ConnectApiException(ConnectFailure.DeviceNotEnrolled, "This CloudBox is no longer enrolled.", 409),
            (409, "no_active_subscription") => new ConnectApiException(ConnectFailure.NoActiveSubscription, "No active plan found. Please contact the CloudBox admin.", 409),
            (409, "no_free_slot") => new ConnectApiException(ConnectFailure.NoFreeSlot, "Every managed user slot on this CloudBox is in use right now. Please try again shortly.", 409),
            (409, _) => new ConnectApiException(ConnectFailure.NoFreeSlot, "This CloudBox cannot start a session right now.", 409),
            (429, _) => new ConnectApiException(ConnectFailure.RateLimited, "Too many attempts. Please try again in a minute.", 429),
            (>= 500, _) => new ConnectApiException(ConnectFailure.CloudUnavailable, $"CloudBox cloud returned {code}.", code),
            _ => new ConnectApiException(ConnectFailure.BadResponse, $"Unexpected response {code}.", code),
        };
    }

    private static async Task<T> ReadAsync<T>(HttpResponseMessage res, CancellationToken ct)
    {
        try
        {
            return await res.Content.ReadFromJsonAsync<T>(Json.Options, ct)
                   ?? throw new ConnectApiException(ConnectFailure.BadResponse, "Empty response body.");
        }
        catch (JsonException ex)
        {
            throw new ConnectApiException(ConnectFailure.BadResponse, "Malformed response body.", inner: ex);
        }
    }
}
