// Slice 5.2: CloudBox-owned adapter around the bundled RDP runtime (sergiye/rdpWrapper 2.15, TermWrap mode; ADR 0012).
// SaaS and UI see only the normalised states below, never upstream file names.
//
// Upstream facts this relies on (verified from the 2.15 source, see docs/runbooks/rdp-runtime.md):
//   * console mode: `rdpWrapper_x64.exe -install -offline` / `-uninstall -offline` (`-offline` last, or it phones home);
//   * it exits 0 even when its OS check fails, and shows a MessageBox when another instance runs: never trust the exit
//     code, kill stray instances first, time out, and verify through the registry;
//   * installed = HKLM\SYSTEM\CurrentControlSet\Services\TermService\Parameters\ServiceDll ends with TermWrap.dll;
//     uninstalled = ServiceDll back to %SystemRoot%\System32\termsrv.dll and C:\Program Files\RDP Wrapper\ removed.
using System.Diagnostics;
using System.Net.NetworkInformation;
using System.ServiceProcess;
using CloudBox.Agent.Install;
using Microsoft.Win32;
using Serilog;

namespace CloudBox.Agent.Rdp;

public static class RdpStates
{
    public const string Healthy = "healthy";
    public const string WrapperMissing = "wrapper_missing";
    public const string ServiceStopped = "service_stopped";
    public const string ListenerMissing = "listener_missing";
    public const string UnsupportedRuntime = "unsupported_runtime";
    public const string RepairRequired = "repair_required";
}

public sealed record RdpProbeResult(string State, bool? Listener, string Detail);

/// <summary>OS seam for the probe (registry, service, listener, files). Faked in tests.</summary>
public interface IRdpSystem
{
    /// <summary>ServiceDll with environment variables expanded; null when the value is missing.</summary>
    string? ServiceDll();

    string? TermServiceImagePath();

    bool TermServiceRunning();

    void StartTermService();

    bool ListenerUp();

    bool FileExists(string path);

    /// <summary>x64 Windows 10/11 or Server; <paramref name="reason"/> explains a refusal.</summary>
    bool OsSupported(out string reason);
}

public interface IRdpRuntime
{
    RdpProbeResult Probe();

    /// <summary>Starts a stopped TermService, or re-runs the runtime install for a missing/damaged wrapper.</summary>
    RdpProbeResult Repair();
}

public static class RdpProbe
{
    public static RdpProbeResult Evaluate(IRdpSystem sys)
    {
        if (!sys.OsSupported(out var reason)) return new(RdpStates.UnsupportedRuntime, null, reason);

        var image = sys.TermServiceImagePath();
        if (image is null) return new(RdpStates.UnsupportedRuntime, null, "Remote Desktop Services (TermService) is not present");
        if (!image.Contains("svchost.exe", StringComparison.OrdinalIgnoreCase))
        {
            return new(RdpStates.UnsupportedRuntime, null, "TermService does not run in svchost.exe");
        }

        var dll = sys.ServiceDll();
        if (string.IsNullOrWhiteSpace(dll)) return new(RdpStates.WrapperMissing, null, "TermService ServiceDll is not set");

        switch (Path.GetFileName(dll).ToLowerInvariant())
        {
            case "termsrv.dll":
                return new(RdpStates.WrapperMissing, null, "Remote session runtime is not installed");
            case "rdpwrap.dll":
                return new(RdpStates.UnsupportedRuntime, null, "A legacy remote session wrapper is installed");
            case "termwrap.dll":
                break;
            default:
                return new(RdpStates.UnsupportedRuntime, null, "A third-party remote session component is installed");
        }

        var folder = Path.GetDirectoryName(dll) ?? "";
        if (!sys.FileExists(dll) || !sys.FileExists(Path.Combine(folder, "zydis.dll")))
        {
            return new(RdpStates.RepairRequired, null,
                "Remote session runtime files are missing (possibly quarantined by antivirus); repair required");
        }

        if (!sys.TermServiceRunning()) return new(RdpStates.ServiceStopped, false, "Remote Desktop Services is stopped");
        return sys.ListenerUp()
            ? new(RdpStates.Healthy, true, "Remote sessions available")
            : new(RdpStates.ListenerMissing, false, "Remote Desktop listener is not accepting connections");
    }
}

public sealed class WindowsRdpSystem : IRdpSystem
{
    private const string ParametersKey = @"SYSTEM\CurrentControlSet\Services\TermService\Parameters";
    private const string ServiceKey = @"SYSTEM\CurrentControlSet\Services\TermService";
    private const string RdpTcpKey = @"SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp";

    private static object? Read(string key, string name)
    {
        using var hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        using var k = hklm.OpenSubKey(key);
        return k?.GetValue(name);
    }

    public string? ServiceDll() => Read(ParametersKey, "ServiceDll") is string s ? Environment.ExpandEnvironmentVariables(s) : null;

    public string? TermServiceImagePath() => Read(ServiceKey, "ImagePath") as string;

