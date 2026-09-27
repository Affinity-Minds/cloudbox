// Customer-surface calls made by Setup (exact contract: docs/slices/2.6-self-onboarding.md "Setup app (WT-10) call
// sequence"). Every POST carries Origin = the CloudBox origin (the customer auth writes refuse anything else) and the
// customer session cookie is kept in this client's cookie jar only. Codes, licence keys, grants and cookies are never
// logged.
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CloudBox.Server.Setup;

public sealed record OnboardingPlan(string State, string? PlanName, string? Message);

public sealed record OnboardingTenant(
    string TenantId, string TenantCode, string DisplayName, string TenantStatus, string Standing, int EnrolledDevices, OnboardingPlan Plan)
{
    public bool CanActivate => Standing is "owner" or "admin";

    public override string ToString() =>
        $"{TenantCode}  {DisplayName}  ({Plan.State.Replace('_', ' ')}{(CanActivate ? "" : ", you are not an Owner/Admin")})";
}

public sealed record OnboardingOverview(string Email, IReadOnlyList<OnboardingTenant> Tenants);

public sealed record CreatedTenant(string TenantId, string TenantCode);

public sealed record ActivationGrant(string Grant, string TenantId, string TenantCode, DateTimeOffset ExpiresAt);

public enum SendCodeResult
{
    Sent,
    ChallengeRequired,
    RateLimited,
    Failed,
}

public sealed class SetupApiException(string message, int? status = null) : Exception(message)
{
    public int? Status { get; } = status;
}

