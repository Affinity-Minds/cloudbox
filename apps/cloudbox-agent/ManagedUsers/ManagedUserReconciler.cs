// Slice 5.4 managed user reconciliation (spec §14). Desired state = cloud01..cloudNN, N = max_managed_users from the
// verified entitlement. Accounts are created through the install manifest (so uninstall removes them), put in
// CloudBoxUsers and Remote Desktop Users, given a random password kept DPAPI-protected for the credential broker, and
// enabled. Accounts above N are DISABLED, never deleted. Only accounts CloudBox created itself are ever touched: a
// pre-existing account that happens to be named cloudNN is reported as a conflict and left alone. The parent/console
// account is never a cloudNN account and is never counted.
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using CloudBox.Agent.Install;
using CloudBox.Agent.State;

namespace CloudBox.Agent.ManagedUsers;

/// <summary>What the manifest says CloudBox owns, and how new accounts/memberships are recorded.</summary>
public interface IManagedUserManifest
{
    /// <summary>Account names CloudBox created (manifest <c>local_user</c> entries that did not exist before).</summary>
    IReadOnlySet<string> OwnedUsers();

    /// <summary>Records and creates the account (disabled, throwaway password).</summary>
    void CreateUser(string user);

    /// <summary>Records and adds the membership when missing.</summary>
    void EnsureMembership(string group, string user);
}

/// <summary>Managed-account passwords for the credential broker (WT-11). Never in the manifest, logs or pipe.</summary>
public interface ICredentialStore
{
    bool Has(string user);
    void Save(string user, string password);
}

public sealed record ReconcileResult(int Limit, int Configured, IReadOnlyList<string> Created, IReadOnlyList<string> Enabled,
    IReadOnlyList<string> Disabled, IReadOnlyList<string> Conflicts);

public sealed class ManagedUserReconciler(
    ILocalAccounts accounts, IManagedUserManifest manifest, ICredentialStore credentials, string remoteDesktopUsersGroup)
{
    public const int MaxSlots = 99;

    public static string NameFor(int slot) => $"cloud{slot:D2}";

    public static int? SlotOf(string user) =>
        user.Length == 7 && user.StartsWith("cloud", StringComparison.OrdinalIgnoreCase) &&
        int.TryParse(user.AsSpan(5), out var n) && n is >= 1 and <= MaxSlots
            ? n
            : null;

    public ReconcileResult Reconcile(int limit)
    {
        limit = Math.Clamp(limit, 0, MaxSlots);
        var owned = manifest.OwnedUsers();
        var created = new List<string>();
        var enabled = new List<string>();
        var disabled = new List<string>();
        var conflicts = new List<string>();
        var configured = 0;

        var slots = Enumerable.Range(1, limit)
            .Concat(owned.Select(SlotOf).Where(s => s is not null).Select(s => s!.Value))
            .Distinct()
            .Order();

        foreach (var slot in slots)
        {
            var name = NameFor(slot);
            var isOwned = owned.Contains(name);
            var exists = accounts.UserExists(name);

            if (slot > limit)
            {
                // Over the licence: suspend for remote access, keep the account and its data.
                if (isOwned && exists && accounts.IsEnabled(name) == true)
                {
                    accounts.SetEnabled(name, false);
                    disabled.Add(name);
                }

                continue;
            }

            if (exists && !isOwned)
            {
                conflicts.Add(name); // Not ours: never take over a customer's account.
                continue;
            }

            var createdNow = false;
            if (!exists)
            {
                manifest.CreateUser(name);
                created.Add(name);
                createdNow = true;
            }

            manifest.EnsureMembership(WellKnownGroups.CloudBoxUsers, name);
            manifest.EnsureMembership(remoteDesktopUsersGroup, name);

            if (createdNow || !credentials.Has(name))
            {
                var password = Passwords.Generate();
                accounts.SetPassword(name, password);
                credentials.Save(name, password);
            }

            if (accounts.IsEnabled(name) != true)
            {
                accounts.SetEnabled(name, true);
                enabled.Add(name);
            }

            configured++;
        }

        return new ReconcileResult(limit, configured, created, enabled, disabled, conflicts);
    }

    /// <summary>Enabled CloudBox-owned accounts within the licence (for the health document between reconciles).</summary>
    public int CountConfigured(int limit) =>
        manifest.OwnedUsers().Count(u => SlotOf(u) is { } s && s <= limit && accounts.IsEnabled(u) == true);
}

/// <summary>Reads the install manifest fresh on every call (Setup and the service both write it).</summary>
public sealed class ManifestManagedUsers(Func<ManifestRunner> runnerFactory, ILocalAccounts accounts) : IManagedUserManifest
{
    public IReadOnlySet<string> OwnedUsers() =>
        runnerFactory().Manifest.Entries
            .Where(e => e.Kind == Kinds.LocalUser && !e.PriorExisted)
            .Select(e => e.Id)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

    public void CreateUser(string user) =>
        runnerFactory().Apply(Kinds.LocalUser, user, new JsonObject { ["description"] = "CloudBox managed remote user" });

    public void EnsureMembership(string group, string user)
    {
        if (accounts.IsMember(group, user)) return;
        runnerFactory().Apply(Kinds.LocalGroupMembership, $"{group}|{user}");
    }
}

/// <summary>C:\ProgramData\CloudBox\credentials\{user}.bin, DPAPI machine scope, folder ACL SYSTEM + Administrators.</summary>
public sealed class DpapiCredentialStore(string folder, IBlobProtector protector) : ICredentialStore
{
    public static string DefaultFolder => Path.Combine(AgentPaths.ProgramDataRoot, "credentials");

    public static DpapiCredentialStore CreateDefault() =>
        new(DefaultFolder, new DpapiProtector("CloudBox.Agent.ManagedUserCredential.v1"));

    private string PathFor(string user) => Path.Combine(folder, user.ToLowerInvariant() + ".bin");

    public bool Has(string user) => File.Exists(PathFor(user));

    public void Save(string user, string password)
    {
        Directory.CreateDirectory(folder);
        var data = Encoding.UTF8.GetBytes(password);
        try
        {
            var tmp = PathFor(user) + ".tmp";
            File.WriteAllBytes(tmp, protector.Protect(data));
            File.Move(tmp, PathFor(user), overwrite: true);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(data);
        }
    }
}
