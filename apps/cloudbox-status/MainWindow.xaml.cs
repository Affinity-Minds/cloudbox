using System.IO.Pipes;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using QRCoder;

namespace CloudBox.Status;

/// <summary>
/// Appliance-style status window for the parent/console account (spec §13). Reads \\.\pipe\CloudBoxAgent every few
/// seconds (Interactive users have read-only access). Distinguishes licensed slots, active Windows sessions and SaaS
/// members. The renewal QR only ever encodes the public renewal page URL the Agent publishes.
/// </summary>
public partial class MainWindow : Window
{
    private const string PipeName = "CloudBoxAgent";
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(5) };
    private string? _qrFor;

    public MainWindow()
    {
        InitializeComponent();
        _timer.Tick += async (_, _) => await RefreshAsync();
        Loaded += async (_, _) =>
        {
            await RefreshAsync();
            _timer.Start();
        };
    }

    private static string? ReadPipe()
    {
        try
        {
            using var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.In);
            pipe.Connect(2000);
            using var reader = new System.IO.StreamReader(pipe);
            return reader.ReadToEnd();
        }
        catch (Exception ex) when (ex is TimeoutException or System.IO.IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private async Task RefreshAsync()
    {
        var json = await Task.Run(ReadPipe);
        JsonNode? doc = null;
        try
        {
            doc = json is null ? null : JsonNode.Parse(json);
        }
        catch (System.Text.Json.JsonException)
        {
            doc = null;
        }

        Render(doc);
    }

    private static string? S(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    private static int? I(JsonNode? n) => n is JsonValue v && v.TryGetValue<int>(out var i) ? i : null;

    private static bool B(JsonNode? n) => n is JsonValue v && v.TryGetValue<bool>(out var b) && b;

    private static readonly Brush Green = new SolidColorBrush(Color.FromRgb(0x16, 0xA3, 0x4A));
    private static readonly Brush Amber = new SolidColorBrush(Color.FromRgb(0xD9, 0x77, 0x06));
    private static readonly Brush Red = new SolidColorBrush(Color.FromRgb(0xDC, 0x26, 0x26));
    private static readonly Brush Grey = new SolidColorBrush(Color.FromRgb(0x94, 0xA3, 0xB8));

    private void Render(JsonNode? doc)
    {
        Footer.Text = $"Updated {DateTime.Now:HH:mm:ss}";
        if (doc is null)
        {
            SetPill("AGENT STOPPED", Red);
            DeviceName.Text = "CloudBox";
            TenantLine.Text = "The CloudBox Agent is not running. Restart the PC, or contact CloudBox support.";
            SetLicense("Unknown", "", Grey);
            return;
        }

        var enrolled = B(doc["enrolled"]);
        var cloud = S(doc["cloud"]) ?? "starting";
        SetPill(cloud switch
        {
            "connected" => "ONLINE",
            "not_enrolled" => "NOT ACTIVATED",
            "starting" => "STARTING",
            "unauthorized" => "DEACTIVATED",
            _ => "OFFLINE",
        }, cloud == "connected" ? Green : cloud is "starting" ? Grey : Amber);

        DeviceName.Text = S(doc["deviceName"]) ?? "CloudBox";
        TenantLine.Text = enrolled
            ? $"Tenant ID: {S(doc["tenantCode"]) ?? "-"}"
            : "This PC is not activated yet. Run CloudBox Server Setup.";

        RenderLicense(doc["license"]);
        RenderUsers(doc["users"]);
        RenderRdp(doc["rdp"]);
        NetworkState.Text = S(doc["network"]) == "connected" ? "Connected" : "Not configured yet";
        SupportBanner.Visibility = B(doc["supportAccessActive"]) ? Visibility.Visible : Visibility.Collapsed;
        AgentLine.Text = $"Version {S(doc["agentVersion"]) ?? "-"}  •  Cloud: {cloud.Replace('_', ' ')}" +
                         (S(doc["tamper"]) is { } t && t != "none" ? $"  •  {t}" : "");
        RenderQr(S(doc["renewalUrl"]));
    }

    private void RenderLicense(JsonNode? lic)
    {
        var state = S(lic?["state"]);
        var days = I(lic?["daysRemaining"]);
        var grace = I(lic?["graceDaysRemaining"]);
        var message = S(lic?["message"]);
        switch (state)
        {
            case "VALID":
                SetLicense(days is <= 30 ? $"Expires in {days} days" : "Active", days is null ? "" : $"{days} days remaining", days is <= 30 ? Amber : Green);
                break;
            case "OFFLINE_VALID":
                SetLicense("Active (offline)", $"Using the licence stored on this PC. {days} days remaining.", Green);
                break;
            case "GRACE":
                SetLicense("Grace period", $"The licence period has ended. Remote access stops in {grace} days unless it is renewed.", Amber);
                break;
            case "EXPIRED":
                SetLicense("Expired", "Remote access is blocked. This PC and its data are untouched; the local console still works.", Red);
                break;
            case "REVOKED":
                SetLicense("Revoked", "Remote access is blocked. Please contact the CloudBox admin.", Red);
                break;
            case "TAMPER":
                SetLicense("Tamper suspected", "Remote access is blocked until the licence is validated again. Check the PC clock, then contact CloudBox support.", Red);
                break;
            case "NO_PLAN":
                SetLicense("No active plan", message ?? "No active plan found. Please contact the CloudBox admin.", Red);
                break;
            default:
                SetLicense("Checking", "", Grey);
                break;
        }
    }

    private void RenderUsers(JsonNode? users)
    {
        var configured = I(users?["configured"]);
        var limit = I(users?["limit"]);
        var active = I(users?["activeSessions"]);
        UsersConfigured.Text = limit is null ? "Waiting for the licence" : $"Configured: {configured?.ToString() ?? "-"} / {limit}";
        UsersActive.Text = $"Active sessions: {active?.ToString() ?? "unknown"}";
    }

    private void RenderRdp(JsonNode? rdp)
    {
        var state = S(rdp?["state"]);
        RdpState.Text = state switch
        {
            "healthy" => "Healthy",
            "wrapper_missing" => "Not installed",
            "service_stopped" => "Stopped",
            "listener_missing" => "Not accepting connections",
            "unsupported_runtime" => "Unsupported on this Windows version",
            "repair_required" => "Repair required",
            null => "Unknown",
            _ => state,
        };
        RdpDetail.Text = state == "healthy" ? "" : S(rdp?["detail"]) ?? "";
    }

    private void SetLicense(string title, string detail, Brush colour)
    {
        LicenseState.Text = title;
        LicenseDetail.Text = detail;
        LicenseDot.Fill = colour;
    }

    private void SetPill(string text, Brush colour)
    {
        CloudText.Text = text;
        CloudPill.Background = colour;
    }

    private void RenderQr(string? url)
    {
        // Only a public https URL, never an entitlement or credential (spec §33.2).
        if (url is null || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
        {
            RenewPanel.Visibility = Visibility.Collapsed;
            _qrFor = null;
            return;
        }

        if (_qrFor != url)
        {
            using var generator = new QRCodeGenerator();
            using var data = generator.CreateQrCode(url, QRCodeGenerator.ECCLevel.M);
            var png = new PngByteQRCode(data).GetGraphic(8);
            var image = new BitmapImage();
            image.BeginInit();
            image.CacheOption = BitmapCacheOption.OnLoad;
            image.StreamSource = new System.IO.MemoryStream(png);
            image.EndInit();
            image.Freeze();
            RenewQr.Source = image;
            _qrFor = url;
        }

        RenewPanel.Visibility = Visibility.Visible;
    }
}
