using System.Text.Json.Nodes;
using CloudBox.Agent.Install;

namespace CloudBox.Agent.Tests;

public class ManifestTests
{
    private const string Kind = "registry_value";

    private static (FakeMachine Machine, InMemoryManifestStore Store, ManifestRunner Runner) Setup(string? failOn = null)
    {
        var machine = new FakeMachine();
        var store = new InMemoryManifestStore();
        return (machine, store, new ManifestRunner(store, [new FakeStep(Kind, machine, failOn)]));
    }

    private static JsonObject Value(string v) => new() { ["value"] = v };

    private static Uninstaller UninstallerFor(ManifestRunner runner, string typed = "", Func<CancellationToken, Task>? notify = null,
        List<string>? purged = null, StringWriter? output = null) =>
        new(runner, [], new StringReader(typed + Environment.NewLine), output ?? new StringWriter(), "LAB-PC",
            [@"D:\CloudBoxData"], notify, null, f => purged?.Add(f));

    [Fact]
    public async Task Uninstall_reverts_in_reverse_order_and_restores_prior_values()
    {
        var (machine, store, runner) = Setup();
        machine.Values["b"] = "customer-original";

        runner.Apply(Kind, "a", Value("1"));
        runner.Apply(Kind, "b", Value("cloudbox"));
        runner.Apply(Kind, "c", Value("3"));
        Assert.Equal("cloudbox", machine.Values["b"]);

        // A fresh process reloads the persisted manifest, as `uninstall` does.
        var reloaded = new ManifestRunner(store, [new FakeStep(Kind, machine)]);
        Assert.All(reloaded.Manifest.Entries, e => Assert.Equal("applied", e.Status));
        var result = await UninstallerFor(reloaded).RunAsync(new UninstallOptions(Offline: true), new RevertContext(), CancellationToken.None);

        Assert.Equal(new[] { "c", "b", "a" }, machine.RevertOrder);
        Assert.Equal(new[] { RevertOutcome.Removed, RevertOutcome.Restored, RevertOutcome.Removed }, result.Results.Select(r => r.Outcome));
        Assert.Equal(new Dictionary<string, string> { ["b"] = "customer-original" }, machine.Values);
        Assert.Equal(UninstallStatus.Completed, result.Status);
        Assert.Equal(0, CleanVerifier.Run(reloaded, reloaded.Manifest.Entries, new StringWriter()));
    }

    [Fact]
    public async Task Entry_is_recorded_before_the_step_acts_so_a_failed_install_is_still_cleaned()
    {
        var (machine, store, runner) = Setup(failOn: "c");
        runner.Apply(Kind, "a", Value("1"));
        runner.Apply(Kind, "b", Value("2"));
        Assert.Throws<InvalidOperationException>(() => runner.Apply(Kind, "c", Value("3")));
        Assert.True(machine.Values.ContainsKey("c")); // The failing step left a partial change behind.

        var reloaded = new ManifestRunner(store, [new FakeStep(Kind, machine)]);
        Assert.Equal(new[] { "a", "b", "c" }, reloaded.Manifest.Entries.Select(e => e.Id));
        Assert.Equal("pending", reloaded.Manifest.Entries[2].Status);
        Assert.All(reloaded.Manifest.Entries, e => Assert.False(e.PriorExisted));

        var result = await UninstallerFor(reloaded).RunAsync(new UninstallOptions(Offline: true), new RevertContext(), CancellationToken.None);
        Assert.Empty(machine.Values);
        Assert.Equal(UninstallStatus.Completed, result.Status);
    }

    [Fact]
    public void Verify_clean_fails_while_an_entry_remains()
    {
        var (machine, _, runner) = Setup();
        runner.Apply(Kind, "a", Value("1"));
        runner.Apply(Kind, "b", Value("2"));
        machine.Values.Remove("a");

        var output = new StringWriter();
        Assert.Equal(1, CleanVerifier.Run(runner, runner.Manifest.Entries, output));
        Assert.Contains("REMAINS", output.ToString());
        Assert.Contains("NOT CLEAN: 1", output.ToString());

        machine.Values.Remove("b");
        Assert.Equal(0, CleanVerifier.Run(runner, runner.Manifest.Entries, new StringWriter()));
    }

