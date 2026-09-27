using System.Security.Principal;
using System.ServiceProcess;
using System.Text.Json;
using System.Text.Json.Nodes;
using CloudBox.Agent.Cloud;
using CloudBox.Agent.Identity;
using CloudBox.Agent.Install;
using CloudBox.Agent.Service;
using CloudBox.Agent.State;
using Microsoft.Win32;

namespace CloudBox.Agent;

/// <summary>Minimal "--name value" / "--flag" parser. Values are never echoed (the enroll token is a secret).</summary>
public sealed class CliArgs
{
    private readonly Dictionary<string, string?> _values = new(StringComparer.OrdinalIgnoreCase);

    public static CliArgs Parse(IReadOnlyList<string> args)
    {
        var parsed = new CliArgs();
        for (var i = 0; i < args.Count; i++)
        {
            if (!args[i].StartsWith("--", StringComparison.Ordinal)) continue;
            var name = args[i][2..];
            var hasValue = i + 1 < args.Count && !args[i + 1].StartsWith("--", StringComparison.Ordinal);
            parsed._values[name] = hasValue ? args[++i] : null;
        }

        return parsed;
    }

    public string? Value(string name) => _values.GetValueOrDefault(name);

    public bool Flag(string name) => _values.ContainsKey(name);
}

public static class Cli
{
    public const string Usage = """
        CloudBox.Agent.exe <verb> [options]   (run from an elevated prompt)

          install --base-url https://box.affinityminds.in --enroll-token CBX-ENROLL-...
          status
          repair
          uninstall [--purge-data] [--keep-logs] [--offline]
          verify-clean
          version
        """;

