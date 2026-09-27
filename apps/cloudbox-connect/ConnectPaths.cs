namespace CloudBox.Connect;

/// <summary>Well-known per-user locations. Connect installs and runs entirely under the signed-in
/// Windows user's own profile — no admin, no machine-wide state (spec §59, "extremely simple").</summary>
public static class ConnectPaths
{
    public const string DefaultBaseUrl = "https://box.affinityminds.in";
    public const string AppName = "CloudBox.Connect";

    public static string DataRoot =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CloudBox", "Connect");

    public static string SessionFile => Path.Combine(DataRoot, "session.bin");

    public static string AppVersion { get; } =
        typeof(ConnectPaths).Assembly.GetName().Version?.ToString(3) ?? "0.1.0";
}
