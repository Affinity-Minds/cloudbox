using CloudBox.Agent.Cloud;
using CloudBox.Agent.Gate;
using CloudBox.Agent.Identity;
using CloudBox.Agent.Install;
using CloudBox.Agent.Rdp;
using CloudBox.Agent.State;

namespace CloudBox.Agent.Tests;

public sealed class ServerInstallTests
{
    private sealed class FakeHost : IServerInstallHost
    {
        public List<string> Calls { get; } = [];
        public bool Supported { get; set; } = true;
        public Exception? EnrollFailure { get; set; }
        public AgentState? Saved { get; private set; }
        public Queue<string?> StatusDocs { get; } = new();
        private readonly InMemoryDeviceKeyStore _keys = new();

        public PrerequisiteReport CheckPrerequisites()
        {
            Calls.Add("prerequisites");
            return new PrerequisiteReport(Supported, "Windows 11 Pro 26100", true, Supported ? null : "Windows 11 Home is not supported");
        }

        public DeviceKeyInfo DeviceKey() => _keys.OpenOrCreate();

        public Task<EnrollResponse> EnrollAsync(Uri baseUrl, string token, EnrollDevice device, CancellationToken ct)
        {
            Calls.Add("enroll");
            if (EnrollFailure is not null) throw EnrollFailure;
            return Task.FromResult(new EnrollResponse("dev_1", "ten_1", "CBX-00001", "CLOUDBOX-00001", "device-token",
                "no_active_plan", "No active plan found. Please contact the CloudBox admin."));
        }

        public Task<IReadOnlyList<string>> SigningKeysAsync(Uri baseUrl, string deviceToken, CancellationToken ct)
        {
            Calls.Add("signing-keys");
            return Task.FromResult<IReadOnlyList<string>>(["{\"kty\":\"EC\",\"kid\":\"k1\"}"]);
        }

        public void SaveState(AgentState state)
        {
            Calls.Add("save-state");
            Saved = state;
        }

        public void RestartAgentService() => Calls.Add("restart-service");

        public RdpProbeResult ProbeRdp() => new(RdpStates.Healthy, true, "ok");

        public string? ReadStatus() => StatusDocs.Count > 0 ? StatusDocs.Dequeue() : null;

        public Task DelayAsync(TimeSpan delay, CancellationToken ct) => Task.CompletedTask;
    }

    private static (FakeMachine Machine, InMemoryManifestStore Store, ManifestRunner Runner) Machine()
    {
        var machine = new FakeMachine();
        var store = new InMemoryManifestStore();
        return (machine, store, new ManifestRunner(store, Kinds.All.Select(k => new FakeStep(k, machine, keyByKind: true))));
    }

    private static ServerInstallOptions Options => new(new Uri("https://box.example.test"), "CBX-ENROLL-TEST", "S-1-5-21-1-2-3-1001",
        @"C:\Temp\vc_redist.x64.exe");

    private const string Settled = """
        {"enrolled":true,"cloud":"connected","license":{"state":"NO_PLAN"},"users":{"configured":null,"limit":null,"state":"waiting_for_licence"}}
        """;

    [Fact]
    public async Task Steps_run_in_the_documented_order()
    {
        var (_, _, runner) = Machine();
        var host = new FakeHost();
        host.StatusDocs.Enqueue(Settled);
        var progress = new List<InstallProgress>();

        var result = await new ServerInstall(runner, host, Options).RunAsync(new SyncProgress(progress), CancellationToken.None);

        Assert.True(result.Succeeded, result.Error);
        Assert.Equal(
            new[]
            {
                "prerequisites", "vcredist", "agent", "status", "rdp-runtime", "rdp-settings", "managed-users", "firewall-gate",
                "network", "enrollment", "health-check",
            },
            ServerInstall.Steps.Select(s => s.Key));
        Assert.Equal(ServerInstall.Steps.Select(s => s.Key),
            progress.Where(p => p.Status == InstallStepStatus.Done).Select(p => p.Key));
        Assert.Equal(new[] { "prerequisites", "enroll", "signing-keys", "save-state", "restart-service" }, host.Calls);
        Assert.Equal("no_active_plan", result.Enrollment!.LicenseState);
        Assert.Equal("CBX-00001", host.Saved!.TenantCode);
        Assert.Single(host.Saved.PinnedSigningKeys);
    }

