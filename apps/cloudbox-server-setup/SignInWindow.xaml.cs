// Start-path sign-in hand-off (docs/slices/5.1-server-setup.md "Sign-in hand-off").
//
// New customers (and customers asked for an extra check) sign in on the Worker's own /start page, rendered in WebView2,
// because Turnstile must run in a real browser engine; Setup never re-implements it. Flow:
//   1. WebView2 opens {base}/start (isolated, per-run profile under %TEMP%, deleted after Setup exits).
//   2. When the page's POST /api/auth/start/verify answers 200, the session cookie exists; Setup navigates the WebView
//      to {base}/api/v1/onboarding/setup/complete.
//   3. That Worker page proves the customer session server-side and posts {type:"cloudbox.setup.signed-in", email} to
//      the host via window.chrome.webview.postMessage. Setup accepts the message only from the CloudBox origin.
//   4. Setup reads the HttpOnly session cookie from the WebView2 cookie manager (it never enters page script) and
//      continues natively (organisation, activation grant). Top-level navigation is confined to the CloudBox origin.
using System.Net;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace CloudBox.Server.Setup;

public partial class SignInWindow : Window
{
    public const string SignedInMessage = "cloudbox.setup.signed-in";
    public const string CompletePath = "/api/v1/onboarding/setup/complete";

    private readonly Uri _base;
    private readonly string _origin;
    private readonly string _userData;

    public SignInWindow(Uri baseUrl, string userDataFolder)
    {
        InitializeComponent();
        _base = baseUrl;
        _origin = baseUrl.GetLeftPart(UriPartial.Authority);
        _userData = userDataFolder;
        AddressText.Text = new Uri(_base, "/start").ToString();
        Loaded += async (_, _) => await StartAsync();
    }

    /// <summary>The CloudBox session cookies after a completed sign-in; null otherwise.</summary>
    public List<Cookie>? SessionCookies { get; private set; }

    public string? Failure { get; private set; }

    private bool SameOrigin(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) && string.Equals(u.GetLeftPart(UriPartial.Authority), _origin, StringComparison.OrdinalIgnoreCase);

    private async Task StartAsync()
    {
        try
        {
            var env = await CoreWebView2Environment.CreateAsync(null, _userData);
            await Web.EnsureCoreWebView2Async(env);
        }
        catch (Exception ex) when (ex is WebView2RuntimeNotFoundException or System.Runtime.InteropServices.COMException)
        {
            Web.Visibility = Visibility.Collapsed;
            FallbackText.Visibility = Visibility.Visible;
            FallbackText.Text =
                $"This PC cannot show the CloudBox sign-up page (Microsoft Edge WebView2 is missing). Open {_origin}/start in " +
                "any browser, create your account there, then close this window and sign in to Setup with the same email.";
            Failure = "Create your account in a browser first, then sign in here with the same email.";
            return;
        }

        var core = Web.CoreWebView2;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.NewWindowRequested += (_, e) => e.Handled = true; // No pop-ups.
        core.NavigationStarting += (_, e) =>
        {
            if (!SameOrigin(e.Uri))
            {
                e.Cancel = true; // Top-level navigation stays on CloudBox (Turnstile runs in its own iframe).
                return;
            }

            AddressText.Text = e.Uri;
        };
        core.WebResourceResponseReceived += (_, e) =>
        {
            if (e.Request.Method == "POST" && SameOrigin(e.Request.Uri) &&
                new Uri(e.Request.Uri).AbsolutePath == "/api/auth/start/verify" && e.Response.StatusCode == 200)
            {
                Dispatcher.InvokeAsync(() => core.Navigate(new Uri(_base, CompletePath).ToString()));
            }
        };
        core.WebMessageReceived += async (_, e) =>
        {
            if (!SameOrigin(e.Source)) return;
            try
            {
                using var doc = JsonDocument.Parse(e.WebMessageAsJson);
                if (doc.RootElement.TryGetProperty("type", out var t) && t.GetString() == SignedInMessage)
                {
                    var cookies = await core.CookieManager.GetCookiesAsync(_origin);
                    SessionCookies = cookies.Select(c => c.ToSystemNetCookie()).ToList();
                    DialogResult = SessionCookies.Count > 0;
                }
            }
            catch (JsonException)
            {
                // Not ours.
            }
        };
        core.Navigate(new Uri(_base, "/start").ToString());
    }
}
