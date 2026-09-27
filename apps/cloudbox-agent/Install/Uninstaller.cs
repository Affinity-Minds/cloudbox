using System.Text.Json.Nodes;

namespace CloudBox.Agent.Install;

public sealed record UninstallOptions(bool PurgeData = false, bool KeepLogs = false, bool Offline = false);

public enum UninstallStatus
{
    Completed,
    CompletedWithFailures,
    Refused,
}

public sealed record UninstallResult(
    UninstallStatus Status,
    IReadOnlyList<RevertResult> Results,
    string CloudNotification,
    IReadOnlyList<string> SecurityEvents);

public static class PurgeGuard
{
    /// <summary>--purge-data proceeds only when the operator typed this machine's name.</summary>
    public static bool Confirmed(string? typed, string machineName) =>
        !string.IsNullOrWhiteSpace(typed) && string.Equals(typed.Trim(), machineName, StringComparison.OrdinalIgnoreCase);
}

/// <summary>
/// Everything CloudBox can leave on a machine even without a manifest, in install order. Used for orphan cleanup
/// (manifest and its registry backup both lost) and by verify-clean after the manifest is gone.
/// </summary>
public static class WellKnown
{
    public static IReadOnlyList<ManifestEntry> Entries()
    {
        static ManifestEntry E(string kind, string id) => new()
        {
            Kind = kind,
            Id = id,
            PriorState = new JsonObject { ["existed"] = false },
            Status = "well-known",
        };

        return
        [
            E(Kinds.RegistryKey, AgentPaths.RegistryRoot),
            E(Kinds.Directory, AgentPaths.ProgramDataRoot),
            E(Kinds.Directory, AgentPaths.ProgramFilesRoot),
            E(Kinds.Directory, AgentPaths.InstallDir),
            E(Kinds.CngKey, AgentPaths.KeyName),
            E(Kinds.EventLogSource, "CloudBox.Agent"), // Only if a logging provider ever auto-created it.
            E(Kinds.EventLogSource, AgentPaths.EventLogSource),
            E(Kinds.Service, AgentPaths.ServiceName),
            E(Kinds.ArpEntry, AgentPaths.ArpKey),
            // Server Setup (WT-10): CloudBox-named artefacts only. The RDP runtime and Windows settings are not listed:
            // they are not uniquely CloudBox's, so only a manifest entry may revert them.
            E(Kinds.Directory, AgentPaths.StatusDir),
            E(Kinds.ScheduledTask, AgentPaths.StatusTask),
            E(Kinds.Directory, Rdp.RdpWrapperRuntime.VendorDir),
            E(Kinds.LocalGroup, ManagedUsers.WellKnownGroups.CloudBoxUsers),
            E(Kinds.FirewallRule, Gate.LicenseGate.AccessRule),
            E(Kinds.FirewallRule, Gate.LicenseGate.GateRule),
            E(Kinds.ScheduledTask, Gate.LicenseGate.WatchdogTask),
        ];
    }

    /// <summary>Well-known entries not already in <paramref name="manifest"/> go first so they are reverted last.</summary>
    public static List<ManifestEntry> Merge(IEnumerable<ManifestEntry> wellKnown, IReadOnlyList<ManifestEntry> manifest)
    {
        var seen = manifest.Select(Key).ToHashSet(StringComparer.OrdinalIgnoreCase);
        return [.. wellKnown.Where(e => !seen.Contains(Key(e))), .. manifest];
    }

    public static string Key(ManifestEntry e) => e.Kind + "\u0000" + e.Id;
}