    public static async Task<int> RunAsync(string[] args)
    {
        var verb = args[0].ToLowerInvariant();
        var a = CliArgs.Parse(args[1..]);
        try
        {
            return verb switch
            {
                "install" => await InstallAsync(a),
                "uninstall" => await UninstallAsync(a),
                "repair" => Repair(),
                "verify-clean" => VerifyClean(),
                "status" => Status(),
                "version" or "--version" => Print(AgentPaths.AgentVersion, 0),
                _ => Print(Usage, 2),
            };
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"ERROR: {ex.Message}");
            return 1;
        }
    }

    private static int Print(string text, int code)
    {
        Console.WriteLine(text);
        return code;
    }

    private static bool RequireAdmin()
    {
        using var id = WindowsIdentity.GetCurrent();
        if (new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator)) return true;
        Console.Error.WriteLine("This command must run from an elevated (Run as administrator) prompt.");
        return false;
    }

    private static (IDeviceKeyStore Keys, IManifestStore Store, ManifestRunner Runner) Machine()
    {
        var keys = new CngDeviceKeyStore(AgentPaths.KeyName);
        var store = WindowsManifestStore.CreateDefault();
        return (keys, store, new ManifestRunner(store, WindowsSteps.Create(keys)));
    }

    // ---------------------------------------------------------------- install

    private static async Task<int> InstallAsync(CliArgs a)
    {
        if (!RequireAdmin()) return 1;
        var baseUrlText = a.Value("base-url");
        var token = a.Value("enroll-token");
        if (string.IsNullOrWhiteSpace(baseUrlText) || string.IsNullOrWhiteSpace(token)) return Print(Usage, 2);
        if (!Uri.TryCreate(baseUrlText, UriKind.Absolute, out var baseUrl) ||
            (baseUrl.Scheme != Uri.UriSchemeHttps && !baseUrl.IsLoopback))
        {
            Console.Error.WriteLine("--base-url must be an https:// URL.");
            return 2;
        }

        var (keys, _, runner) = Machine();
        if (runner.Manifest.Entries.Count > 0)
        {
            Console.Error.WriteLine("CloudBox Agent is already installed. Use `repair`, or `uninstall` first.");
            return 1;
        }

        var leftovers = runner.Remaining(WellKnown.Entries());
        if (leftovers.Count > 0)
        {
            Console.Error.WriteLine("Leftover CloudBox artefacts found (no install manifest):");
            foreach (var e in leftovers) Console.Error.WriteLine($"  {e.Kind,-22} {e.Id}");
            Console.Error.WriteLine("Run `CloudBox.Agent.exe uninstall` first, then install again.");
            return 1;
        }

        using var http = AgentApiClient.CreateHttpClient();
        var api = new AgentApiClient(http);
        var stateStore = FileStateStore.CreateDefault();
        AgentState? state = null;
        try
        {
            Console.WriteLine("Installing CloudBox Agent " + AgentPaths.AgentVersion);
            runner.Apply(Kinds.RegistryKey, AgentPaths.RegistryRoot);
            runner.Apply(Kinds.Directory, AgentPaths.ProgramDataRoot, new JsonObject { ["acl"] = "system-admins" });
            runner.Apply(Kinds.Directory, AgentPaths.ProgramFilesRoot);
            runner.Apply(Kinds.Directory, AgentPaths.InstallDir);
            runner.Apply(Kinds.File, AgentPaths.InstalledExe, new JsonObject { ["source"] = Environment.ProcessPath });
            runner.Apply(Kinds.CngKey, AgentPaths.KeyName);
            var key = keys.TryOpen() ?? throw new InvalidOperationException("Device key was not created.");
            Console.WriteLine($"  device key: {key.KeyProtection}{(key.KeyProtection == "software" ? " (no usable TPM: lower assurance, Fleet shows DEGRADED)" : "")}");

            var device = new EnrollDevice(Environment.MachineName, WindowsBuild(), AgentPaths.AgentVersion, key.KeyProtection, key.Jwk);
            var enrolled = await api.EnrollAsync(baseUrl, token, device, CancellationToken.None);
            state = new AgentState
            {
                BaseUrl = baseUrl.GetLeftPart(UriPartial.Authority),
                DeviceId = enrolled.DeviceId,
                TenantId = enrolled.TenantId,
                TenantCode = enrolled.TenantCode,
                DeviceName = enrolled.DeviceName,
                DeviceToken = enrolled.DeviceToken,
                KeyProtection = key.KeyProtection,
                KeyThumbprint = key.Thumbprint,
                EnrolledAt = DateTimeOffset.UtcNow,
            };
            stateStore.Save(state);
            Console.WriteLine($"  enrolled: {enrolled.DeviceName} ({enrolled.DeviceId}) tenant {enrolled.TenantCode}");
            await PinSigningKeysAsync(api, stateStore, state);

            runner.Apply(Kinds.EventLogSource, AgentPaths.EventLogSource, new JsonObject { ["log"] = "Application" });
            runner.Apply(Kinds.Service, AgentPaths.ServiceName, new JsonObject
            {
                ["binPath"] = AgentPaths.InstalledExe,
                ["displayName"] = AgentPaths.ServiceDisplayName,
                ["description"] = AgentPaths.ServiceDescription,
            });
            runner.Apply(Kinds.ArpEntry, AgentPaths.ArpKey, new JsonObject
            {
                ["values"] = new JsonObject
                {
                    ["DisplayName"] = AgentPaths.ServiceDisplayName,
                    ["DisplayVersion"] = AgentPaths.AgentVersion,
                    ["Publisher"] = AgentPaths.Publisher,
                    ["InstallLocation"] = AgentPaths.InstallDir,
                    ["DisplayIcon"] = AgentPaths.InstalledExe,
                    ["UninstallString"] = $"\"{AgentPaths.InstalledExe}\" uninstall",
                    ["EstimatedSize"] = (int)(new FileInfo(AgentPaths.InstalledExe).Length / 1024),
                    ["NoModify"] = 1,
                    ["NoRepair"] = 1,
                },
            });
            ServiceStep.Start(AgentPaths.ServiceName, TimeSpan.FromSeconds(60));
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Install failed: {ex.Message}");
            Console.Error.WriteLine("Rolling back everything recorded in the install manifest...");
            var rollback = await RunUninstallAsync(runner, new UninstallOptions(Offline: state is null), state, api);
            PrintReport(rollback);
            return 1;
        }

        Console.WriteLine($"CloudBox Agent installed. Service {AgentPaths.ServiceName} is running (Automatic, Delayed Start).");
        Console.WriteLine("Check it with: CloudBox.Agent.exe status");
        return 0;
    }

    /// <summary>Pins the server's public entitlement-signing keys (best effort: the verifier re-fetches on first use).</summary>
    public static async Task PinSigningKeysAsync(ISigningKeysClient api, ILocalStateStore store, AgentState state)
    {
        try
        {
            var keys = await api.GetSigningKeysAsync(new Uri(state.BaseUrl), state.DeviceToken, CancellationToken.None);
            foreach (var k in keys)
            {
                if (!state.PinnedSigningKeys.Contains(k)) state.PinnedSigningKeys.Add(k);
            }

            store.Save(state);
        }
        catch (CloudApiException ex)
        {
            Console.Error.WriteLine($"  signing keys not pinned yet ({ex.Message}); the agent fetches them on first use");
        }
    }

    public static string WindowsBuild()
    {
        var v = Environment.OSVersion.Version;
        using var k = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
        return k?.GetValue("UBR") is int ubr ? $"{v.Major}.{v.Minor}.{v.Build}.{ubr}" : v.ToString();
    }

    // ---------------------------------------------------------------- uninstall

    private static async Task<int> UninstallAsync(CliArgs a)
    {
        if (!RequireAdmin()) return 1;
        var (_, _, runner) = Machine();
        AgentState? state = null;
        try
        {
            state = FileStateStore.CreateDefault().Load();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Could not read agent state ({ex.Message}); the cloud will not be notified.");
        }

        using var http = AgentApiClient.CreateHttpClient();
        var options = new UninstallOptions(a.Flag("purge-data"), a.Flag("keep-logs"), a.Flag("offline"));
        var result = await RunUninstallAsync(runner, options, state, new AgentApiClient(http));
        if (result.Status == UninstallStatus.Refused) return 2;
        PrintReport(result);
        return result.Status == UninstallStatus.Completed ? 0 : 1;
    }

    private static async Task<UninstallResult> RunUninstallAsync(
        ManifestRunner runner, UninstallOptions options, AgentState? state, IUninstallNotifier api)
    {
        var context = new RevertContext();
        StopAgentService(); // Nothing may re-create managed users or reopen the gate while the manifest is replayed.
        Func<CancellationToken, Task>? notify = state is null
            ? null
            : ct => api.NotifyUninstalledAsync(new Uri(state.BaseUrl), state.DeviceToken, ct);
        var uninstaller = new Uninstaller(runner, WellKnown.Entries(), Console.In, Console.Out, Environment.MachineName,
            AgentPaths.CustomerDataFolders, notify, PreserveLogs);
        var result = await uninstaller.RunAsync(options, context, CancellationToken.None);
        if (result.Status == UninstallStatus.Refused) return result;

        try
        {
            var report = new
            {
                machine = Environment.MachineName,
                agentVersion = AgentPaths.AgentVersion,
                finishedAt = DateTimeOffset.UtcNow,
                options,
                status = result.Status.ToString(),
                cloud = result.CloudNotification,
                securityEvents = result.SecurityEvents,
                results = result.Results.Select(r => new { entry = r.Entry, outcome = r.Outcome.ToString().ToLowerInvariant(), error = r.Error }),
            };
            File.WriteAllText(AgentPaths.UninstallReportFile, JsonSerializer.Serialize(report, Json.Indented));
        }
        catch (IOException ex)
        {
            Console.Error.WriteLine($"Could not write report file: {ex.Message}");
        }

        ProcessRunner.ScheduleSelfDelete(context.SelfDeletePaths);
        return result;
    }

    private static void StopAgentService()
    {
        try
        {
            if (!ServiceStep.Exists(AgentPaths.ServiceName)) return;
            using var sc = new ServiceController(AgentPaths.ServiceName);
            if (sc.Status is ServiceControllerStatus.Stopped or ServiceControllerStatus.StopPending) return;
            sc.Stop();
            sc.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30));
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ServiceProcess.TimeoutException)
        {
            Console.Error.WriteLine($"Could not stop {AgentPaths.ServiceName} first ({ex.Message}); continuing");
        }
    }

    private static void PreserveLogs()
    {
        if (!Directory.Exists(AgentPaths.LogsDir)) return;
        var target = Path.Combine(Path.GetTempPath(), $"CloudBox-logs-{DateTime.UtcNow:yyyyMMddHHmmss}");
        Directory.CreateDirectory(target);
        foreach (var f in Directory.EnumerateFiles(AgentPaths.LogsDir))
        {
            File.Copy(f, Path.Combine(target, Path.GetFileName(f)), overwrite: true);
        }

        Console.WriteLine($"Logs kept in {target}");
    }

    private static void PrintReport(UninstallResult result)
    {
        Console.WriteLine();
        Console.WriteLine("Uninstall report");
        Console.WriteLine("----------------");
        foreach (var r in result.Results)
        {
            Console.WriteLine($"  {r.Outcome.ToString().ToLowerInvariant(),-9} {r.Entry.Kind,-22} {r.Entry.Id}{(r.Error is null ? "" : "  ERROR: " + r.Error)}");
        }

        Console.WriteLine($"  cloud notification: {result.CloudNotification}");
        foreach (var s in result.SecurityEvents) Console.WriteLine($"  SECURITY: {s}");
        Console.WriteLine($"Result: {result.Status}. Report saved to {AgentPaths.UninstallReportFile}");
        Console.WriteLine("'scheduled' items are removed a few seconds after this process exits. Then run: CloudBox.Agent.exe verify-clean");
    }

    // ---------------------------------------------------------------- verify-clean

    private static int VerifyClean()
    {
        if (!RequireAdmin()) return 1;
        var (_, _, runner) = Machine();
        var entries = WellKnown.Merge(WellKnown.Entries(), [.. runner.Manifest.Entries, .. ReportEntries()]);
        return CleanVerifier.Run(runner, entries, Console.Out);
    }

    private static IEnumerable<ManifestEntry> ReportEntries()
    {
        try
        {
            if (!File.Exists(AgentPaths.UninstallReportFile)) return [];
            var doc = JsonNode.Parse(File.ReadAllText(AgentPaths.UninstallReportFile));
            return (doc?["results"] as JsonArray ?? new JsonArray())
                .Select(r => r?["entry"]?.Deserialize<ManifestEntry>(Json.Options))
                .Where(e => e is not null && Kinds.All.Contains(e.Kind))
                .Select(e => e!)
                .ToList();
        }
        catch (Exception ex) when (ex is IOException or JsonException)
        {
            return [];
        }
    }

    // ---------------------------------------------------------------- repair / status

    private static int Repair()
    {
        if (!RequireAdmin()) return 1;
        var (_, _, runner) = Machine();
        if (runner.Manifest.Entries.Count == 0)
        {
            Console.Error.WriteLine("CloudBox Agent is not installed (no install manifest).");
            return 1;
        }

        var failures = 0;
        foreach (var entry in runner.Manifest.Entries)
        {
            var step = runner.Step(entry.Kind);
            if (entry.PriorExisted || step.Remains(entry))
            {
                Console.WriteLine($"  ok        {entry.Kind,-22} {entry.Id}");
                continue;
            }

            if (entry.Kind == Kinds.CngKey)
            {
                Console.WriteLine($"  MISSING   {entry.Kind,-22} {entry.Id}  device key lost: uninstall, then install with a new token");
                failures++;
                continue;
            }

            var toApply = entry;
            if (entry.Kind == Kinds.File && !string.Equals(entry.Id, AgentPaths.InstalledExe, StringComparison.OrdinalIgnoreCase))
            {
                // Status app / runtime package files come from Setup's payload: only Setup can restore them.
                Console.WriteLine($"  MISSING   {entry.Kind,-22} {entry.Id}  run CloudBox Server Setup again to restore it");
                failures++;
                continue;
            }

            if (entry.Kind is Kinds.ThirdPartyComponent or Kinds.LocalUser or Kinds.LocalGroupMembership)
            {
                // Runtime and managed users have their own repair paths below / in the Agent service.
                Console.WriteLine($"  skipped   {entry.Kind,-22} {entry.Id}");
                continue;
            }

            if (entry.Kind == Kinds.File)
            {
                toApply = new ManifestEntry
                {
                    Kind = entry.Kind,
                    Id = entry.Id,
                    PriorState = entry.PriorState,
                    Spec = new JsonObject { ["source"] = Environment.ProcessPath },
                };
            }

            try
            {
                step.Apply(toApply);
                Console.WriteLine($"  repaired  {entry.Kind,-22} {entry.Id}");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"  FAILED    {entry.Kind,-22} {entry.Id}  {ex.Message}");
                failures++;
            }
        }

        if (runner.Manifest.Entries.Any(e => e.Kind == Kinds.ThirdPartyComponent && e.Id == Rdp.RdpRuntimeComponent.Id))
        {
            var rdp = Rdp.RdpWrapperRuntime.CreateDefault();
            var before = rdp.Probe();
            var after = before.State == Rdp.RdpStates.Healthy ? before : rdp.Repair();
            Console.WriteLine($"  rdp       {before.State} -> {after.State}  {after.Detail}");
            if (after.State != Rdp.RdpStates.Healthy) failures++;
        }

        if (ServiceStep.Exists(AgentPaths.ServiceName))
        {
            ServiceStep.ConfigureRecovery(AgentPaths.ServiceName);
            ServiceStep.Start(AgentPaths.ServiceName, TimeSpan.FromSeconds(60));
            Console.WriteLine("  service recovery policy re-applied; service running");
        }

        return failures == 0 ? 0 : 1;
    }

    private static int Status()
    {
        Console.WriteLine($"CloudBox Agent {AgentPaths.AgentVersion}");
        string service;
        if (ServiceStep.Exists(AgentPaths.ServiceName))
        {
            using var sc = new ServiceController(AgentPaths.ServiceName);
            service = sc.Status.ToString();
        }
        else
        {
            service = "not installed";
        }

        Console.WriteLine($"Service {AgentPaths.ServiceName}: {service}");
        var live = StatusPipeServer.TryRead();
        if (live is not null)
        {
            Console.WriteLine(live);
            return 0;
        }

        Console.WriteLine("Status pipe not available; reading local state instead.");
        try
        {
            var (state, error) = StateBinding.LoadBound(FileStateStore.CreateDefault(), new CngDeviceKeyStore(AgentPaths.KeyName));
            if (error is not null) Console.WriteLine($"State: {error}");
            else if (state is null) Console.WriteLine("Enrolled: no");
            else
            {
                Console.WriteLine($"Enrolled: yes  {state.DeviceName} ({state.DeviceId}) tenant {state.TenantCode}");
                Console.WriteLine($"Key protection: {state.KeyProtection}");
                Console.WriteLine($"Last heartbeat: {state.LastHeartbeatAt?.ToString("u") ?? "never"}");
                Console.WriteLine($"Entitlement generation: {state.EntitlementGeneration}");
            }
        }
        catch (UnauthorizedAccessException)
        {
            Console.WriteLine("State: run from an elevated prompt to read local state.");
        }

        return 0;
    }
}
