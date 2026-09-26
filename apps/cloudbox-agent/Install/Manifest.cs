// ---------------------------------------------------------------------------------------------------------------
// Uninstall contract (docs/plans/PLAN_5AM.md §10, Slice 2.5). BINDING ON EVERY LATER WINDOWS SLICE.
//
// Anything CloudBox changes on a machine (RDP Wrapper, Netclient, managed users, firewall gate, Status autostart,
// Windows settings, ...) MUST be installed through ManifestRunner.Apply with one of the kinds below, so that the
// entry {kind, id, createdAt, priorState} is persisted BEFORE the change happens and `uninstall` can put the
// machine back exactly as it was. Never write to the machine directly from feature code.
// ---------------------------------------------------------------------------------------------------------------
using System.Text.Json;
using System.Text.Json.Nodes;
using CloudBox.Agent.State;
using Microsoft.Win32;

namespace CloudBox.Agent.Install;

public static class Kinds
{
    public const string Service = "service";
    public const string Directory = "directory";
    public const string File = "file";
    public const string RegistryKey = "registry_key";
    public const string RegistryValue = "registry_value";
    public const string FirewallRule = "firewall_rule";
    public const string LocalUser = "local_user";
    public const string LocalGroupMembership = "local_group_membership";
    public const string ScheduledTask = "scheduled_task";
    public const string CngKey = "cng_key";
    public const string EventLogSource = "event_log_source";
    public const string WindowsSetting = "windows_setting";
    public const string ThirdPartyComponent = "third_party_component";
    public const string ArpEntry = "arp_entry";

    public static readonly IReadOnlyList<string> All =
    [
        Service, Directory, File, RegistryKey, RegistryValue, FirewallRule, LocalUser, LocalGroupMembership,
        ScheduledTask, CngKey, EventLogSource, WindowsSetting, ThirdPartyComponent, ArpEntry,
    ];
}

/// <summary>
/// One recorded install action. Contract fields: kind, id, createdAt, priorState. Additive fields: spec (what was
/// applied, never secrets) and status ("pending" until the action completed, so a crash mid-step is still reverted).
/// </summary>
public sealed class ManifestEntry
{
    public required string Kind { get; init; }
    public required string Id { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public JsonObject? PriorState { get; init; }
    public JsonObject? Spec { get; init; }
    public string Status { get; set; } = "pending";

    public bool PriorExisted => PriorState?["existed"]?.GetValue<bool>() ?? false;
}

public sealed class InstallManifest
{
    public int Version { get; init; } = 1;
    public string AgentVersion { get; init; } = AgentPaths.AgentVersion;
    public List<ManifestEntry> Entries { get; init; } = [];
}

public interface IManifestStore
{
    InstallManifest? Load();
    void Save(InstallManifest manifest);
}

/// <summary>
/// C:\ProgramData\CloudBox\install-manifest.json plus a DPAPI-protected copy in HKLM\SOFTWARE\CloudBox\ManifestBackup,
/// so a deleted ProgramData folder does not orphan the uninstall.
/// </summary>
public sealed class WindowsManifestStore(string filePath, string backupSubKey, IBlobProtector protector) : IManifestStore
{
    private const string ValueName = "Manifest";

    public static WindowsManifestStore CreateDefault() => new(AgentPaths.ManifestFile, AgentPaths.ManifestBackupSubKey,
        new DpapiProtector("CloudBox.Agent.Manifest.v1"));

    public InstallManifest? Load()
    {
        if (File.Exists(filePath))
        {
            return JsonSerializer.Deserialize<InstallManifest>(File.ReadAllBytes(filePath), Json.Options);
        }

        using var hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        using var key = hklm.OpenSubKey(backupSubKey);
        return key?.GetValue(ValueName) is byte[] blob
            ? JsonSerializer.Deserialize<InstallManifest>(protector.Unprotect(blob), Json.Options)
            : null;
    }