    [Fact]
    public async Task Well_known_artefacts_are_cleaned_even_without_a_manifest()
    {
        var machine = new FakeMachine();
        machine.Values["orphan"] = "left behind";
        var runner = new ManifestRunner(new InMemoryManifestStore(), [new FakeStep(Kind, machine)]);
        var orphan = new ManifestEntry { Kind = Kind, Id = "orphan", PriorState = new JsonObject { ["existed"] = false } };

        var uninstaller = new Uninstaller(runner, [orphan], new StringReader(""), new StringWriter(), "LAB-PC", []);
        await uninstaller.RunAsync(new UninstallOptions(Offline: true), new RevertContext(), CancellationToken.None);

        Assert.Empty(machine.Values);
    }

    [Theory]
    [InlineData("")]
    [InlineData("OTHER-PC")]
    public async Task Purge_data_is_refused_without_the_typed_machine_name(string typed)
    {
        var (machine, _, runner) = Setup();
        runner.Apply(Kind, "a", Value("1"));
        var purged = new List<string>();
        var notified = false;

        var result = await UninstallerFor(runner, typed, _ => { notified = true; return Task.CompletedTask; }, purged)
            .RunAsync(new UninstallOptions(PurgeData: true), new RevertContext(), CancellationToken.None);

        Assert.Equal(UninstallStatus.Refused, result.Status);
        Assert.Empty(purged);
        Assert.False(notified);
        Assert.Equal("1", machine.Values["a"]); // Nothing was touched.
    }

    [Fact]
    public async Task Purge_data_proceeds_when_the_machine_name_is_typed()
    {
        var (machine, _, runner) = Setup();
        runner.Apply(Kind, "a", Value("1"));
        var purged = new List<string>();

        var result = await UninstallerFor(runner, "lab-pc", purged: purged)
            .RunAsync(new UninstallOptions(PurgeData: true, Offline: true), new RevertContext(), CancellationToken.None);

        Assert.Equal(UninstallStatus.Completed, result.Status);
        Assert.Equal(new[] { @"D:\CloudBoxData" }, purged);
        Assert.Contains("purge-data confirmed", result.SecurityEvents);
        Assert.Empty(machine.Values);
    }

    [Fact]
    public async Task Customer_data_is_never_touched_without_purge_data()
    {
        var (_, _, runner) = Setup();
        runner.Apply(Kind, "a", Value("1"));
        var purged = new List<string>();
        await UninstallerFor(runner, purged: purged)
            .RunAsync(new UninstallOptions(), new RevertContext(), CancellationToken.None);
        Assert.Empty(purged);
    }

    [Fact]
    public async Task Cloud_is_notified_unless_offline_and_failure_is_best_effort()
    {
        var (_, _, runner) = Setup();
        runner.Apply(Kind, "a", Value("1"));
        var calls = 0;

        var offline = await UninstallerFor(runner, notify: _ => { calls++; return Task.CompletedTask; })
            .RunAsync(new UninstallOptions(Offline: true), new RevertContext(), CancellationToken.None);
        Assert.Equal(0, calls);
        Assert.StartsWith("skipped", offline.CloudNotification);

        var failing = await UninstallerFor(runner, notify: _ => throw new HttpRequestException("down"))
            .RunAsync(new UninstallOptions(), new RevertContext(), CancellationToken.None);
        Assert.StartsWith("failed (best effort)", failing.CloudNotification);
        Assert.Equal(UninstallStatus.Completed, failing.Status);
    }

    [Fact]
    public void Every_contract_kind_has_a_windows_step()
    {
        var kinds = WindowsSteps.Create(new InMemoryDeviceKeyStore()).Select(s => s.Kind).OrderBy(k => k);
        Assert.Equal(Kinds.All.OrderBy(k => k), kinds);
    }

    [Fact]
    public void Manifest_entries_carry_the_contract_fields()
    {
        var (_, store, runner) = Setup();
        runner.Apply(Kind, "a", Value("1"));
        var entry = JsonNode.Parse(store.Json!)!["entries"]![0]!.AsObject();
        foreach (var field in new[] { "kind", "id", "createdAt", "priorState" }) Assert.True(entry.TryGetPropertyValue(field, out _), field);
        Assert.False(entry["priorState"]!["existed"]!.GetValue<bool>());
    }
}