/// <summary>Slice 2.5: puts the machine back to its pre-install state by replaying the manifest in reverse.</summary>
public sealed class Uninstaller(
    ManifestRunner runner,
    IEnumerable<ManifestEntry> wellKnown,
    TextReader input,
    TextWriter output,
    string machineName,
    IReadOnlyList<string> dataFolders,
    Func<CancellationToken, Task>? notifyCloud = null,
    Action? preserveLogs = null,
    Action<string>? deleteDataFolder = null)
{
    public async Task<UninstallResult> RunAsync(UninstallOptions options, RevertContext context, CancellationToken ct)
    {
        var security = new List<string>();
        if (options.PurgeData)
        {
            await output.WriteLineAsync(
                $"--purge-data PERMANENTLY deletes customer data in: {string.Join(", ", dataFolders)}");
            await output.WriteAsync($"Type the machine name ({machineName}) to confirm: ");
            var typed = await input.ReadLineAsync(ct);
            if (!PurgeGuard.Confirmed(typed, machineName))
            {
                Security.Log.Warning("Uninstall --purge-data refused: machine name not confirmed");
                await output.WriteLineAsync("Refused: machine name did not match. Nothing was changed.");
                return new UninstallResult(UninstallStatus.Refused, [], "skipped", ["purge-data refused"]);
            }

            Security.Log.Warning("Uninstall --purge-data confirmed for {Machine}; customer data will be deleted", machineName);
            security.Add("purge-data confirmed");
        }

        var cloud = "skipped (--offline)";
        if (!options.Offline)
        {
            if (notifyCloud is null)
            {
                cloud = "skipped (not enrolled)";
            }
            else
            {
                try
                {
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    timeout.CancelAfter(TimeSpan.FromSeconds(15));
                    await notifyCloud(timeout.Token);
                    cloud = "notified";
                }
                catch (Exception ex)
                {
                    cloud = "failed (best effort): " + ex.Message;
                }
            }
        }

        if (options.KeepLogs) preserveLogs?.Invoke();

        var entries = WellKnown.Merge(wellKnown, runner.Manifest.Entries);
        var results = runner.RevertAll(entries, context).ToList();

        if (options.PurgeData)
        {
            foreach (var folder in dataFolders)
            {
                try
                {
                    if (deleteDataFolder is not null) deleteDataFolder(folder);
                    else DeleteIfExists(folder);
                    Security.Log.Warning("Customer data folder {Folder} purged", folder);
                    security.Add($"purged {folder}");
                }
                catch (Exception ex)
                {
                    results.Add(new RevertResult(
                        new ManifestEntry { Kind = "customer_data", Id = folder }, RevertOutcome.Failed, ex.Message));
                }
            }
        }

        var status = results.Any(r => r.Outcome == RevertOutcome.Failed)
            ? UninstallStatus.CompletedWithFailures
            : UninstallStatus.Completed;
        return new UninstallResult(status, results, cloud, security);
    }

    private static void DeleteIfExists(string folder)
    {
        if (Directory.Exists(folder)) Directory.Delete(folder, recursive: true);
    }
}

/// <summary>verify-clean: the lab acceptance test. Exit code 1 when any CloudBox artefact remains.</summary>
public static class CleanVerifier
{
    public static int Run(ManifestRunner runner, IEnumerable<ManifestEntry> entries, TextWriter output)
    {
        var unique = entries.GroupBy(WellKnown.Key, StringComparer.OrdinalIgnoreCase).Select(g => g.Last()).ToList();
        var remaining = runner.Remaining(unique).Select(WellKnown.Key).ToHashSet(StringComparer.OrdinalIgnoreCase);
        output.WriteLine("verify-clean: checking every CloudBox artefact kind");
        foreach (var e in unique)
        {
            output.WriteLine($"  {(remaining.Contains(WellKnown.Key(e)) ? "REMAINS" : "clean"),-8} {e.Kind,-22} {e.Id}");
        }

        foreach (var kind in Kinds.All.Where(k => unique.All(e => e.Kind != k)))
        {
            output.WriteLine($"  {"clean",-8} {kind,-22} (nothing recorded)");
        }

        output.WriteLine(remaining.Count == 0
            ? "CLEAN: no CloudBox artefacts remain."
            : $"NOT CLEAN: {remaining.Count} artefact(s) remain.");
        return remaining.Count == 0 ? 0 : 1;
    }
}