    public void Save(InstallManifest manifest)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(manifest, Json.Indented);
        using (var hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
        using (var key = hklm.CreateSubKey(backupSubKey, writable: true))
        {
            key.SetValue(ValueName, protector.Protect(bytes), RegistryValueKind.Binary);
        }

        // The ProgramData folder is itself a manifest entry; until it exists the registry copy is authoritative.
        var dir = Path.GetDirectoryName(filePath)!;
        if (Directory.Exists(dir)) File.WriteAllBytes(filePath, bytes);
    }
}

public enum RevertOutcome
{
    Removed,
    Restored,
    Missing,
    Scheduled,
    Failed,
}

public sealed class RevertContext
{
    /// <summary>The running executable. It cannot delete itself; its folder is handed to a detached cmd.</summary>
    public string? ProcessPath { get; init; } = Environment.ProcessPath;

    public List<string> SelfDeletePaths { get; } = [];
}

/// <summary>One reversible install action kind.</summary>
public interface IInstallStep
{
    string Kind { get; }

    /// <summary>Snapshot of what exists before the change. Must contain <c>existed</c>.</summary>
    JsonObject CapturePriorState(string id, JsonObject? spec);

    void Apply(ManifestEntry entry);

    /// <summary>Idempotent: restores priorState, or removes what install created.</summary>
    RevertOutcome Revert(ManifestEntry entry, RevertContext context);

    /// <summary>True while a CloudBox change for this entry is still present on the machine.</summary>
    bool Remains(ManifestEntry entry);
}

public sealed record RevertResult(ManifestEntry Entry, RevertOutcome Outcome, string? Error);

public sealed class ManifestRunner
{
    private readonly IManifestStore _store;
    private readonly IReadOnlyDictionary<string, IInstallStep> _steps;
    private readonly TimeProvider _clock;

    public ManifestRunner(IManifestStore store, IEnumerable<IInstallStep> steps, TimeProvider? clock = null)
    {
        _store = store;
        _steps = steps.ToDictionary(s => s.Kind);
        _clock = clock ?? TimeProvider.System;
        Manifest = store.Load() ?? new InstallManifest();
    }

    public InstallManifest Manifest { get; }

    public IInstallStep Step(string kind) =>
        _steps.TryGetValue(kind, out var s) ? s : throw new InvalidOperationException($"No install step for kind '{kind}'");

    /// <summary>Record-then-act: the entry is persisted as pending before the step touches the machine.</summary>
    public ManifestEntry Apply(string kind, string id, JsonObject? spec = null)
    {
        var step = Step(kind);
        var entry = new ManifestEntry
        {
            Kind = kind,
            Id = id,
            CreatedAt = _clock.GetUtcNow(),
            PriorState = step.CapturePriorState(id, spec),
            Spec = spec,
        };
        Manifest.Entries.Add(entry);
        _store.Save(Manifest);
        step.Apply(entry);
        entry.Status = "applied";
        _store.Save(Manifest);
        return entry;
    }

    /// <summary>Replays entries in reverse. Never stops at a failure; every entry gets an outcome.</summary>
    public IReadOnlyList<RevertResult> RevertAll(IReadOnlyList<ManifestEntry> entries, RevertContext context)
    {
        var results = new List<RevertResult>();
        for (var i = entries.Count - 1; i >= 0; i--)
        {
            var entry = entries[i];
            try
            {
                results.Add(new RevertResult(entry, Step(entry.Kind).Revert(entry, context), null));
            }
            catch (Exception ex)
            {
                results.Add(new RevertResult(entry, RevertOutcome.Failed, ex.Message));
            }
        }

        return results;
    }

    public IReadOnlyList<ManifestEntry> Remaining(IEnumerable<ManifestEntry> entries) =>
        entries.Where(e =>
        {
            try
            {
                return Step(e.Kind).Remains(e);
            }
            catch (Exception)
            {
                return true; // Cannot prove it is gone: treat as remaining.
            }
        }).ToList();
}