public sealed class SetupApi : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly HttpClient _http;
    private readonly CookieContainer _cookies = new();
    private readonly string _origin;

    public SetupApi(Uri baseUrl)
    {
        BaseUrl = new Uri(baseUrl.GetLeftPart(UriPartial.Authority));
        _origin = BaseUrl.GetLeftPart(UriPartial.Authority);
        _http = new HttpClient(new SocketsHttpHandler { CookieContainer = _cookies, UseCookies = true, AllowAutoRedirect = false })
        {
            BaseAddress = BaseUrl,
            Timeout = TimeSpan.FromSeconds(30),
        };
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("CloudBox.Server.Setup", Version));
    }

    public static string Version { get; } =
        typeof(SetupApi).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

    public Uri BaseUrl { get; }

    /// <summary>Session cookies lifted from the WebView2 start-path sign-in (never exposed to page script).</summary>
    public void ImportCookies(IEnumerable<Cookie> cookies)
    {
        foreach (var c in cookies) _cookies.Add(BaseUrl, c);
    }

    public void ClearCookies()
    {
        foreach (Cookie c in _cookies.GetCookies(BaseUrl)) c.Expired = true;
    }

    private HttpRequestMessage Post(string path, object body)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, path) { Content = JsonContent.Create(body, options: JsonOptions) };
        req.Headers.TryAddWithoutValidation("Origin", _origin);
        return req;
    }

    private async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        try
        {
            return await _http.SendAsync(req, ct);
        }
        catch (HttpRequestException ex)
        {
            throw new SetupApiException($"Could not reach {BaseUrl.Host}: {ex.Message}");
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new SetupApiException($"{BaseUrl.Host} did not answer in time");
        }
    }

    private static async Task<string?> ErrorCode(HttpResponseMessage res, CancellationToken ct)
    {
        try
        {
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
            foreach (var name in new[] { "error", "code" })
            {
                if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty(name, out var v) &&
                    v.ValueKind == JsonValueKind.String)
                {
                    return v.GetString();
                }
            }
        }
        catch (JsonException)
        {
        }

        return null;
    }

    // ------------------------------------------------------------------ sign in (existing customers)

    public async Task<SendCodeResult> SendCodeAsync(string email, CancellationToken ct)
    {
        using var req = Post("/api/auth/email-otp/send-verification-otp", new { email, type = "sign-in" });
        using var res = await SendAsync(req, ct);
        if (res.IsSuccessStatusCode) return SendCodeResult.Sent;
        var code = await ErrorCode(res, ct);
        return (int)res.StatusCode switch
        {
            403 when code == "challenge_required" => SendCodeResult.ChallengeRequired,
            429 => SendCodeResult.RateLimited,
            _ => SendCodeResult.Failed,
        };
    }

    /// <summary>True when the code signed the address in (session cookie set).</summary>
    public async Task<bool> VerifyCodeAsync(string email, string code, CancellationToken ct)
    {
        using var req = Post("/api/auth/sign-in/email-otp", new { email, otp = code });
        using var res = await SendAsync(req, ct);
        if (res.IsSuccessStatusCode) return true;
        if ((int)res.StatusCode == 403 && await ErrorCode(res, ct) == "challenge_required")
        {
            throw new SetupApiException("challenge_required", 403);
        }

        if ((int)res.StatusCode == 429) throw new SetupApiException("Too many attempts. Wait a few minutes and try again.", 429);
        return false;
    }

    public async Task SignOutAsync()
    {
        try
        {
            using var req = Post("/api/auth/sign-out", new { });
            using var res = await SendAsync(req, CancellationToken.None);
        }
        catch (SetupApiException)
        {
            // Best effort.
        }
    }

    // ------------------------------------------------------------------ organisation and activation

    public async Task<OnboardingOverview> OverviewAsync(CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/v1/onboarding/overview");
        using var res = await SendAsync(req, ct);
        if (res.StatusCode == HttpStatusCode.Unauthorized) throw new SetupApiException("Your sign-in has ended. Sign in again.", 401);
        if (!res.IsSuccessStatusCode) throw new SetupApiException($"Could not load your organisations ({(int)res.StatusCode}).", (int)res.StatusCode);
        return await res.Content.ReadFromJsonAsync<OnboardingOverview>(JsonOptions, ct)
               ?? throw new SetupApiException("Empty response");
    }

    public Task<CreatedTenant> CreateTenantAsync(string displayName, string timezone, CancellationToken ct) =>
        CreateAsync("/api/v1/onboarding/tenants", new { displayName, timezone }, ct);

    public Task<CreatedTenant> RedeemAsync(string licenceKey, string displayName, string timezone, CancellationToken ct) =>
        CreateAsync("/api/v1/onboarding/redeem", new { code = licenceKey, displayName, timezone }, ct);

    private async Task<CreatedTenant> CreateAsync(string path, object body, CancellationToken ct)
    {
        using var req = Post(path, body);
        using var res = await SendAsync(req, ct);
        if (res.IsSuccessStatusCode)
        {
            return await res.Content.ReadFromJsonAsync<CreatedTenant>(JsonOptions, ct) ?? throw new SetupApiException("Empty response");
        }

        var code = await ErrorCode(res, ct);
        throw new SetupApiException(code switch
        {
            "invalid_license_key" => "That licence key is not valid, or it has already been used.",
            "tenant_limit_reached" => "You have reached the limit of organisations without a plan. Contact CloudBox.",
            "rate_limited" => "Too many attempts. Wait a few minutes and try again.",
            "invalid_request" => "Check the organisation name and time zone.",
            _ => $"The organisation could not be created ({(int)res.StatusCode} {code}).",
        }, (int)res.StatusCode);
    }

    public async Task<ActivationGrant> ActivationGrantAsync(string tenantId, string deviceLabel, CancellationToken ct)
    {
        using var req = Post("/api/v1/onboarding/activation-grants", new { tenantId, deviceLabel });
        using var res = await SendAsync(req, ct);
        if (res.IsSuccessStatusCode)
        {
            return await res.Content.ReadFromJsonAsync<ActivationGrant>(JsonOptions, ct) ?? throw new SetupApiException("Empty response");
        }

        var code = await ErrorCode(res, ct);
        throw new SetupApiException(code switch
        {
            "forbidden" => "Only an Owner or Admin of this organisation can activate a server.",
            "tenant_not_active" => "This organisation is suspended or archived. Contact CloudBox.",
            "rate_limited" => "Too many activations. Wait a few minutes and try again.",
            _ => $"Activation was refused ({(int)res.StatusCode} {code}).",
        }, (int)res.StatusCode);
    }

    public void Dispose() => _http.Dispose();
}
