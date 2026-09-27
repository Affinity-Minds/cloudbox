using CloudBox.Agent.ManagedUsers;
using CloudBox.Agent.Rdp;

namespace CloudBox.Agent.Tests;

public sealed class FakeRdpSystem : IRdpSystem
{
    public const string TermWrap = @"C:\Program Files\RDP Wrapper\TermWrap.dll";
    public const string Zydis = @"C:\Program Files\RDP Wrapper\zydis.dll";

    public string? Dll { get; set; } = TermWrap;
    public string? Image { get; set; } = @"%SystemRoot%\System32\svchost.exe -k NetworkService";
    public bool Running { get; set; } = true;
    public bool Listening { get; set; } = true;
    public bool Supported { get; set; } = true;
    public HashSet<string> Files { get; } = new(StringComparer.OrdinalIgnoreCase) { TermWrap, Zydis };
    public int Starts { get; private set; }

    public string? ServiceDll() => Dll;
    public string? TermServiceImagePath() => Image;
    public bool TermServiceRunning() => Running;

    public void StartTermService()
    {
        Starts++;
        Running = true;
    }

    public bool ListenerUp() => Listening;
    public bool FileExists(string path) => Files.Contains(path);

    public bool OsSupported(out string reason)
    {
        reason = Supported ? "" : "32-bit Windows";
        return Supported;
    }
}

public sealed class RdpProbeTests
{
    private static string State(FakeRdpSystem s) => RdpProbe.Evaluate(s).State;

    [Fact]
    public void Healthy_when_termwrap_is_active_running_and_listening()
    {
        var r = RdpProbe.Evaluate(new FakeRdpSystem());
        Assert.Equal(RdpStates.Healthy, r.State);
        Assert.True(r.Listener);
    }

    [Fact]
    public void Each_failure_maps_to_one_normalised_state()
    {
        Assert.Equal(RdpStates.UnsupportedRuntime, State(new FakeRdpSystem { Supported = false }));
        Assert.Equal(RdpStates.UnsupportedRuntime, State(new FakeRdpSystem { Image = null }));
        Assert.Equal(RdpStates.UnsupportedRuntime, State(new FakeRdpSystem { Image = @"C:\evil\termsvc.exe" }));
        Assert.Equal(RdpStates.WrapperMissing, State(new FakeRdpSystem { Dll = @"C:\Windows\System32\termsrv.dll" }));
        Assert.Equal(RdpStates.WrapperMissing, State(new FakeRdpSystem { Dll = null }));
        Assert.Equal(RdpStates.UnsupportedRuntime, State(new FakeRdpSystem { Dll = @"C:\Program Files\RDP Wrapper\rdpwrap.dll" }));
        Assert.Equal(RdpStates.UnsupportedRuntime, State(new FakeRdpSystem { Dll = @"C:\x\other.dll" }));
        Assert.Equal(RdpStates.ServiceStopped, State(new FakeRdpSystem { Running = false }));
        Assert.Equal(RdpStates.ListenerMissing, State(new FakeRdpSystem { Listening = false }));
    }

    [Fact]
    public void Quarantined_runtime_files_mean_repair_required_not_silent_failure()
    {
        var dllGone = new FakeRdpSystem();
        dllGone.Files.Remove(FakeRdpSystem.TermWrap);
        Assert.Equal(RdpStates.RepairRequired, State(dllGone));

        var zydisGone = new FakeRdpSystem();
        zydisGone.Files.Remove(FakeRdpSystem.Zydis);
        Assert.Equal(RdpStates.RepairRequired, State(zydisGone));
    }

    [Fact]
    public void Repair_starts_a_stopped_service_and_reports_the_missing_package()
    {
        var sys = new FakeRdpSystem { Running = false };
        var runtime = new RdpWrapperRuntime(sys, Path.Combine(Path.GetTempPath(), $"missing-{Guid.NewGuid():N}.exe"));
        Assert.Equal(RdpStates.Healthy, runtime.Repair().State);
        Assert.Equal(1, sys.Starts);

        sys.Dll = @"C:\Windows\System32\termsrv.dll";
        var r = runtime.Repair();
        Assert.Equal(RdpStates.WrapperMissing, r.State);
        Assert.Contains("run CloudBox Server Setup again", r.Detail);
    }
}

public sealed class ManagedUserTests
{
    private sealed class FakeAccounts : ILocalAccounts
    {
        public Dictionary<string, bool> Users { get; } = new(StringComparer.OrdinalIgnoreCase);
        public HashSet<string> Memberships { get; } = new(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, string> Passwords { get; } = new(StringComparer.OrdinalIgnoreCase);
        public List<string> Deleted { get; } = [];

        public bool UserExists(string user) => Users.ContainsKey(user);
        public bool? IsEnabled(string user) => Users.TryGetValue(user, out var e) ? e : null;
        public void SetEnabled(string user, bool enabled) => Users[user] = enabled;
        public void SetPassword(string user, string password) => Passwords[user] = password;
        public bool GroupExists(string group) => true;
        public bool IsMember(string group, string user) => Memberships.Contains($"{group}|{user}");
    }

    private sealed class FakeManifest(FakeAccounts accounts) : IManagedUserManifest
    {
        public HashSet<string> Owned { get; } = new(StringComparer.OrdinalIgnoreCase);
        public List<string> Recorded { get; } = [];

        public IReadOnlySet<string> OwnedUsers() => Owned;

        public void CreateUser(string user)
        {
            Recorded.Add($"local_user {user}");
            Owned.Add(user);
            accounts.Users[user] = false; // Created disabled, like LocalUserStep.
        }

