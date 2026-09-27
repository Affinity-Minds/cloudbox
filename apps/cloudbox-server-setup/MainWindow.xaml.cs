using System.IO;
using System.Net;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using CloudBox.Agent.Cloud;
using CloudBox.Agent.Install;

namespace CloudBox.Server.Setup;

/// <summary>
/// Welcome → Sign in (email → six-box code; new customers through the /start page in WebView2) → Organisation →
/// "Activate this machine as a server for tenant CBX-xxxxx? Are you sure?" → Install (per manifest step) → Summary.
/// </summary>
public partial class MainWindow : Window
{
    private SetupApi? _api;
    private (string TenantId, string TenantCode)? _target;
    private bool _installing;
    private readonly string _webViewData = Path.Combine(Path.GetTempPath(), $"CloudBox.Setup.WebView2-{Guid.NewGuid():N}");
    private readonly Dictionary<string, (TextBlock Glyph, TextBlock Detail)> _rows = [];

    public MainWindow(string baseUrl)
    {
        InitializeComponent();
        BaseUrlBox.Text = baseUrl;
        foreach (var box in Digits())
        {
            box.PreviewTextInput += (_, e) => e.Handled = !e.Text.All(char.IsDigit);
            box.TextChanged += Digit_TextChanged;
            box.PreviewKeyDown += Digit_KeyDown;
            DataObject.AddPastingHandler(box, Digit_Paste);
        }

        FillTimeZones();
        Loaded += (_, _) =>
        {
            var refusal = SetupEngine.Preflight();
            PreflightText.Text = refusal ?? "";
            WelcomeNext.IsEnabled = refusal is null;
        };
        Closing += (_, e) =>
        {
            if (_installing)
            {
                e.Cancel = true;
                MessageBox.Show(this, "Please wait until Setup has finished.", "CloudBox Server Setup");
            }
        };
        Closed += async (_, _) =>
        {
            if (_api is not null) await _api.SignOutAsync();
            _api?.Dispose();
            SetupEngine.ScheduleCleanup(_webViewData);
        };
    }

    private void Show(UIElement panel, string caption)
    {
        foreach (var p in new UIElement[] { WelcomePanel, SignInPanel, OrgPanel, ConfirmPanel, InstallPanel, SummaryPanel })
        {
            p.Visibility = p == panel ? Visibility.Visible : Visibility.Collapsed;
        }

        StepCaption.Text = caption;
        ErrorText.Text = "";
    }

    private void Error(string message) => ErrorText.Text = message;

    private async Task Busy(Button button, Func<Task> action)
    {
        button.IsEnabled = false;
        Cursor = Cursors.Wait;
        ErrorText.Text = "";
        try
        {
            await action();
        }
        catch (SetupApiException ex)
        {
            Error(ex.Message);
        }
        finally
        {
            Cursor = null;
            button.IsEnabled = true;
        }
    }

    // ------------------------------------------------------------------ 1. welcome

    private void WelcomeNext_Click(object sender, RoutedEventArgs e)
    {
        if (!Uri.TryCreate(BaseUrlBox.Text.Trim(), UriKind.Absolute, out var url) ||
            (url.Scheme != Uri.UriSchemeHttps && !url.IsLoopback))
        {
            Error("The CloudBox server address must start with https://");
            return;
        }

        _api?.Dispose();
        _api = new SetupApi(url);
        Show(SignInPanel, "Sign in");
        EmailBox.Focus();
    }

    // ------------------------------------------------------------------ 2. sign in

    private IEnumerable<TextBox> Digits() => DigitsPanel.Children.OfType<TextBox>();

    private string Code() => string.Concat(Digits().Select(d => d.Text));

    private async void SendCode_Click(object sender, RoutedEventArgs e) => await Busy(SendCodeButton, async () =>
    {
        var email = EmailBox.Text.Trim();
        if (!email.Contains('@') || email.Length > 254)
        {
            Error("Enter a valid email address.");
            return;
        }

        switch (await _api!.SendCodeAsync(email, CancellationToken.None))
        {
            case SendCodeResult.Sent:
                CodeSentText.Text = $"If {email} has a CloudBox account, a six-digit code is on its way. Enter it below.";
                CodePanel.Visibility = Visibility.Visible;
                foreach (var d in Digits()) d.Clear();
                Digits().First().Focus();
                break;
            case SendCodeResult.ChallengeRequired:
                Error("CloudBox needs an extra check for this address. Use the secure sign-up page below.");
                await WebSignInAsync();
                break;
            case SendCodeResult.RateLimited:
                Error("Too many codes were requested. Wait a few minutes and try again.");
                break;
            default:
                Error("The code could not be sent. Check the address and your internet connection.");
                break;
        }
    });