    [Fact]
    public async Task Every_machine_change_is_a_manifest_entry_in_a_safe_order()
    {
        var (_, _, runner) = Machine();
        var host = new FakeHost();
        host.StatusDocs.Enqueue(Settled);
        await new ServerInstall(runner, host, Options).RunAsync(null, CancellationToken.None);

        var ids = runner.Manifest.Entries.Select(e => $"{e.Kind} {e.Id}").ToList();
        int At(string kindId) => ids.FindIndex(x => x == kindId) is var i and >= 0 ? i : throw new Xunit.Sdk.XunitException($"missing {kindId}\n{string.Join('\n', ids)}");

        Assert.Equal($"{Kinds.ThirdPartyComponent} {VcRedistComponent.Id}", ids[0]);
        var vendorExclusion = At($"{Kinds.ThirdPartyComponent} {DefenderExclusionComponent.IdFor(RdpWrapperRuntime.VendorDir)}");
        var wrapperExclusion = At($"{Kinds.ThirdPartyComponent} {DefenderExclusionComponent.IdFor(RdpWrapperRuntime.WrapperDir)}");
        var vendorFile = At($"{Kinds.File} {RdpWrapperRuntime.DefaultVendorExe}");
        var runtime = At($"{Kinds.ThirdPartyComponent} {RdpRuntimeComponent.Id}");
        Assert.True(vendorExclusion < vendorFile && wrapperExclusion < runtime && vendorFile < runtime,
            "Defender exclusions must precede writing and running the runtime");
        Assert.True(At($"{Kinds.Service} {AgentPaths.ServiceName}") < runtime);
        Assert.True(runtime < At($@"{Kinds.WindowsSetting} HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server|fDenyTSConnections"));
        At($@"{Kinds.WindowsSetting} HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp|UserAuthentication");
        At($@"{Kinds.WindowsSetting} HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp|SecurityLayer");
        At($"{Kinds.LocalGroup} CloudBoxUsers");
        Assert.True(At($"{Kinds.FirewallRule} {LicenseGate.AccessRule}") < At($"{Kinds.FirewallRule} {LicenseGate.GateRule}"));
        At($"{Kinds.ScheduledTask} {LicenseGate.WatchdogTask}");
        At($"{Kinds.ScheduledTask} {AgentPaths.StatusTask}");
        At($"{Kinds.ArpEntry} {AgentPaths.ArpKey}");
        Assert.All(runner.Manifest.Entries, e => Assert.Equal("applied", e.Status));
        Assert.Equal(ids.Count, ids.Distinct().Count());

        // Secrets never enter the manifest.
        var json = System.Text.Json.JsonSerializer.Serialize(runner.Manifest, Json.Options);
        Assert.DoesNotContain("CBX-ENROLL-TEST", json);
        Assert.DoesNotContain("device-token", json);
    }

