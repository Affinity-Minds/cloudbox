using System.Reflection;

namespace CloudBox.Agent;

/// <summary>Well-known names and locations. Everything CloudBox creates on a machine is named here.</summary>
public static class AgentPaths
{
    public const string ServiceName = "CloudBoxAgent";
    public const string ServiceDisplayName = "CloudBox Agent";
    public const string ServiceDescription = "CloudBox appliance agent: device identity, licensing, health reporting.";
    public const string PipeName = "CloudBoxAgent";
    public const string KeyName = "CloudBox.Agent.DeviceKey";
    public const string EventLogSource = "CloudBoxAgent";
    public const string RegistryRoot = @"HKLM\SOFTWARE\CloudBox";
    public const string ManifestBackupSubKey = @"SOFTWARE\CloudBox\ManifestBackup";
    public const string ArpKey = @"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\CloudBoxAgent";
    public const string Publisher = "Affinity Minds";

    public static string ProgramDataRoot =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "CloudBox");

    public static string LogsDir => Path.Combine(ProgramDataRoot, "logs");
    public static string StateFile => Path.Combine(ProgramDataRoot, "agent-state.bin");
    public static string ManifestFile => Path.Combine(ProgramDataRoot, "install-manifest.json");

    public static string ProgramFilesRoot =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "CloudBox");

    public static string InstallDir => Path.Combine(ProgramFilesRoot, "Agent");
    public static string InstalledExe => Path.Combine(InstallDir, "CloudBox.Agent.exe");

    /// <summary>Customer data. Only <c>uninstall --purge-data</c> may touch these.</summary>
    public static IReadOnlyList<string> CustomerDataFolders { get; } = [@"D:\CloudBoxData"];

    /// <summary>Written outside every CloudBox folder so verify-clean can re-check after uninstall.</summary>
    public static string UninstallReportFile => Path.Combine(Path.GetTempPath(), "CloudBox-uninstall-report.json");

    public static string AgentVersion { get; } =
        typeof(AgentPaths).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
        ?? "0.0.0";
}