    public bool TermServiceRunning()
    {
        try
        {
            using var sc = new ServiceController("TermService");
            return sc.Status == ServiceControllerStatus.Running;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    public void StartTermService() => ServiceStep.Start("TermService", TimeSpan.FromSeconds(60));

    public bool ListenerUp()
    {
        var port = Read(RdpTcpKey, "PortNumber") is int p and > 0 ? p : 3389;
        return IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners().Any(e => e.Port == port);
    }

    public bool FileExists(string path) => File.Exists(path);

    public bool OsSupported(out string reason)
    {
        reason = "";
        if (!Environment.Is64BitOperatingSystem)
        {
            reason = "64-bit Windows is required";
            return false;
        }

        if (Environment.OSVersion.Version.Major < 10)
        {
            reason = "Windows 10, Windows 11 or Windows Server is required";
            return false;
        }

        return true;
    }
}

/// <summary>Drives the bundled runtime unattended. Used by Setup (install), uninstall and <c>repair</c>.</summary>
public sealed class RdpWrapperRuntime(IRdpSystem sys, string vendorExe, TimeSpan? timeout = null) : IRdpRuntime
{
    public const string ExeName = "rdpWrapper_x64.exe";

    private readonly ILogger _log = Log.ForContext<RdpWrapperRuntime>();
    private readonly TimeSpan _timeout = timeout ?? TimeSpan.FromSeconds(120);

    /// <summary>Where upstream extracts TermWrap.dll (Defender exclusion target).</summary>
    public static string WrapperDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "RDP Wrapper");

    public static string VendorDir => Path.Combine(AgentPaths.ProgramFilesRoot, "vendor");
    public static string DefaultVendorExe => Path.Combine(VendorDir, ExeName);

    public static RdpWrapperRuntime CreateDefault() => new(new WindowsRdpSystem(), DefaultVendorExe);

    public RdpProbeResult Probe() => RdpProbe.Evaluate(sys);

    public static bool WrapperActive(IRdpSystem sys) =>
        string.Equals(Path.GetFileName(sys.ServiceDll() ?? ""), "TermWrap.dll", StringComparison.OrdinalIgnoreCase);

    /// <summary>True while the runtime is installed or its folder still exists (manifest presence probe).</summary>
    public bool Present() => WrapperActive(sys) || Directory.Exists(WrapperDir);

    public void Install()
    {
        Run("-install");
        if (!WaitFor(() => WrapperActive(sys) && sys.FileExists(sys.ServiceDll()!) && sys.TermServiceRunning(), TimeSpan.FromSeconds(30)))
        {
            var probe = Probe();
            throw new InvalidOperationException(
                $"The remote session runtime did not install ({probe.State}: {probe.Detail}). The runtime refuses unsupported " +
                $"Windows builds without an error code, and antivirus can quarantine it; see {Path.Combine(Path.GetDirectoryName(vendorExe)!, "*.log")}.");
        }
    }

    public void Uninstall()
    {
        Run("-uninstall");
        var restored = WaitFor(() =>
            string.Equals(Path.GetFileName(sys.ServiceDll() ?? ""), "termsrv.dll", StringComparison.OrdinalIgnoreCase),
            TimeSpan.FromSeconds(30));
        if (!restored)
        {
            throw new InvalidOperationException("TermService ServiceDll was not restored to termsrv.dll by the runtime uninstaller");
        }

        if (!sys.TermServiceRunning())
        {
            try
            {
                sys.StartTermService();
            }
            catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception or System.ServiceProcess.TimeoutException)
            {
                _log.Warning("TermService did not restart after the runtime was removed: {Error}", ex.Message);
            }
        }
    }

    public RdpProbeResult Repair()
    {
        var before = Probe();
        switch (before.State)
        {
            case RdpStates.ServiceStopped:
                sys.StartTermService();
                break;
            case RdpStates.WrapperMissing or RdpStates.RepairRequired:
                if (!File.Exists(vendorExe))
                {
                    return before with { Detail = before.Detail + ". The runtime package is missing: run CloudBox Server Setup again." };
                }

                Install();
                break;
        }

        return Probe();
    }

    private void Run(string verb)
    {
        if (!File.Exists(vendorExe)) throw new FileNotFoundException("Remote session runtime package not found", vendorExe);
        KillStrayInstances();
        try
        {
            // Exit code deliberately ignored (see header); the registry decides.
            var r = ProcessRunner.Run(vendorExe, [verb, "-offline"], (int)_timeout.TotalMilliseconds);
            _log.Information("RDP runtime {Verb} exited {Code}: {Output}", verb, r.ExitCode, r.Output.Trim());
        }
        catch (System.TimeoutException)
        {
            _log.Warning("RDP runtime {Verb} did not exit within {Timeout}; verifying the result anyway", verb, _timeout);
            KillStrayInstances();
        }
    }

    private void KillStrayInstances()
    {
        foreach (var name in new[] { Path.GetFileNameWithoutExtension(vendorExe), "rdpWrapper", "rdpWrapper_x64" }.Distinct())
        {
            foreach (var p in Process.GetProcessesByName(name))
            {
                using (p)
                {
                    try
                    {
                        p.Kill(entireProcessTree: true);
                        p.WaitForExit(5000);
                    }
                    catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
                    {
                        // Already gone.
                    }
                }
            }
        }
    }

    private static bool WaitFor(Func<bool> condition, TimeSpan limit)
    {
        var until = DateTime.UtcNow + limit;
        while (true)
        {
            if (condition()) return true;
            if (DateTime.UtcNow >= until) return false;
            Thread.Sleep(1000);
        }
    }
}
