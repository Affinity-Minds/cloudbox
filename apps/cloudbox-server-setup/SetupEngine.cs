// Runs the Agent's ServerInstall plan on this machine for both the wizard and silent mode, and rolls everything back
// through the Agent's Uninstaller when a step fails.
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Security.Principal;
using System.ServiceProcess;
using CloudBox.Agent;
using CloudBox.Agent.Cloud;
using CloudBox.Agent.Identity;
using CloudBox.Agent.Install;
using CloudBox.Agent.ManagedUsers;
using CloudBox.Agent.Rdp;
using CloudBox.Agent.Service;
using CloudBox.Agent.State;
using Microsoft.Win32;

namespace CloudBox.Server.Setup;

/// <summary>Setup's embedded payload (staged by CI from third-party.lock.json and the Agent/Status publish output).</summary>
public static class Payload
{
    private static readonly Assembly Self = typeof(Payload).Assembly;

    private static readonly Dictionary<string, string> Names = Self.GetManifestResourceNames()
        .Where(n => n.StartsWith("payload/", StringComparison.Ordinal))
        .ToDictionary(n => n["payload/".Length..].Replace('\\', '/'), n => n, StringComparer.OrdinalIgnoreCase);

    public static bool Complete =>
        Names.ContainsKey("agent/CloudBox.Agent.exe") && Names.ContainsKey("status/CloudBox.Status.exe") &&
        Names.ContainsKey("vendor/" + RdpWrapperRuntime.ExeName) && Names.ContainsKey("vendor/vc_redist.x64.exe");

    public static Stream? Open(string name) =>
        Names.TryGetValue(name.Replace('\\', '/'), out var resource) ? Self.GetManifestResourceStream(resource) : null;

    public static IReadOnlyList<string> StatusFiles() =>
        Names.Keys.Where(n => n.StartsWith("status/", StringComparison.OrdinalIgnoreCase) && !n[7..].Contains('/'))
            .OrderBy(n => n, StringComparer.OrdinalIgnoreCase).ToList();

    public static string ExtractTo(string name, string folder)
    {
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, Path.GetFileName(name));
        using var source = Open(name) ?? throw new InvalidOperationException($"Payload {name} is missing from this build");
        using var target = File.Create(path);
        source.CopyTo(target);
        return path;
    }
}

public static class Prerequisites
{
    private static readonly string[] SupportedClientEditions =
        ["Professional", "ProfessionalN", "ProfessionalWorkstation", "ProfessionalWorkstationN", "ProfessionalEducation",
         "ProfessionalEducationN", "Enterprise", "EnterpriseN", "EnterpriseS", "EnterpriseSN", "Education", "EducationN",
         "IoTEnterprise", "IoTEnterpriseS"];

    public static PrerequisiteReport Check()
    {
        using var hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        using var cv = hklm.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
        var product = cv?.GetValue("ProductName") as string ?? "Windows";
        var edition = cv?.GetValue("EditionID") as string ?? "";
        var type = cv?.GetValue("InstallationType") as string ?? "";
        var build = cv?.GetValue("CurrentBuild") as string ?? Environment.OSVersion.Version.Build.ToString();
        var os = $"{product} ({edition}, build {build})";
        var tpm = TpmPresent();

        string? refusal = null;
        if (!Environment.Is64BitOperatingSystem) refusal = "CloudBox Server needs 64-bit Windows.";
        else if (Environment.OSVersion.Version.Major < 10) refusal = "CloudBox Server needs Windows 10, Windows 11 or Windows Server.";
        else if (type.Equals("Server", StringComparison.OrdinalIgnoreCase) || type.Equals("Server Core", StringComparison.OrdinalIgnoreCase))
        {
            // Windows Server: supported.
        }
        else if (!SupportedClientEditions.Contains(edition, StringComparer.OrdinalIgnoreCase))
        {
            refusal = $"CloudBox Server needs Windows 10/11 Pro, Enterprise or Education, or Windows Server. This PC runs {product} ({edition}).";
        }

        return new PrerequisiteReport(refusal is null, os, tpm, refusal);
    }

