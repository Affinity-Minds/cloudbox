using System.IO;
using System.Runtime.InteropServices;
using System.Windows;

namespace CloudBox.Server.Setup;

/// <summary>
/// CloudBox Server Setup. Wizard by default; silent mode for staff-minted codes:
/// <c>CloudBox.Server.Setup.exe /S --enroll-token CBX-ENROLL-XXXX-XXXX [--base-url https://box.affinityminds.in]</c>.
/// </summary>
public partial class App : Application
{
    public const string DefaultBaseUrl = "https://box.affinityminds.in";

    [DllImport("kernel32.dll")]
    private static extern bool AttachConsole(int processId);

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        var args = e.Args;
        if (args.Any(a => a is "/S" or "/s" or "--silent"))
        {
            ShutdownMode = ShutdownMode.OnExplicitShutdown;
            AttachConsole(-1); // Print to the calling console, if any.
            var code = await SilentAsync(args);
            SetupEngine.ScheduleCleanup(null);
            Shutdown(code);
            return;
        }

        var window = new MainWindow(Value(args, "--base-url") ?? DefaultBaseUrl);
        MainWindow = window;
        window.Show();
    }

    private static string? Value(string[] args, string name)
    {
        var i = Array.FindIndex(args, a => string.Equals(a, name, StringComparison.OrdinalIgnoreCase));
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }

    private static async Task<int> SilentAsync(string[] args)
    {
        var logPath = Path.Combine(Path.GetTempPath(), $"CloudBox-Setup-{DateTime.UtcNow:yyyyMMddHHmmss}.log");
        using var logFile = new StreamWriter(logPath) { AutoFlush = true };
        void Log(string line)
        {
            Console.WriteLine(line);
            logFile.WriteLine($"{DateTimeOffset.Now:O} {line}");
        }

        var token = Value(args, "--enroll-token");
        var baseText = Value(args, "--base-url") ?? DefaultBaseUrl;
        if (string.IsNullOrWhiteSpace(token) || !Uri.TryCreate(baseText, UriKind.Absolute, out var baseUrl) ||
            (baseUrl.Scheme != Uri.UriSchemeHttps && !baseUrl.IsLoopback))
        {
            Log("Usage: CloudBox.Server.Setup.exe /S --enroll-token CBX-ENROLL-XXXX-XXXX [--base-url https://box.affinityminds.in]");
            return 2;
        }

        var refusal = SetupEngine.Preflight();
        if (refusal is not null)
        {
            Log(refusal);
            return 1;
        }

        Log($"CloudBox Server Setup {SetupApi.Version}: installing (log: {logPath})");
        var titles = Agent.Install.ServerInstall.Steps.ToDictionary(s => s.Key, s => s.Title);
        var progress = new SyncProgress(p =>
        {
            if (p.Status != Agent.Install.InstallStepStatus.Running)
            {
                Log($"  {p.Status.ToString().ToLowerInvariant(),-8} {titles[p.Key]}{(p.Detail is null ? "" : ": " + p.Detail)}");
            }
        });
        var outcome = await SetupEngine.RunAsync(baseUrl, token, progress, Log, CancellationToken.None);
        if (!outcome.Install.Succeeded)
        {
            Log($"FAILED: {outcome.Install.Error}. Changes were rolled back ({outcome.Rollback?.Status}).");
            return 1;
        }

        var e = outcome.Install.Enrollment!;
        Log($"Activated {e.DeviceName} for tenant {e.TenantCode}. Licence: {Summary.LicenceText(e, outcome.Install.StatusJson)}");
        return 0;
    }
}

/// <summary>Reports synchronously on the calling thread (silent mode has no dispatcher to post to).</summary>
public sealed class SyncProgress(Action<Agent.Install.InstallProgress> report) : IProgress<Agent.Install.InstallProgress>
{
    public void Report(Agent.Install.InstallProgress value) => report(value);
}