        public void EnsureMembership(string group, string user)
        {
            if (accounts.IsMember(group, user)) return;
            Recorded.Add($"local_group_membership {group}|{user}");
            accounts.Memberships.Add($"{group}|{user}");
        }
    }

    private sealed class FakeCredentials : ICredentialStore
    {
        public Dictionary<string, string> Saved { get; } = new(StringComparer.OrdinalIgnoreCase);
        public bool Has(string user) => Saved.ContainsKey(user);
        public void Save(string user, string password) => Saved[user] = password;
    }

    private static (FakeAccounts Accounts, FakeManifest Manifest, FakeCredentials Creds, ManagedUserReconciler Reconciler) Setup()
    {
        var accounts = new FakeAccounts();
        accounts.Users["owner"] = true; // The parent/console account.
        var manifest = new FakeManifest(accounts);
        var creds = new FakeCredentials();
        return (accounts, manifest, creds, new ManagedUserReconciler(accounts, manifest, creds, "Remote Desktop Users"));
    }

    [Fact]
    public void Six_slots_create_cloud01_to_cloud06_enabled_with_memberships_and_stored_passwords()
    {
        var (accounts, manifest, creds, reconciler) = Setup();
        var r = reconciler.Reconcile(6);

        Assert.Equal(new[] { "cloud01", "cloud02", "cloud03", "cloud04", "cloud05", "cloud06" }, r.Created);
        Assert.Equal(6, r.Configured);
        foreach (var u in r.Created)
        {
            Assert.True(accounts.Users[u]);
            Assert.True(accounts.IsMember("CloudBoxUsers", u));
            Assert.True(accounts.IsMember("Remote Desktop Users", u));
            Assert.Equal(accounts.Passwords[u], creds.Saved[u]);
            Assert.True(creds.Saved[u].Length >= 20);
        }

        Assert.True(accounts.Users["owner"]); // Parent untouched and never counted.
        Assert.DoesNotContain(manifest.Recorded, e => e.Contains("owner", StringComparison.Ordinal));
        Assert.Equal(6 * 3, manifest.Recorded.Count(e => e.StartsWith("local_", StringComparison.Ordinal)));
    }

    [Fact]
    public void Six_to_four_disables_the_excess_and_never_deletes()
    {
        var (accounts, manifest, _, reconciler) = Setup();
        reconciler.Reconcile(6);
        var recordedBefore = manifest.Recorded.Count;

        var r = reconciler.Reconcile(4);

        Assert.Equal(new[] { "cloud05", "cloud06" }, r.Disabled);
        Assert.Empty(r.Created);
        Assert.Equal(4, r.Configured);
        Assert.False(accounts.Users["cloud05"]);
        Assert.False(accounts.Users["cloud06"]);
        Assert.True(accounts.UserExists("cloud05"));
        Assert.True(accounts.UserExists("cloud06"));
        Assert.All(new[] { "cloud01", "cloud02", "cloud03", "cloud04" }, u => Assert.True(accounts.Users[u]));
        Assert.Empty(accounts.Deleted);
        Assert.Equal(recordedBefore, manifest.Recorded.Count); // Nothing new recorded, nothing removed.

        // Back to six: the same accounts are re-enabled, not re-created, passwords kept.
        var again = reconciler.Reconcile(6);
        Assert.Empty(again.Created);
        Assert.Equal(new[] { "cloud05", "cloud06" }, again.Enabled);
        Assert.Equal(6, again.Configured);
    }

    [Fact]
    public void A_pre_existing_account_named_like_a_slot_is_never_taken_over()
    {
        var (accounts, manifest, creds, reconciler) = Setup();
        accounts.Users["cloud02"] = true; // The customer's own account.

        var r = reconciler.Reconcile(3);

        Assert.Equal(new[] { "cloud02" }, r.Conflicts);
        Assert.Equal(new[] { "cloud01", "cloud03" }, r.Created);
        Assert.Equal(2, r.Configured);
        Assert.False(creds.Has("cloud02"));
        Assert.False(accounts.Passwords.ContainsKey("cloud02"));
        Assert.DoesNotContain(manifest.Recorded, e => e.Contains("cloud02", StringComparison.Ordinal));
    }

    [Fact]
    public void Zero_slots_disables_every_owned_account()
    {
        var (accounts, _, _, reconciler) = Setup();
        reconciler.Reconcile(2);
        var r = reconciler.Reconcile(0);
        Assert.Equal(new[] { "cloud01", "cloud02" }, r.Disabled);
        Assert.Equal(0, r.Configured);
        Assert.True(accounts.Users["owner"]);
    }

    [Fact]
    public void Slot_names_parse_and_the_console_parent_is_not_counted_as_a_session()
    {
        Assert.Equal(7, ManagedUserReconciler.SlotOf("cloud07"));
        Assert.Null(ManagedUserReconciler.SlotOf("owner"));
        Assert.Null(ManagedUserReconciler.SlotOf("cloud100"));
        Assert.Null(ManagedUserReconciler.SlotOf("cloud00"));
        var sessions = new[]
        {
            new WindowsSession(1, "owner", "active"),
            new WindowsSession(2, "cloud01", "active"),
            new WindowsSession(3, "cloud02", "active"),
            new WindowsSession(4, "cloud03", "disconnected"),
        };
        Assert.Equal(2, WtsSessions.ActiveManaged(sessions));
    }

    [Fact]
    public void Generated_passwords_meet_windows_complexity()
    {
        for (var i = 0; i < 50; i++)
        {
            var p = Passwords.Generate();
            Assert.Equal(24, p.Length);
            Assert.Contains(p, char.IsUpper);
            Assert.Contains(p, char.IsLower);
            Assert.Contains(p, char.IsDigit);
            Assert.Contains(p, c => !char.IsLetterOrDigit(c));
        }
    }
}
