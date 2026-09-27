// Local SAM accounts through System.DirectoryServices.AccountManagement (the same API upstream's LocalUsersManager
// uses). Used by the manifest steps (create/delete) and by the reconciler (enable/disable/password).
using System.DirectoryServices.AccountManagement;
using System.Security.Cryptography;
using System.Security.Principal;

namespace CloudBox.Agent.ManagedUsers;

public interface ILocalAccounts
{
    bool UserExists(string user);
    bool? IsEnabled(string user);
    void SetEnabled(string user, bool enabled);
    void SetPassword(string user, string password);
    bool GroupExists(string group);
    bool IsMember(string group, string user);
}

public static class WellKnownGroups
{
    public const string CloudBoxUsers = "CloudBoxUsers";
    public const string RemoteDesktopUsersSid = "S-1-5-32-555";

    /// <summary>Localised name of BUILTIN\Remote Desktop Users (e.g. "Remotedesktopbenutzer").</summary>
    public static string RemoteDesktopUsers
    {
        get
        {
            var name = new SecurityIdentifier(RemoteDesktopUsersSid).Translate(typeof(NTAccount)).Value;
            var slash = name.IndexOf('\\');
            return slash < 0 ? name : name[(slash + 1)..];
        }
    }
}

public static class Passwords
{
    private const string Upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    private const string Lower = "abcdefghijkmnopqrstuvwxyz";
    private const string Digits = "23456789";
    private const string Symbols = "!#%+-=?@^_";

    /// <summary>Random password satisfying the default Windows complexity policy. Never logged or shown.</summary>
    public static string Generate(int length = 24)
    {
        const string all = Upper + Lower + Digits + Symbols;
        while (true)
        {
            var p = RandomNumberGenerator.GetString(all, length);
            if (p.IndexOfAny(Upper.ToCharArray()) >= 0 && p.IndexOfAny(Lower.ToCharArray()) >= 0 &&
                p.IndexOfAny(Digits.ToCharArray()) >= 0 && p.IndexOfAny(Symbols.ToCharArray()) >= 0)
            {
                return p;
            }
        }
    }
}

public sealed class WindowsLocalAccounts : ILocalAccounts
{
    private static PrincipalContext Machine() => new(ContextType.Machine);

    private static UserPrincipal? FindUser(PrincipalContext ctx, string user) =>
        UserPrincipal.FindByIdentity(ctx, IdentityType.SamAccountName, user);

    private static GroupPrincipal? FindGroup(PrincipalContext ctx, string group) =>
        GroupPrincipal.FindByIdentity(ctx, IdentityType.SamAccountName, group);

    public bool UserExists(string user)
    {
        using var ctx = Machine();
        using var u = FindUser(ctx, user);
        return u is not null;
    }

    public bool? IsEnabled(string user)
    {
        using var ctx = Machine();
        using var u = FindUser(ctx, user);
        return u?.Enabled;
    }

    public void SetEnabled(string user, bool enabled)
    {
        using var ctx = Machine();
        using var u = FindUser(ctx, user) ?? throw new InvalidOperationException($"Local user {user} not found");
        u.Enabled = enabled;
        u.Save();
    }

    public void SetPassword(string user, string password)
    {
        using var ctx = Machine();
        using var u = FindUser(ctx, user) ?? throw new InvalidOperationException($"Local user {user} not found");
        u.SetPassword(password);
        u.Save();
    }

    public bool GroupExists(string group)
    {
        using var ctx = Machine();
        using var g = FindGroup(ctx, group);
        return g is not null;
    }

    public bool IsMember(string group, string user)
    {
        using var ctx = Machine();
        using var g = FindGroup(ctx, group);
        if (g is null) return false;
        return g.Members.Contains(ctx, IdentityType.SamAccountName, user);
    }

    // ------------------------------------------------------------ used by the manifest steps only

    /// <summary>Creates a disabled account with a throwaway random password; the reconciler sets the real one.</summary>
    public static void CreateUser(string user, string description)
    {
        using var ctx = Machine();
        using var u = new UserPrincipal(ctx, user, Passwords.Generate(), false)
        {
            Description = description,
            PasswordNeverExpires = true,
            UserCannotChangePassword = true,
        };
        u.Save();
    }

    public static void DeleteUser(string user)
    {
        using var ctx = Machine();
        using var u = FindUser(ctx, user);
        u?.Delete();
    }

    public static void CreateGroup(string group, string description)
    {
        using var ctx = Machine();
        using var g = new GroupPrincipal(ctx, group) { Description = description };
        g.Save();
    }

    public static void DeleteGroup(string group)
    {
        using var ctx = Machine();
        using var g = FindGroup(ctx, group);
        g?.Delete();
    }

    public static void AddMember(string group, string user)
    {
        using var ctx = Machine();
        using var g = FindGroup(ctx, group) ?? throw new InvalidOperationException($"Local group {group} not found");
        if (g.Members.Contains(ctx, IdentityType.SamAccountName, user)) return;
        g.Members.Add(ctx, IdentityType.SamAccountName, user);
        g.Save();
    }

    public static void RemoveMember(string group, string user)
    {
        using var ctx = Machine();
        using var g = FindGroup(ctx, group);
        if (g is null || !g.Members.Contains(ctx, IdentityType.SamAccountName, user)) return;
        g.Members.Remove(ctx, IdentityType.SamAccountName, user);
        g.Save();
    }
}