    private async void Verify_Click(object sender, RoutedEventArgs e) => await VerifyAsync();

    private async Task VerifyAsync()
    {
        if (Code().Length != 6)
        {
            Error("Enter all six digits.");
            return;
        }

        await Busy(VerifyButton, async () =>
        {
            try
            {
                if (await _api!.VerifyCodeAsync(EmailBox.Text.Trim(), Code(), CancellationToken.None))
                {
                    await LoadOrganisationsAsync();
                    return;
                }
            }
            catch (SetupApiException ex) when (ex.Message == "challenge_required")
            {
                Error("CloudBox needs an extra check for this address. Use the secure sign-up page below.");
                return;
            }

            Error("That code is wrong or has expired. Check the latest email, or send a new code.");
            foreach (var d in Digits()) d.Clear();
            Digits().First().Focus();
        });
    }

    private void Digit_TextChanged(object sender, TextChangedEventArgs e)
    {
        var box = (TextBox)sender;
        if (box.Text.Length != 1) return;
        var all = Digits().ToList();
        var i = all.IndexOf(box);
        if (i < all.Count - 1) all[i + 1].Focus();
        else if (Code().Length == 6) _ = VerifyAsync();
    }

    private void Digit_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.Back) return;
        var box = (TextBox)sender;
        if (box.Text.Length > 0) return;
        var all = Digits().ToList();
        var i = all.IndexOf(box);
        if (i > 0)
        {
            all[i - 1].Clear();
            all[i - 1].Focus();
            e.Handled = true;
        }
    }

    private void Digit_Paste(object sender, DataObjectPastingEventArgs e)
    {
        if (e.DataObject.GetData(typeof(string)) is not string text) return;
        var digits = new string(text.Where(char.IsDigit).ToArray());
        if (digits.Length == 0) return;
        e.CancelCommand();
        var all = Digits().ToList();
        for (var i = 0; i < all.Count; i++) all[i].Text = i < digits.Length ? digits[i].ToString() : "";
    }

    private async void WebSignIn_Click(object sender, RoutedEventArgs e) => await WebSignInAsync();

    private async Task WebSignInAsync()
    {
        var window = new SignInWindow(_api!.BaseUrl, _webViewData) { Owner = this };
        if (window.ShowDialog() != true || window.SessionCookies is not { Count: > 0 } cookies)
        {
            if (window.Failure is not null) Error(window.Failure);
            return;
        }

        _api.ImportCookies(cookies);
        try
        {
            await LoadOrganisationsAsync();
        }
        catch (SetupApiException ex)
        {
            Error(ex.Message);
        }
    }

    // ------------------------------------------------------------------ 3. organisation

    private async Task LoadOrganisationsAsync()
    {
        var overview = await _api!.OverviewAsync(CancellationToken.None);
        TenantList.Items.Clear();
        foreach (var t in overview.Tenants)
        {
            TenantList.Items.Add(new ListBoxItem { Content = t.ToString(), Tag = t, IsEnabled = t.CanActivate });
        }

        var first = TenantList.Items.OfType<ListBoxItem>().FirstOrDefault(i => i.IsEnabled);
        if (first is not null)
        {
            TenantList.SelectedItem = first;
            ExistingOrgRadio.IsChecked = true;
        }
        else
        {
            NewOrgRadio.IsChecked = true;
        }

        Show(OrgPanel, $"Signed in as {overview.Email}");
    }

    private void FillTimeZones()
    {
        var zones = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var tz in TimeZoneInfo.GetSystemTimeZones())
        {
            if (TimeZoneInfo.TryConvertWindowsIdToIanaId(tz.Id, out var iana)) zones.Add(iana);
        }

        foreach (var z in zones) TimeZoneBox.Items.Add(z);
        TimeZoneBox.Text = TimeZoneInfo.TryConvertWindowsIdToIanaId(TimeZoneInfo.Local.Id, out var local) ? local : "UTC";
    }

    private async void OrgNext_Click(object sender, RoutedEventArgs e) => await Busy(OrgNext, async () =>
    {
        if (ExistingOrgRadio.IsChecked == true)
        {
            if ((TenantList.SelectedItem as ListBoxItem)?.Tag is not OnboardingTenant t)
            {
                Error("Choose an organisation, or set up a new one.");
                return;
            }

            _target = (t.TenantId, t.TenantCode);
        }
        else
        {
            var name = OrgNameBox.Text.Trim();
            var zone = TimeZoneBox.Text.Trim();
            if (name.Length == 0 || zone.Length == 0)
            {
                Error("Enter the organisation name and time zone.");
                return;
            }

            var key = LicenceKeyBox.Text.Trim();
            var created = key.Length > 0
                ? await _api!.RedeemAsync(key, name, zone, CancellationToken.None)
                : await _api!.CreateTenantAsync(name, zone, CancellationToken.None);
            _target = (created.TenantId, created.TenantCode);
            LicenceKeyBox.Clear();
        }

        ConfirmQuestion.Text = $"Activate this machine as a server for tenant {_target.Value.TenantCode}? Are you sure?";
        Show(ConfirmPanel, "Confirm");
    });

    private void ConfirmBack_Click(object sender, RoutedEventArgs e) => Show(OrgPanel, "Choose the organisation");

    // ------------------------------------------------------------------ 4–5. activate and install

    private async void ConfirmYes_Click(object sender, RoutedEventArgs e)
    {
        if (_target is not { } target) return;
        ActivationGrant grant;
        ConfirmYes.IsEnabled = false;
        try
        {
            grant = await _api!.ActivationGrantAsync(target.TenantId, Environment.MachineName, CancellationToken.None);
        }
        catch (SetupApiException ex)
        {
            Error(ex.Message);
            ConfirmYes.IsEnabled = true;
            return;
        }

        // The customer session is not needed any more: end it now (the grant is single use, 15 minutes).
        await _api.SignOutAsync();
        await InstallAsync(grant.Grant);
    }

    private async Task InstallAsync(string grant)
    {
        Show(InstallPanel, "Installing");
        BuildStepList();
        _installing = true;
        var progress = new Progress<InstallProgress>(OnProgress);
        var log = new List<string>();
        SetupOutcome outcome;
        try
        {
            outcome = await Task.Run(() => SetupEngine.RunAsync(_api!.BaseUrl, grant, progress, line => { lock (log) log.Add(line); },
                CancellationToken.None));
        }
        catch (Exception ex)
        {
            _installing = false;
            Show(SummaryPanel, "Setup did not finish");
            SummaryTitle.Text = "CloudBox could not be installed";
            SummaryHint.Text = $"Setup stopped unexpectedly: {ex.Message}. Run \"CloudBox.Agent.exe uninstall\" from " +
                               @"C:\Program Files\CloudBox\Agent if it exists, then run Setup again.";
            return;
        }
        finally
        {
            _installing = false;
        }

        ShowSummary(outcome, log);
    }

    private void BuildStepList()
    {
        StepList.Children.Clear();
        _rows.Clear();
        foreach (var step in ServerInstall.Steps)
        {
            var glyph = new TextBlock { Text = "○", Width = 22, Foreground = Brushes.Gray, FontSize = 14 };
            var title = new TextBlock { Text = step.Title, Foreground = new SolidColorBrush(Color.FromRgb(0x0F, 0x17, 0x2A)) };
            var detail = new TextBlock { Foreground = new SolidColorBrush(Color.FromRgb(0x64, 0x74, 0x8B)), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(22, 0, 0, 0), FontSize = 12 };
            var row = new StackPanel { Margin = new Thickness(0, 3, 0, 3) };
            var line = new StackPanel { Orientation = Orientation.Horizontal };
            line.Children.Add(glyph);
            line.Children.Add(title);
            row.Children.Add(line);
            row.Children.Add(detail);
            StepList.Children.Add(row);
            _rows[step.Key] = (glyph, detail);
        }

        InstallProgressBar.Value = 0;
    }

    private void OnProgress(InstallProgress p)
    {
        if (!_rows.TryGetValue(p.Key, out var row)) return;
        (row.Glyph.Text, row.Glyph.Foreground) = p.Status switch
        {
            InstallStepStatus.Running => ("◔", (Brush)Brushes.RoyalBlue),
            InstallStepStatus.Done => ("✓", Brushes.ForestGreen),
            InstallStepStatus.Warning => ("!", Brushes.DarkOrange),
            InstallStepStatus.Failed => ("✗", Brushes.Firebrick),
            _ => ("○", Brushes.Gray),
        };
        row.Detail.Text = p.Detail ?? "";
        if (p.Status is InstallStepStatus.Done or InstallStepStatus.Warning) InstallProgressBar.Value += 1;
    }

    // ------------------------------------------------------------------ 6. summary

    private void ShowSummary(SetupOutcome outcome, List<string> log)
    {
        var r = outcome.Install;
        List<string> lines;
        lock (log) lines = [.. log];
        Show(SummaryPanel, r.Succeeded ? "Done" : "Setup did not finish");
        if (!r.Succeeded)
        {
            SummaryTitle.Text = "CloudBox could not be installed";
            SummaryTenant.Text = _target?.TenantCode ?? "-";
            SummaryDevice.Text = Environment.MachineName;
            SummaryLicence.Text = "-";
            SummaryUsers.Text = "-";
            SummaryRdp.Text = r.Error ?? "";
            SummaryHint.Text = $"Everything Setup changed was rolled back ({outcome.Rollback?.Status}). " +
                               "Fix the problem above and run Setup again; you will need to sign in again." +
                               (lines.Count > 0 ? "\n\n" + string.Join("\n", lines.Take(40)) : "");
            return;
        }

        var e = r.Enrollment!;
        SummaryTitle.Text = "This PC is now a CloudBox server";
        SummaryTenant.Text = e.TenantCode;
        SummaryDevice.Text = e.DeviceName;
        SummaryLicence.Text = Summary.LicenceText(e, r.StatusJson);
        SummaryUsers.Text = Summary.UsersText(r.StatusJson);
        SummaryRdp.Text = Summary.RdpText(r.StatusJson);
        SummaryHint.Text = "Give the Tenant ID to your team: they use it with CloudBox Connect. CloudBox Status shows this " +
                           "server's state at any time. To remove CloudBox, use Apps & Features → CloudBox Server.";
        var warnings = r.Steps.Where(s => s.Status == InstallStepStatus.Warning).Select(s => s.Detail).Distinct().ToList();
        if (warnings.Count > 0) SummaryHint.Text += "\n\nNotes: " + string.Join(" · ", warnings);
    }

    private void Finish_Click(object sender, RoutedEventArgs e) => Close();
}

