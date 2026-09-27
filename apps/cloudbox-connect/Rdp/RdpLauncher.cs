using System.Diagnostics;

namespace CloudBox.Connect.Rdp;

/// <summary>Starts a process and waits for it to exit. Abstracted so tests can fake `mstsc` without
/// actually launching a GUI process.</summary>
public interface IProcessLauncher
{
    Task<int> LaunchAndWaitAsync(string fileName, IReadOnlyList<string> arguments, CancellationToken ct);
}

public sealed class RealProcessLauncher : IProcessLauncher
{
    public async Task<int> LaunchAndWaitAsync(string fileName, IReadOnlyList<string> arguments, CancellationToken ct)
    {
        var psi = new ProcessStartInfo(fileName) { UseShellExecute = false };
        foreach (var arg in arguments) psi.ArgumentList.Add(arg);
        using var process = Process.Start(psi) ?? throw new InvalidOperationException($"Could not start {fileName}");
        await process.WaitForExitAsync(ct);
        return process.ExitCode;
    }
}

/// <summary>Orchestrates one RDP session end to end (spec §28.3/§14.2, ADR 0013):
/// `CredWrite` → write a password-free `.rdp` file → launch `mstsc` and wait → `CredDelete` (always,
/// even on failure) → remove the temp file. The password never appears on `mstsc`'s command line,
/// in the `.rdp` file, or in any log written by this class.</summary>
public sealed class RdpLauncher(ICredentialBroker credentials, IProcessLauncher process, Func<string>? tempFile = null)
{
    private readonly Func<string> _tempFile = tempFile ?? (() => Path.Combine(Path.GetTempPath(), $"cloudbox-{Guid.NewGuid():N}.rdp"));

    /// <summary>Builds the `.rdp` file contents: the target address and username, deliberately no
    /// password field — `mstsc` fills that in from the Credential Manager entry for `TERMSRV/&lt;address&gt;`
    /// that <see cref="ICredentialBroker.Write"/> just wrote. Public so tests can assert on it directly.</summary>
    public static string BuildRdpFile(string address, string username) =>
        $"full address:s:{address}\r\n" +
        $"username:s:{username}\r\n" +
        "prompt for credentials:i:0\r\n" +
        "authentication level:i:2\r\n";

    public async Task ConnectAsync(string address, string username, string password, CancellationToken ct = default)
    {
        credentials.Write(address, username, password);
        var rdpFile = _tempFile();
        try
        {
            await File.WriteAllTextAsync(rdpFile, BuildRdpFile(address, username), ct);
            await process.LaunchAndWaitAsync("mstsc.exe", [rdpFile, "/f"], ct);
        }
        finally
        {
            credentials.Delete(address);
            TryDeleteFile(rdpFile);
        }
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch (IOException)
        {
            // Best effort: a lingering temp file is not worth failing the whole Connect action over.
        }
    }
}
