using System.Runtime.InteropServices;
using System.Security.Principal;

namespace CloudBox.Agent.ManagedUsers;

public sealed record WindowsSession(int SessionId, string User, string State);

public interface ISessionCounter
{
    IReadOnlyList<WindowsSession> Sessions();
}

/// <summary>WTSEnumerateSessions / WTSQuerySessionInformation on the local server.</summary>
public sealed class WtsSessions : ISessionCounter
{
    private const int WtsUserName = 5;
    private const int WtsDomainName = 7;
    private static readonly IntPtr CurrentServer = IntPtr.Zero;

    private enum WtsConnectState
    {
        Active,
        Connected,
        ConnectQuery,
        Shadow,
        Disconnected,
        Idle,
        Listen,
        Reset,
        Down,
        Init,
    }

#pragma warning disable CS0649, CS0169 // Filled by the marshaller.
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WtsSessionInfo
    {
        public int SessionId;
        public IntPtr WinStationName;
        public WtsConnectState State;
    }
#pragma warning restore CS0649, CS0169

    [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool WTSEnumerateSessionsW(IntPtr server, int reserved, int version, out IntPtr sessionInfo, out int count);

    [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool WTSQuerySessionInformationW(IntPtr server, int sessionId, int infoClass, out IntPtr buffer, out int bytes);

    [DllImport("wtsapi32.dll")]
    private static extern void WTSFreeMemory(IntPtr memory);

    [DllImport("kernel32.dll")]
    private static extern int WTSGetActiveConsoleSessionId();

    private static string? Query(int sessionId, int infoClass)
    {
        if (!WTSQuerySessionInformationW(CurrentServer, sessionId, infoClass, out var buffer, out _)) return null;
        try
        {
            return Marshal.PtrToStringUni(buffer);
        }
        finally
        {
            WTSFreeMemory(buffer);
        }
    }

    public IReadOnlyList<WindowsSession> Sessions()
    {
        var result = new List<WindowsSession>();
        if (!WTSEnumerateSessionsW(CurrentServer, 0, 1, out var info, out var count)) return result;
        try
        {
            var size = Marshal.SizeOf<WtsSessionInfo>();
            for (var i = 0; i < count; i++)
            {
                var s = Marshal.PtrToStructure<WtsSessionInfo>(info + (i * size));
                var user = Query(s.SessionId, WtsUserName);
                if (string.IsNullOrEmpty(user)) continue;
                result.Add(new WindowsSession(s.SessionId, user, s.State.ToString().ToLowerInvariant()));
            }
        }
        finally
        {
            WTSFreeMemory(info);
        }

        return result;
    }

    /// <summary>
    /// The account at the physical console (the parent/maintenance account, spec §14.1), as DOMAIN\user; falls back to the
    /// current process identity when nobody is at the console (e.g. Setup run over RDP).
    /// </summary>
    public static string ConsoleUser()
    {
        var id = WTSGetActiveConsoleSessionId();
        if (id >= 0)
        {
            var user = Query(id, WtsUserName);
            var domain = Query(id, WtsDomainName);
            if (!string.IsNullOrEmpty(user)) return string.IsNullOrEmpty(domain) ? user : $"{domain}\\{user}";
        }

        using var current = WindowsIdentity.GetCurrent();
        return current.Name;
    }

    /// <summary>Active sessions of CloudBox managed accounts (the console parent is never counted).</summary>
    public static int ActiveManaged(IEnumerable<WindowsSession> sessions) =>
        sessions.Count(s => s.State == "active" && ManagedUserReconciler.SlotOf(s.User) is not null);
}
