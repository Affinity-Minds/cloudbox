// Component handlers for Server Setup (Slice 5.1). Each is a manifest `third_party_component` entry.
using System.Text.Json.Nodes;
using Microsoft.Win32;

namespace CloudBox.Agent.Install;

/// <summary>
/// Microsoft Defender path exclusion, id <c>defender-exclusion:&lt;path&gt;</c>. Added BEFORE the RDP runtime extracts
/// its DLLs so Defender cannot quarantine them mid-install. No-op when Defender is not the active antivirus.
/// </summary>
public sealed class DefenderExclusionComponent : IComponentHandler
{
    public const string Prefix = "defender-exclusion:";

    public static string IdFor(string path) => Prefix + Path.TrimEndingDirectorySeparator(path);

    public bool Handles(string id) => id.StartsWith(Prefix, StringComparison.Ordinal);

    private static string PathOf(string id) => id[Prefix.Length..];

    private static bool DefenderActive()
    {
        try
        {
            using var sc = new System.ServiceProcess.ServiceController("WinDefend");
            return sc.Status == System.ServiceProcess.ServiceControllerStatus.Running;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    private static ProcessRunner.Result Ps(string command) =>
        ProcessRunner.Run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command]);

    private static string Quote(string path) => "'" + path.Replace("'", "''") + "'";

    public bool Present(string id, JsonObject? spec)
    {
        if (!DefenderActive()) return false;
        var r = Ps("(Get-MpPreference).ExclusionPath");
        var want = Path.TrimEndingDirectorySeparator(PathOf(id));
        return r.ExitCode == 0 && r.Output.Split('\n')
            .Select(l => Path.TrimEndingDirectorySeparator(l.Trim()))
            .Any(l => string.Equals(l, want, StringComparison.OrdinalIgnoreCase));
    }

    public void Install(string id, JsonObject? spec)
    {
        if (!DefenderActive()) return;
        var r = Ps($"Add-MpPreference -ExclusionPath {Quote(PathOf(id))}");
        if (r.ExitCode != 0) throw new InvalidOperationException($"Could not add the Defender exclusion for {PathOf(id)}: {r.Output.Trim()}");
    }

    public void Uninstall(string id, JsonObject? spec)
    {
        if (!DefenderActive()) return;
        var r = Ps($"Remove-MpPreference -ExclusionPath {Quote(PathOf(id))}");
        if (r.ExitCode != 0) throw new InvalidOperationException($"Could not remove the Defender exclusion for {PathOf(id)}: {r.Output.Trim()}");
    }
}

/// <summary>
/// Microsoft Visual C++ 2015–2022 x64 runtime (TermWrap needs it), id <c>vcredist-x64</c>; spec: { installer }.
/// Shared with other software, so it is retained on uninstall (reported "restored"; see docs/runbooks/rdp-runtime.md).
/// </summary>
public sealed class VcRedistComponent : IComponentHandler
{
    public const string Id = "vcredist-x64";

    /// <summary>Oldest runtime accepted as-is (14.40 = VS 2022 17.10).</summary>
    public static readonly Version Minimum = new(14, 40);

    public bool Handles(string id) => id == Id;

    public bool RetainOnUninstall => true;

    public static Version? InstalledVersion()
    {
        using var hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        foreach (var path in new[] { @"SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64", @"SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" })
        {
            using var k = hklm.OpenSubKey(path);
            if (k?.GetValue("Installed") is int installed && installed == 1 &&
                k.GetValue("Major") is int major && k.GetValue("Minor") is int minor)
            {
                return new Version(major, minor);
            }
        }

        return null;
    }

    public bool Present(string id, JsonObject? spec) => InstalledVersion() is { } v && v >= Minimum;

    public void Install(string id, JsonObject? spec)
    {
        if (Present(id, spec)) return;
        var installer = spec?["installer"]?.GetValue<string>() ?? throw new ArgumentException("vcredist spec needs installer");
        var r = ProcessRunner.Run(installer, ["/install", "/quiet", "/norestart"], 600_000);
        // 0 ok, 3010 ok (reboot pending), 1638 a newer version is already installed.
        if (r.ExitCode is not (0 or 3010 or 1638))
        {
            throw new InvalidOperationException($"Visual C++ runtime installer failed ({r.ExitCode})");
        }
    }

    public void Uninstall(string id, JsonObject? spec)
    {
        // Retained: other software may depend on it.
    }
}
