using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Threading;
using CloudBox.Connect.Cloud;
using CloudBox.Connect.Devices;
using CloudBox.Connect.Network;
using CloudBox.Connect.Rdp;
using CloudBox.Connect.SignIn;
using CloudBox.Connect.State;

namespace CloudBox.Connect;

public partial class MainWindow : Window
{
    private readonly ConnectFlow _flow;
    private readonly DeviceConnector _connector;
    private readonly DispatcherTimer _resendTimer;

    public MainWindow()
    {
        InitializeComponent();

        var http = ConnectApiClient.CreateHttpClient();
        var client = new ConnectApiClient(http);
        var sessionStore = FileSessionStore.CreateDefault();
        _flow = new ConnectFlow(client, sessionStore, new Uri(ConnectPaths.DefaultBaseUrl));
        _connector = new DeviceConnector(client, new LanDirect(), new RdpLauncher(new Win32CredentialBroker(), new RealProcessLauncher()));

        _flow.PropertyChanged += (_, _) => Render();
        _resendTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _resendTimer.Tick += (_, _) => UpdateResendButton();

        Loaded += async (_, _) =>
        {
            if (_flow.IsSignedIn) await _flow.LoadDevicesAsync();
            Render();
        };

        Render();
    }

    private TextBox[] CodeBoxes => [Code1, Code2, Code3, Code4, Code5, Code6];

    // ─── screen 1: tenant + email ───────────────────────────────────────────────────────────

    private async void SendCodeButton_Click(object sender, RoutedEventArgs e)
    {
        _flow.TenantCode = TenantCodeBox.Text;
        _flow.Email = EmailBox.Text;
        await _flow.RequestCodeAsync();
    }

    // ─── screen 2: six-box code ─────────────────────────────────────────────────────────────

    private void CodeBox_TextChanged(object sender, TextChangedEventArgs e)
    {
        var boxes = CodeBoxes;
        var box = (TextBox)sender;
        var index = Array.IndexOf(boxes, box);
        var text = box.Text;

        if (text.Length > 1)
        {
            // A paste landed in one box: distribute its digits across this box and the ones after it
            // (design/ux-patterns.md "paste the whole code into the first box").
            var digits = new string(text.Where(char.IsDigit).ToArray());
            box.TextChanged -= CodeBox_TextChanged;
            box.Text = digits.Length > 0 ? digits[0].ToString() : "";
            box.TextChanged += CodeBox_TextChanged;
            for (var offset = 1; offset < digits.Length && index + offset < boxes.Length; offset++)
            {
                boxes[index + offset].Text = digits[offset].ToString();
            }
            var lastFilled = Math.Min(index + Math.Max(digits.Length, 1) - 1, boxes.Length - 1);
            boxes[lastFilled].Focus();
            boxes[lastFilled].CaretIndex = boxes[lastFilled].Text.Length;
        }
        else if (text.Length == 1 && index < boxes.Length - 1)
        {
            boxes[index + 1].Focus();
            boxes[index + 1].SelectAll();
        }

        MaybeAutoSubmit();
    }

    private void CodeBox_PreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.Back) return;
        var boxes = CodeBoxes;
        var box = (TextBox)sender;
        var index = Array.IndexOf(boxes, box);
        if (box.Text.Length == 0 && index > 0)
        {
            boxes[index - 1].Focus();
            boxes[index - 1].SelectAll();
        }
    }

    private void MaybeAutoSubmit()
    {
        var boxes = CodeBoxes;
        if (!boxes.All(b => b.Text.Length == 1 && char.IsDigit(b.Text[0]))) return;
        var code = string.Concat(boxes.Select(b => b.Text));
        _ = SubmitCodeAsync(code);
    }

    private async Task SubmitCodeAsync(string code)
    {
        // Off-screen honeypot (design/ux-patterns.md): a value here means something other than a
        // human filled the form. The cloud enforces this for real; this is a client-side no-op guard.
        if (!string.IsNullOrEmpty(HoneypotBox.Text)) return;
        await _flow.VerifyAsync(code);
    }

    private async void ResendButton_Click(object sender, RoutedEventArgs e)
    {
        await _flow.ResendCodeAsync();
    }

    private void UpdateResendButton()
    {
        if (_flow.Stage != ConnectStage.Code) return;
        if (_flow.CanResend)
        {
            ResendButton.IsEnabled = true;
            ResendButton.Content = "Resend code";
            return;
        }
        ResendButton.IsEnabled = false;
        var remaining = _flow.ResendAvailableAt - DateTimeOffset.UtcNow;
        var seconds = Math.Max(0, (int)Math.Ceiling(remaining?.TotalSeconds ?? 0));
        ResendButton.Content = $"Resend code ({seconds}s)";
    }

    // ─── screen 3: device list ──────────────────────────────────────────────────────────────

    private async void ConnectButton_Click(object sender, RoutedEventArgs e)
    {
        var button = (Button)sender;
        var deviceId = (string)button.Tag;
        var device = _flow.Devices?.Devices.FirstOrDefault(d => d.DeviceId == deviceId);
        var session = _flow.Session;
        if (device is null || session is null) return;

        button.IsEnabled = false;
        StatusText.Visibility = Visibility.Visible;
        StatusText.Text = $"Connecting to {device.Name}…";
        ErrorText.Visibility = Visibility.Collapsed;
        try
        {
            var error = await _connector.ConnectAsync(_flow.BaseUrl, session.SessionCookie, device);
            if (error is not null)
            {
                ErrorText.Text = error;
                ErrorText.Visibility = Visibility.Visible;
            }
        }
        finally
        {
            StatusText.Visibility = Visibility.Collapsed;
            Render();
        }
    }

    private void SignOutButton_Click(object sender, RoutedEventArgs e)
    {
        _flow.SignOut();
    }

    // ─── rendering ───────────────────────────────────────────────────────────────────────────

    private void Render()
    {
        CredentialsPanel.Visibility = _flow.Stage == ConnectStage.Credentials ? Visibility.Visible : Visibility.Collapsed;
        CodePanel.Visibility = _flow.Stage == ConnectStage.Code ? Visibility.Visible : Visibility.Collapsed;
        DevicesPanel.Visibility = _flow.Stage == ConnectStage.Devices ? Visibility.Visible : Visibility.Collapsed;
        SignOutButton.Visibility = _flow.IsSignedIn ? Visibility.Visible : Visibility.Collapsed;

        if (_flow.Stage == ConnectStage.Credentials)
        {
            SendCodeButton.IsEnabled = !_flow.Busy;
        }

        if (_flow.Stage == ConnectStage.Code)
        {
            if (!_resendTimer.IsEnabled) _resendTimer.Start();
            UpdateResendButton();
        }
        else if (_resendTimer.IsEnabled)
        {
            _resendTimer.Stop();
        }

        if (_flow.Stage == ConnectStage.Devices && _flow.Devices is { } devices)
        {
            DeviceList.ItemsSource = DeviceListPresenter.ToRows(devices).Select(r => new DeviceRowView(r)).ToList();

            var banner = DeviceListPresenter.TenantBanner(devices);
            TenantBannerText.Text = banner ?? "";
            TenantBannerText.Visibility = banner is null ? Visibility.Collapsed : Visibility.Visible;

            NoDevicesText.Text = DeviceListPresenter.NoDevicesMessage;
            NoDevicesText.Visibility = devices.Devices.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        }

        if (_flow.Error is { Length: > 0 })
        {
            ErrorText.Text = _flow.Error;
            ErrorText.Visibility = Visibility.Visible;
        }
        else
        {
            ErrorText.Visibility = Visibility.Collapsed;
        }
    }
}
