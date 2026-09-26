using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.NetworkInformation;
using System.Text.Json;

namespace CloudBox.Agent.Cloud;

/// <summary>Spec §30: never collapse failures into "offline".</summary>
public enum CloudFailure
{
    NetworkUnavailable,
    CloudUnavailable,
    InvalidToken,
    AlreadyEnrolled,
    Unauthorized,
    BadResponse,
}

public sealed class CloudApiException(CloudFailure failure, string message, int? status = null, Exception? inner = null)
    : Exception(message, inner)
{
    public CloudFailure Failure { get; } = failure;
    public int? Status { get; } = status;

    /// <summary>Health/status string for the failure.</summary>
    public string State => Failure switch
    {
        CloudFailure.NetworkUnavailable => "network_unavailable",
        CloudFailure.CloudUnavailable => "cloud_unavailable",
        CloudFailure.Unauthorized => "unauthorized",
        _ => "error",
    };
}

public interface IEnrollmentClient
{
    Task<EnrollResponse> EnrollAsync(Uri baseUrl, string token, EnrollDevice device, CancellationToken ct);
}

public interface IHeartbeatClient
{
    Task<HeartbeatResponse> HeartbeatAsync(Uri baseUrl, string deviceToken, AgentHealth health, CancellationToken ct);
}

public interface IEntitlementClient
{
    /// <summary>Null when the cloud has not issued one (404).</summary>
    Task<EntitlementResponse?> GetEntitlementAsync(Uri baseUrl, string deviceToken, CancellationToken ct);
}

public interface IUninstallNotifier
{
    Task NotifyUninstalledAsync(Uri baseUrl, string deviceToken, CancellationToken ct);
}

public sealed class AgentApiClient(HttpClient http, Func<bool>? networkAvailable = null)
    : IEnrollmentClient, IHeartbeatClient, IEntitlementClient, IUninstallNotifier
{
    private readonly Func<bool> _networkAvailable = networkAvailable ?? NetworkInterface.GetIsNetworkAvailable;

    public static HttpClient CreateHttpClient() => new(new SocketsHttpHandler
    {
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
    })
    {
        Timeout = TimeSpan.FromSeconds(30),
    };

    public async Task<EnrollResponse> EnrollAsync(Uri baseUrl, string token, EnrollDevice device, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri(baseUrl, "/api/v1/agent/enroll"))
        {
            Content = JsonContent.Create(new EnrollRequest(token, device), options: Json.Options),
        };
        using var res = await SendAsync(req, ct);
        return res.StatusCode switch
        {
            HttpStatusCode.Created or HttpStatusCode.OK => await ReadAsync<EnrollResponse>(res, Json.Options, ct),
            HttpStatusCode.BadRequest => throw new CloudApiException(CloudFailure.InvalidToken,
                "Enrollment token is invalid, expired or already used. Create a new token on the Enrollment page.", 400),
            HttpStatusCode.Conflict => throw new CloudApiException(CloudFailure.AlreadyEnrolled,
                "This device key is already enrolled.", 409),
            _ => throw FromStatus(res),
        };
    }

    public async Task<HeartbeatResponse> HeartbeatAsync(Uri baseUrl, string deviceToken, AgentHealth health, CancellationToken ct)
    {
        using var req = Authed(HttpMethod.Post, baseUrl, "/api/v1/agent/heartbeat", deviceToken);
        req.Content = JsonContent.Create(new HeartbeatRequest(health), options: Json.Snake);
        using var res = await SendAsync(req, ct);
        if (!res.IsSuccessStatusCode) throw FromStatus(res);
        return await ReadAsync<HeartbeatResponse>(res, Json.Options, ct);
    }

    public async Task<EntitlementResponse?> GetEntitlementAsync(Uri baseUrl, string deviceToken, CancellationToken ct)
    {
        using var req = Authed(HttpMethod.Get, baseUrl, "/api/v1/agent/entitlement", deviceToken);
        using var res = await SendAsync(req, ct);
        if (res.StatusCode == HttpStatusCode.NotFound) return null;
        if (!res.IsSuccessStatusCode) throw FromStatus(res);
        return await ReadAsync<EntitlementResponse>(res, Json.Options, ct);
    }

    public async Task NotifyUninstalledAsync(Uri baseUrl, string deviceToken, CancellationToken ct)
    {
        using var req = Authed(HttpMethod.Post, baseUrl, "/api/v1/agent/uninstalled", deviceToken);
        using var res = await SendAsync(req, ct);
        if (!res.IsSuccessStatusCode) throw FromStatus(res);
    }

    private static HttpRequestMessage Authed(HttpMethod method, Uri baseUrl, string path, string deviceToken)
    {
        var req = new HttpRequestMessage(method, new Uri(baseUrl, path));
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", deviceToken);
        return req;
    }

    private async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        try
        {
            return await http.SendAsync(req, ct);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            throw Classify(ex, _networkAvailable());
        }
    }

    /// <summary>No usable network or no DNS = network unavailable; anything else that fails in transport = cloud unavailable.</summary>
    public static CloudApiException Classify(Exception ex, bool networkAvailable)
    {
        var network = !networkAvailable
                      || ex is HttpRequestException { HttpRequestError: HttpRequestError.NameResolutionError };
        return network
            ? new CloudApiException(CloudFailure.NetworkUnavailable, "Network unavailable: " + ex.Message, inner: ex)
            : new CloudApiException(CloudFailure.CloudUnavailable, "CloudBox cloud unreachable: " + ex.Message, inner: ex);
    }

    private static CloudApiException FromStatus(HttpResponseMessage res)
    {
        var code = (int)res.StatusCode;
        return code switch
        {
            401 or 403 => new CloudApiException(CloudFailure.Unauthorized, "Device credential rejected (revoked or uninstalled).", code),
            >= 500 or 408 or 429 => new CloudApiException(CloudFailure.CloudUnavailable, $"CloudBox cloud returned {code}.", code),
            _ => new CloudApiException(CloudFailure.BadResponse, $"Unexpected response {code}.", code),
        };
    }

    private static async Task<T> ReadAsync<T>(HttpResponseMessage res, JsonSerializerOptions options, CancellationToken ct)
    {
        try
        {
            return await res.Content.ReadFromJsonAsync<T>(options, ct)
                   ?? throw new CloudApiException(CloudFailure.BadResponse, "Empty response body.", (int)res.StatusCode);
        }
        catch (JsonException ex)
        {
            throw new CloudApiException(CloudFailure.BadResponse, "Malformed response body.", (int)res.StatusCode, ex);
        }
    }
}

/// <summary>Health loop cadence: 60 s ± 10 % when healthy; exponential backoff to 15 min with jitter on failure.</summary>
public static class Backoff
{
    public static readonly TimeSpan Interval = TimeSpan.FromSeconds(60);
    public static readonly TimeSpan Max = TimeSpan.FromMinutes(15);

    public static TimeSpan Next(int consecutiveFailures, Random rng)
    {
        var baseSeconds = consecutiveFailures <= 0
            ? Interval.TotalSeconds
            : Math.Min(Max.TotalSeconds, Interval.TotalSeconds * Math.Pow(2, Math.Min(consecutiveFailures, 10)));
        var jitter = 1 + ((rng.NextDouble() * 2) - 1) * 0.1;
        return TimeSpan.FromSeconds(baseSeconds * jitter);
    }
}