    private static bool TpmPresent()
    {
        try
        {
            // Throws when the Platform Crypto Provider (TPM) is unavailable; false otherwise.
            CngKey.Exists("CloudBox.Setup.TpmProbe", new CngProvider("Microsoft Platform Crypto Provider"), CngKeyOpenOptions.MachineKey);
            return true;
        }
        catch (CryptographicException)
        {
            return false;
        }
    }
}

/// <summary>The real machine behind <see cref="IServerInstallHost"/>.</summary>
public sealed class WindowsInstallHost(IDeviceKeyStore keys, AgentApiClient api) : IServerInstallHost
{
    public PrerequisiteReport CheckPrerequisites() => Prerequisites.Check();

    public DeviceKeyInfo DeviceKey() => keys.TryOpen() ?? throw new InvalidOperationException("Device key was not created");

    public Task<EnrollResponse> EnrollAsync(Uri baseUrl, string token, EnrollDevice device, CancellationToken ct) =>
        api.EnrollAsync(baseUrl, token, device, ct);

    public Task<IReadOnlyList<string>> SigningKeysAsync(Uri baseUrl, string deviceToken, CancellationToken ct) =>
        api.GetSigningKeysAsync(baseUrl, deviceToken, ct);

    public void SaveState(AgentState state) => FileStateStore.CreateDefault().Save(state);

    public void RestartAgentService()
    {
        using var sc = new ServiceController(AgentPaths.ServiceName);
        if (sc.Status is not (ServiceControllerStatus.Stopped or ServiceControllerStatus.StopPending))
        {
            sc.Stop();
            sc.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(60));
        }

        ServiceStep.Start(AgentPaths.ServiceName, TimeSpan.FromSeconds(60));
    }

    public RdpProbeResult ProbeRdp() => RdpWrapperRuntime.CreateDefault().Probe();

    public string? ReadStatus() => StatusPipeServer.TryRead();

    public Task DelayAsync(TimeSpan delay, CancellationToken ct) => Task.Delay(delay, ct);
}

public sealed record SetupOutcome(ServerInstallResult Install, UninstallResult? Rollback);

public static class SetupEngine
{
    /// <summary>Refuses to start on a machine that already has CloudBox (or its leftovers) on it.</summary>
    public static string? Preflight()
    {
        if (!Payload.Complete) return "This build of CloudBox Server Setup has no install payload (developer build).";
        var keys = new CngDeviceKeyStore(AgentPaths.KeyName);
        var runner = new ManifestRunner(WindowsManifestStore.CreateDefault(), WindowsSteps.Create(keys));
        if (runner.Manifest.Entries.Count > 0)
        {
            return "CloudBox is already installed on this PC. Uninstall it from Apps & Features first.";
        }

        var leftovers = runner.Remaining(WellKnown.Entries());
        return leftovers.Count > 0
            ? "CloudBox leftovers were found on this PC. Run \"CloudBox.Agent.exe uninstall\" or remove CloudBox from Apps & Features, then run Setup again."
            : null;
    }

    /// <summary>The parent/console account's SID (the Status app starts at its logon; it is never a managed slot).</summary>
    public static string ParentAccountSid()
    {
        var name = WtsSessions.ConsoleUser();
        try
        {
            return ((SecurityIdentifier)new NTAccount(name).Translate(typeof(SecurityIdentifier))).Value;
        }
        catch (IdentityNotMappedException)
        {
            using var me = WindowsIdentity.GetCurrent();
            return me.User!.Value;
        }
    }

