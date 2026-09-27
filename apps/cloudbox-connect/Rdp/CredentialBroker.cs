using System.Runtime.InteropServices;

namespace CloudBox.Connect.Rdp;

/// <summary>Writes/removes a single Windows Credential Manager entry for an RDP target. This is the
/// only place a managed-user password exists outside the wire — never a command line, never a file,
/// never a log (spec §14.2/§28.4, ADR 0013).</summary>
public interface ICredentialBroker
{
    /// <summary>Writes (or overwrites) the `TERMSRV/&lt;target&gt;` generic credential `mstsc` reads automatically.</summary>
    void Write(string target, string username, string password);

    /// <summary>Removes it. Safe to call even if nothing was written (not found is not an error).</summary>
    void Delete(string target);
}

/// <summary>Real Win32 implementation: `CredWrite`/`CredDelete` (advapi32.dll) — no custom
/// cryptography, no third-party credential store, exactly the API the master spec names (§14.2).</summary>
public sealed class Win32CredentialBroker : ICredentialBroker
{
    private const int CRED_TYPE_DOMAIN_PASSWORD = 2;

    /// <summary>Session-scoped: gone at logoff even if `Delete` is somehow never reached.</summary>
    private const int CRED_PERSIST_SESSION = 1;

    private static string TargetName(string target) => $"TERMSRV/{target}";

    public void Write(string target, string username, string password)
    {
        var passwordBytes = System.Text.Encoding.Unicode.GetBytes(password);
        var blob = Marshal.AllocHGlobal(passwordBytes.Length);
        try
        {
            Marshal.Copy(passwordBytes, 0, blob, passwordBytes.Length);
            var credential = new NativeMethods.CREDENTIAL
            {
                Type = CRED_TYPE_DOMAIN_PASSWORD,
                TargetName = TargetName(target),
                CredentialBlobSize = passwordBytes.Length,
                CredentialBlob = blob,
                Persist = CRED_PERSIST_SESSION,
                UserName = username,
            };
            if (!NativeMethods.CredWrite(ref credential, 0))
            {
                throw new InvalidOperationException(
                    $"CredWrite failed (Win32 error {Marshal.GetLastWin32Error()}).");
            }
        }
        finally
        {
            // Best-effort scrub: the unmanaged copy is the only one we control the lifetime of.
            for (var i = 0; i < passwordBytes.Length; i++) passwordBytes[i] = 0;
            Marshal.FreeHGlobal(blob);
        }
    }

    public void Delete(string target)
    {
        if (!NativeMethods.CredDelete(TargetName(target), CRED_TYPE_DOMAIN_PASSWORD, 0))
        {
            var error = Marshal.GetLastWin32Error();
            const int ERROR_NOT_FOUND = 1168;
            if (error != ERROR_NOT_FOUND)
            {
                throw new InvalidOperationException($"CredDelete failed (Win32 error {error}).");
            }
        }
    }

    private static class NativeMethods
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct CREDENTIAL
        {
            public int Flags;
            public int Type;
            public string TargetName;
            public string? Comment;
            public long LastWritten;
            public int CredentialBlobSize;
            public IntPtr CredentialBlob;
            public int Persist;
            public int AttributeCount;
            public IntPtr Attributes;
            public string? TargetAlias;
            public string? UserName;
        }

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CredWriteW")]
        public static extern bool CredWrite(ref CREDENTIAL credential, uint flags);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CredDeleteW")]
        public static extern bool CredDelete(string target, int type, int flags);
    }
}
