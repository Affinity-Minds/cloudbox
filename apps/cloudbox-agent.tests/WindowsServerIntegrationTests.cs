using System.Security.Principal;
using System.Text.Json.Nodes;
using CloudBox.Agent.Gate;
using CloudBox.Agent.Install;
using CloudBox.Agent.ManagedUsers;
using CloudBox.Agent.Rdp;
using Xunit.Abstractions;

namespace CloudBox.Agent.Tests;

/// <summary>
/// Real Windows APIs on the CI runner (windows-latest, elevated): AccountManagement users/groups, Windows Firewall rules
/// through netsh + HNetCfg COM, Task Scheduler XML, and the RDP probe against the runner's own TermService. Every test
/// cleans up after itself; names are unique per run.
/// </summary>
public sealed class WindowsServerIntegrationTests(ITestOutputHelper output)
{
    private static readonly string Suffix = Guid.NewGuid().ToString("N")[..6];

    [Fact]
    public void Managed_user_and_group_lifecycle_through_the_manifest()
    {
        var group = $"CbxTestGroup{Suffix}";
        var user = $"cbxt{Suffix}"; // SAM names are limited to 20 characters.
        var store = new InMemoryManifestStore();
        var runner = new ManifestRunner(store, WindowsSteps.Create(new InMemoryDeviceKeyStore()));
        var accounts = new WindowsLocalAccounts();
        try
        {
            runner.Apply(Kinds.LocalGroup, group, new JsonObject { ["description"] = "CloudBox CI test" });
            runner.Apply(Kinds.LocalUser, user, new JsonObject { ["description"] = "CloudBox CI test" });
            runner.Apply(Kinds.LocalGroupMembership, $"{group}|{user}");
            runner.Apply(Kinds.LocalGroupMembership, $"{WellKnownGroups.RemoteDesktopUsers}|{user}");

            Assert.True(accounts.GroupExists(group));
            Assert.True(accounts.UserExists(user));
            Assert.False(accounts.IsEnabled(user)); // Created disabled.
            Assert.True(accounts.IsMember(group, user));
            Assert.True(accounts.IsMember(WellKnownGroups.RemoteDesktopUsers, user));
            output.WriteLine($"Remote Desktop Users resolves to '{WellKnownGroups.RemoteDesktopUsers}'");

            accounts.SetPassword(user, Passwords.Generate());
            accounts.SetEnabled(user, true);
            Assert.True(accounts.IsEnabled(user));
            accounts.SetEnabled(user, false); // Excess slot: disabled, still present.
            Assert.True(accounts.UserExists(user));

            Assert.Equal(1, CleanVerifier.Run(runner, runner.Manifest.Entries, new StringWriter()));
            var results = runner.RevertAll(runner.Manifest.Entries, new RevertContext { ProcessPath = null });
            Assert.All(results, r => Assert.NotEqual(RevertOutcome.Failed, r.Outcome));
            Assert.False(accounts.UserExists(user));
            Assert.False(accounts.GroupExists(group));
            Assert.Equal(0, CleanVerifier.Run(runner, runner.Manifest.Entries, new StringWriter()));
        }
        finally
        {
            WindowsLocalAccounts.DeleteUser(user);
            WindowsLocalAccounts.DeleteGroup(group);
        }
    }

    [Fact]
    public void Gate_rule_is_created_blocking_toggled_by_licence_state_and_removed()
    {
        var name = $"CloudBox CI Gate {Suffix}";
        var runner = new ManifestRunner(new InMemoryManifestStore(), WindowsSteps.Create(new InMemoryDeviceKeyStore()));
        var fw = new WindowsFirewall();
        try
        {
            var args = LicenseGate.GateRuleArgs().Select(a => a.Replace("localport=3389", "localport=33899")).ToArray();
            runner.Apply(Kinds.FirewallRule, name, new JsonObject { ["args"] = new JsonArray(args.Select(a => (JsonNode?)a).ToArray()) });
            Assert.True(fw.RuleExists(name));
            Assert.True(fw.IsEnabled(name)); // Default block.

            fw.SetEnabled(name, false);
            Assert.False(fw.IsEnabled(name));
            fw.SetEnabled(name, true);
            Assert.True(fw.IsEnabled(name));

            runner.RevertAll(runner.Manifest.Entries, new RevertContext { ProcessPath = null });
            Assert.False(fw.RuleExists(name));
            Assert.Null(fw.IsEnabled(name));
        }
        finally
        {
            ProcessRunner.Run("netsh.exe", ["advfirewall", "firewall", "delete", "rule", $"name={name}"]);
        }
    }

    [Fact]
    public void Task_scheduler_accepts_the_watchdog_and_status_task_xml()
    {
        var watchdog = $"CloudBox CI Watchdog {Suffix}";
        var status = $"CloudBox CI Status {Suffix}";
        var runner = new ManifestRunner(new InMemoryManifestStore(), WindowsSteps.Create(new InMemoryDeviceKeyStore()));
        using var me = WindowsIdentity.GetCurrent();
        try
        {
            runner.Apply(Kinds.ScheduledTask, watchdog, new JsonObject { ["xml"] = LicenseGate.WatchdogTaskXml() });
            runner.Apply(Kinds.ScheduledTask, status, new JsonObject { ["xml"] = ServerInstall.StatusTaskXml(me.User!.Value) });
            var q = ProcessRunner.Run("schtasks.exe", ["/query", "/tn", watchdog, "/xml"]);
            Assert.Equal(0, q.ExitCode);
            Assert.Contains("PT1M", q.Output);
            Assert.Equal(1, CleanVerifier.Run(runner, runner.Manifest.Entries, new StringWriter()));

            runner.RevertAll(runner.Manifest.Entries, new RevertContext { ProcessPath = null });
            Assert.Equal(0, CleanVerifier.Run(runner, runner.Manifest.Entries, new StringWriter()));
        }
        finally
        {
            ProcessRunner.Run("schtasks.exe", ["/delete", "/tn", watchdog, "/f"]);
            ProcessRunner.Run("schtasks.exe", ["/delete", "/tn", status, "/f"]);
        }
    }

    [Fact]
    public void Rdp_probe_reads_the_runner_without_throwing()
    {
        // The runner has no RDP runtime installed: expect wrapper_missing (or unsupported on a Server SKU with a
        // different TermService layout). The point is that every OS read works unelevated-safe and maps to a state.
        var r = RdpProbe.Evaluate(new WindowsRdpSystem());
        output.WriteLine($"CI runner RDP probe: {r.State} ({r.Detail}); ServiceDll={new WindowsRdpSystem().ServiceDll()}");
        Assert.Contains(r.State, new[] { RdpStates.WrapperMissing, RdpStates.UnsupportedRuntime });
    }

    [Fact]
    public void Wts_enumerates_sessions_and_finds_the_console_user()
    {
        var sessions = new WtsSessions().Sessions();
        output.WriteLine($"sessions: {string.Join(", ", sessions.Select(s => $"{s.SessionId}:{s.User}:{s.State}"))}; console: {WtsSessions.ConsoleUser()}");
        Assert.False(string.IsNullOrEmpty(WtsSessions.ConsoleUser()));
    }

    [Fact]
    public void Vc_runtime_version_is_readable()
    {
        output.WriteLine($"VC++ x64 runtime on the runner: {VcRedistComponent.InstalledVersion()?.ToString() ?? "not installed"}");
        var component = new VcRedistComponent();
        Assert.True(component.RetainOnUninstall);
    }
}