    [Fact]
    public async Task Uninstall_after_a_full_install_reverts_every_entry_and_verify_clean_passes()
    {
        var (machine, store, runner) = Machine();
        var host = new FakeHost();
        host.StatusDocs.Enqueue(Settled);
        await new ServerInstall(runner, host, Options).RunAsync(null, CancellationToken.None);
        Assert.NotEmpty(machine.Values);

        var reloaded = new ManifestRunner(store, Kinds.All.Select(k => new FakeStep(k, machine, keyByKind: true)));
        var result = await new Uninstaller(reloaded, [], new StringReader(""), new StringWriter(), "LAB-PC", [])
            .RunAsync(new UninstallOptions(Offline: true), new RevertContext(), CancellationToken.None);

        Assert.Equal(UninstallStatus.Completed, result.Status);
        Assert.Equal(reloaded.Manifest.Entries.Count, result.Results.Count);
        Assert.All(result.Results, r => Assert.Equal(RevertOutcome.Removed, r.Outcome));
        Assert.Equal(Enumerable.Reverse(reloaded.Manifest.Entries).Select(e => e.Id), machine.RevertOrder);
        Assert.Empty(machine.Values);
        Assert.Equal(0, CleanVerifier.Run(reloaded, reloaded.Manifest.Entries, new StringWriter()));
    }

    [Fact]
    public async Task A_failed_activation_is_rolled_back_completely()
    {
        var (machine, store, runner) = Machine();
        var host = new FakeHost { EnrollFailure = new CloudApiException(CloudFailure.InvalidToken, "expired grant", 400) };

        var result = await new ServerInstall(runner, host, Options).RunAsync(null, CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("enrollment", result.FailedStep);
        Assert.Null(host.Saved);
        Assert.DoesNotContain("restart-service", host.Calls);

        var reloaded = new ManifestRunner(store, Kinds.All.Select(k => new FakeStep(k, machine, keyByKind: true)));
        await new Uninstaller(reloaded, [], new StringReader(""), new StringWriter(), "LAB-PC", [])
            .RunAsync(new UninstallOptions(Offline: true), new RevertContext(), CancellationToken.None);
        Assert.Empty(machine.Values);
    }

    [Fact]
    public async Task Unsupported_windows_changes_nothing()
    {
        var (machine, _, runner) = Machine();
        var result = await new ServerInstall(runner, new FakeHost { Supported = false }, Options).RunAsync(null, CancellationToken.None);
        Assert.False(result.Succeeded);
        Assert.Equal("prerequisites", result.FailedStep);
        Assert.Contains("Home", result.Error!);
        Assert.Empty(runner.Manifest.Entries);
        Assert.Empty(machine.Values);
    }

    [Fact]
    public async Task Health_check_waits_for_the_first_cycle_and_the_managed_users()
    {
        var (_, _, runner) = Machine();
        var host = new FakeHost();
        host.StatusDocs.Enqueue(null);
        host.StatusDocs.Enqueue("""{"enrolled":true,"cloud":"starting"}""");
        host.StatusDocs.Enqueue("""{"enrolled":true,"cloud":"connected","license":{"state":"VALID"},"users":{"configured":2,"limit":6,"state":"reconciled"}}""");
        const string done = """{"enrolled":true,"cloud":"connected","license":{"state":"VALID"},"users":{"configured":6,"limit":6,"state":"reconciled"}}""";
        host.StatusDocs.Enqueue(done);

        var result = await new ServerInstall(runner, host, Options).RunAsync(null, CancellationToken.None);

        Assert.True(result.Succeeded);
        Assert.Equal(done, result.StatusJson);
        Assert.Equal(InstallStepStatus.Done, result.Steps.Last().Status);
    }

    [Fact]
    public void Status_autostart_is_for_the_parent_account_only_and_unelevated()
    {
        var xml = ServerInstall.StatusTaskXml("S-1-5-21-1-2-3-1001");
        Assert.Contains("<LogonTrigger><Enabled>true</Enabled><UserId>S-1-5-21-1-2-3-1001</UserId></LogonTrigger>", xml);
        Assert.Contains("<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>", xml);
        Assert.DoesNotContain("Password", xml);
    }

    /// <summary>Progress&lt;T&gt; posts asynchronously; tests need the reports in order, now.</summary>
    private sealed class SyncProgress(List<InstallProgress> sink) : IProgress<InstallProgress>
    {
        public void Report(InstallProgress value) => sink.Add(value);
    }
}