    public static async Task<SetupOutcome> RunAsync(Uri baseUrl, string enrollToken, IProgress<InstallProgress>? progress,
        Action<string>? log, CancellationToken ct)
    {
        var temp = Path.Combine(Path.GetTempPath(), $"CloudBox.Setup-{Guid.NewGuid():N}");
        var keys = new CngDeviceKeyStore(AgentPaths.KeyName);
        var runner = new ManifestRunner(WindowsManifestStore.CreateDefault(), WindowsSteps.Create(keys, Payload.Open));
        using var http = AgentApiClient.CreateHttpClient();
        var api = new AgentApiClient(http);
        try
        {
            var vcRedist = Payload.ExtractTo("vendor/vc_redist.x64.exe", temp);
            var options = new ServerInstallOptions(baseUrl, enrollToken, ParentAccountSid(), vcRedist)
            {
                StatusResources = Payload.StatusFiles(),
            };
            var install = new ServerInstall(runner, new WindowsInstallHost(keys, api), options);
            var result = await install.RunAsync(progress, ct);
            if (result.Succeeded)
            {
                StartStatusForParent(log);
                return new SetupOutcome(result, null);
            }

            log?.Invoke($"Step '{result.FailedStep}' failed: {result.Error}. Rolling back everything this Setup changed...");
            var rollback = await RollbackAsync(runner, api, result.Enrollment, baseUrl);
            foreach (var r in rollback.Results)
            {
                log?.Invoke($"  {r.Outcome.ToString().ToLowerInvariant(),-9} {r.Entry.Kind,-22} {r.Entry.Id}{(r.Error is null ? "" : "  ERROR: " + r.Error)}");
            }

            return new SetupOutcome(result, rollback);
        }
        finally
        {
            try
            {
                if (Directory.Exists(temp)) Directory.Delete(temp, recursive: true);
            }
            catch (IOException)
            {
            }
        }
    }

    private static async Task<UninstallResult> RollbackAsync(ManifestRunner runner, AgentApiClient api, EnrollResponse? enrolled, Uri baseUrl)
    {
        Func<CancellationToken, Task>? notify = enrolled is null
            ? null
            : ct => api.NotifyUninstalledAsync(baseUrl, enrolled.DeviceToken, ct);
        var context = new RevertContext { ProcessPath = Environment.ProcessPath };
        var uninstaller = new Uninstaller(runner, WellKnown.Entries(), TextReader.Null, TextWriter.Null, Environment.MachineName,
            AgentPaths.CustomerDataFolders, notify);
        return await uninstaller.RunAsync(new UninstallOptions(Offline: enrolled is null), context, CancellationToken.None);
    }

    /// <summary>Runs the parent's logon task now so the Status window appears without signing out.</summary>
    private static void StartStatusForParent(Action<string>? log)
    {
        var r = ProcessRunner.Run("schtasks.exe", ["/run", "/tn", AgentPaths.StatusTask]);
        if (r.ExitCode != 0) log?.Invoke("CloudBox Status will open at the next sign-in.");
    }

    /// <summary>
    /// Setup is a downloaded one-file exe: its WPF/WebView2 natives were extracted under %TEMP%\.net\CloudBox.Server.Setup,
    /// and the sign-in WebView2 profile (session cookie) lives in <paramref name="webViewData"/>. Both are removed a few
    /// seconds after Setup exits.
    /// </summary>
    public static void ScheduleCleanup(string? webViewData)
    {
        var paths = new List<string>();
        var extract = Path.Combine(Path.GetTempPath(), ".net", "CloudBox.Server.Setup");
        if (Directory.Exists(extract)) paths.Add(extract);
        if (webViewData is not null && Directory.Exists(webViewData)) paths.Add(webViewData);
        if (paths.Count == 0) return;
        var commands = string.Join(" & ", paths.Select(p => $"rmdir /s /q \"{p}\""));
        var psi = new ProcessStartInfo("cmd.exe", $"/c ping -n 6 127.0.0.1 >nul & {commands}")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetTempPath(),
        };
        Process.Start(psi);
    }
}