/// <summary>Plain-language summary lines from the enroll response and the Agent's first status document.</summary>
public static class Summary
{
    private static JsonNode? Parse(string? json)
    {
        try
        {
            return json is null ? null : JsonNode.Parse(json);
        }
        catch (System.Text.Json.JsonException)
        {
            return null;
        }
    }

    private static string? S(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    private static int? I(JsonNode? n) => n is JsonValue v && v.TryGetValue<int>(out var i) ? i : null;

    public static string LicenceText(EnrollResponse e, string? statusJson)
    {
        var lic = Parse(statusJson)?["license"];
        var state = S(lic?["state"]);
        var days = I(lic?["daysRemaining"]);
        return state switch
        {
            "VALID" or "OFFLINE_VALID" => $"Licensed{(days is null ? "" : $" ({days} days remaining)")}",
            "GRACE" => "Licensed (grace period: renew soon)",
            "NO_PLAN" => S(lic?["message"]) ?? e.Message ?? "No active plan found. Please contact the CloudBox admin.",
            "EXPIRED" or "REVOKED" or "TAMPER" => $"{state.ToLowerInvariant()}: remote access is blocked",
            _ => e.LicenseState switch
            {
                "licensed" => "Licensed",
                "no_active_plan" or "device_limit_reached" => e.Message ?? e.LicenseState,
                _ => "Checking (see CloudBox Status)",
            },
        };
    }

    public static string UsersText(string? statusJson)
    {
        var users = Parse(statusJson)?["users"];
        var limit = I(users?["limit"]);
        return limit is null
            ? "Created when the plan is active"
            : $"{I(users?["configured"])?.ToString() ?? "-"} of {limit} ready (cloud01 to cloud{limit:D2})";
    }

    public static string RdpText(string? statusJson)
    {
        var rdp = Parse(statusJson)?["rdp"];
        return S(rdp?["state"]) switch
        {
            "healthy" => "Ready",
            null => "Checking (see CloudBox Status)",
            var s => $"{s}: {S(rdp?["detail"])}",
        };
    }
}
