// Slice 5.1: the CloudBox Server install plan, run by CloudBox.Server.Setup.exe (UI and silent mode). Every machine
// change goes through ManifestRunner.Apply (record-then-act), so `CloudBox.Agent.exe uninstall` and `verify-clean` cover
// all of it, and a failure part-way is rolled back through the same path. Non-manifest actions (prerequisite checks,
// enrollment, starting the service, reading its health) go through IServerInstallHost so the order is unit-tested.
using System.Text.Json.Nodes;
using CloudBox.Agent.Cloud;
using CloudBox.Agent.Gate;
using CloudBox.Agent.Identity;
using CloudBox.Agent.ManagedUsers;
using CloudBox.Agent.Rdp;
using CloudBox.Agent.State;

namespace CloudBox.Agent.Install;

public sealed record ServerInstallOptions(Uri BaseUrl, string EnrollToken, string ParentAccountSid, string VcRedistInstaller)
{
    /// <summary>Names inside Setup's payload (FileStep <c>spec.resource</c>).</summary>
    public string AgentResource { get; init; } = "agent/CloudBox.Agent.exe";

    public string RdpWrapperResource { get; init; } = "vendor/" + RdpWrapperRuntime.ExeName;

    /// <summary>Every file of the Status publish folder: CloudBox.Status.exe plus the WPF native libraries.</summary>
    public IReadOnlyList<string> StatusResources { get; init; } = ["status/CloudBox.Status.exe"];
}

public sealed record PrerequisiteReport(bool Supported, string Os, bool TpmPresent, string? Refusal);

/// <summary>What the install needs from the machine besides manifest steps. Faked in tests.</summary>
public interface IServerInstallHost
{
    PrerequisiteReport CheckPrerequisites();

    DeviceKeyInfo DeviceKey();

    Task<EnrollResponse> EnrollAsync(Uri baseUrl, string token, EnrollDevice device, CancellationToken ct);

    Task<IReadOnlyList<string>> SigningKeysAsync(Uri baseUrl, string deviceToken, CancellationToken ct);

    void SaveState(AgentState state);

    /// <summary>Starts, or restarts, the Agent service so its first cycle runs now.</summary>
    void RestartAgentService();

    /// <summary>Probes the RDP runtime (listener wait after the Windows settings step).</summary>
    RdpProbeResult ProbeRdp();

    /// <summary>The Agent's status pipe document, or null when it is not answering yet.</summary>
    string? ReadStatus();

    Task DelayAsync(TimeSpan delay, CancellationToken ct);
}

public enum InstallStepStatus
{
    Pending,
    Running,
    Done,
    Warning,
    Failed,
}

public sealed record InstallStepDefinition(string Key, string Title);

public sealed record InstallProgress(string Key, InstallStepStatus Status, string? Detail);

public sealed record ServerInstallResult(
    bool Succeeded,
    string? FailedStep,
    string? Error,
    EnrollResponse? Enrollment,
    PrerequisiteReport? Prerequisites,
    string? StatusJson,
    IReadOnlyList<InstallProgress> Steps);

public sealed class ServerInstall(ManifestRunner runner, IServerInstallHost host, ServerInstallOptions options)
{
    public static readonly IReadOnlyList<InstallStepDefinition> Steps =
    [
        new("prerequisites", "Check this PC (Windows edition, 64-bit, TPM)"),
        new("vcredist", "Install the Microsoft Visual C++ runtime"),
        new("agent", "Install the CloudBox Agent service"),
        new("status", "Install the CloudBox Status app"),
        new("rdp-runtime", "Install the remote session runtime"),
        new("rdp-settings", "Turn on Remote Desktop with Network Level Authentication"),
        new("managed-users", "Prepare managed remote users"),
        new("firewall-gate", "Install the licence gate (firewall)"),
        new("network", "Private network (added in a later release)"),
        new("enrollment", "Activate this server"),
        new("health-check", "First health check"),
    ];

    public static readonly TimeSpan HealthCheckTimeout = TimeSpan.FromMinutes(3);

    private const string TerminalServer = @"HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server";
    private const string RdpTcp = TerminalServer + @"\WinStations\RDP-Tcp";

    public async Task<ServerInstallResult> RunAsync(IProgress<InstallProgress>? progress, CancellationToken ct)
    {
        var log = new List<InstallProgress>();
        EnrollResponse? enrolled = null;
        PrerequisiteReport? prereq = null;
        string? status = null;

        void Report(string key, InstallStepStatus s, string? detail = null)
        {
            var p = new InstallProgress(key, s, detail);
            log.Add(p);
            progress?.Report(p);
        }

        foreach (var step in Steps)
        {
            ct.ThrowIfCancellationRequested();
            Report(step.Key, InstallStepStatus.Running);
            try
            {
                string? warning = null;
                switch (step.Key)
                {
                    case "prerequisites":
                        prereq = host.CheckPrerequisites();
                        if (!prereq.Supported) throw new InvalidOperationException(prereq.Refusal ?? "This PC is not supported");
                        if (!prereq.TpmPresent) warning = "No usable TPM: the device key is software-protected (Fleet shows DEGRADED)";
                        break;
                    case "vcredist":
                        runner.Apply(Kinds.ThirdPartyComponent, VcRedistComponent.Id,
                            new JsonObject { ["installer"] = options.VcRedistInstaller });
                        break;
                    case "agent":
                        ApplyAgent();
                        break;
                    case "status":
                        ApplyStatus();
                        break;
                    case "rdp-runtime":
                        ApplyRdpRuntime();
                        break;
                    case "rdp-settings":
                        warning = await ApplyRdpSettingsAsync(ct);
                        break;
                    case "managed-users":
                        runner.Apply(Kinds.LocalGroup, WellKnownGroups.CloudBoxUsers,
                            new JsonObject { ["description"] = "CloudBox managed remote users" });
                        runner.Apply(Kinds.Directory, DpapiCredentialStore.DefaultFolder, new JsonObject { ["acl"] = "system-admins" });
                        break;
                    case "firewall-gate":
                        ApplyGate();
                        break;
                    case "network":
                        warning = null; // Placeholder: WT-9 installs the private network client here. Records nothing.
                        break;
                    case "enrollment":
                        enrolled = await EnrollAsync(ct);
                        break;
                    case "health-check":
                        (status, warning) = await HealthCheckAsync(ct);
                        break;
                }

                Report(step.Key, warning is null ? InstallStepStatus.Done : InstallStepStatus.Warning, warning);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                Report(step.Key, InstallStepStatus.Failed, ex.Message);
                return new ServerInstallResult(false, step.Key, ex.Message, enrolled, prereq, status, log);
            }
        }

        return new ServerInstallResult(true, null, null, enrolled, prereq, status, log);
    }

    private void ApplyAgent()
    {
        runner.Apply(Kinds.RegistryKey, AgentPaths.RegistryRoot);
        runner.Apply(Kinds.Directory, AgentPaths.ProgramDataRoot, new JsonObject { ["acl"] = "system-admins" });
        runner.Apply(Kinds.Directory, AgentPaths.ProgramFilesRoot);
        runner.Apply(Kinds.Directory, AgentPaths.InstallDir);
        runner.Apply(Kinds.File, AgentPaths.InstalledExe, new JsonObject { ["resource"] = options.AgentResource });
        runner.Apply(Kinds.CngKey, AgentPaths.KeyName);
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
                ["DisplayName"] = AgentPaths.ServerDisplayName,
                ["DisplayVersion"] = AgentPaths.AgentVersion,
                ["Publisher"] = AgentPaths.Publisher,
                ["InstallLocation"] = AgentPaths.ProgramFilesRoot,
                ["DisplayIcon"] = AgentPaths.InstalledExe,
                ["UninstallString"] = $"\"{AgentPaths.InstalledExe}\" uninstall",
                ["NoModify"] = 1,
                ["NoRepair"] = 1,
            },
        });
    }

    private void ApplyStatus()
    {
        runner.Apply(Kinds.Directory, AgentPaths.StatusDir);
        foreach (var resource in options.StatusResources)
        {
            runner.Apply(Kinds.File, Path.Combine(AgentPaths.StatusDir, Path.GetFileName(resource)),
                new JsonObject { ["resource"] = resource });
        }

        runner.Apply(Kinds.ScheduledTask, AgentPaths.StatusTask, new JsonObject { ["xml"] = StatusTaskXml(options.ParentAccountSid) });
    }

    /// <summary>Starts CloudBox Status at logon of the parent/console account only (spec §13, §14.1), unelevated.</summary>
    public static string StatusTaskXml(string parentSid) => TaskXml.Build(
        "CloudBox: show the CloudBox Status window for the local maintenance account.",
        triggers: $"<LogonTrigger><Enabled>true</Enabled><UserId>{System.Security.SecurityElement.Escape(parentSid)}</UserId></LogonTrigger>",
        principal: $"<UserId>{System.Security.SecurityElement.Escape(parentSid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>",
        command: AgentPaths.StatusExe,
        arguments: "",
        hidden: false);

    private void ApplyRdpRuntime()
    {
        // Exclusions first: Defender must not quarantine the runtime while it is written or while it extracts TermWrap.
        runner.Apply(Kinds.ThirdPartyComponent, DefenderExclusionComponent.IdFor(RdpWrapperRuntime.VendorDir));
        runner.Apply(Kinds.ThirdPartyComponent, DefenderExclusionComponent.IdFor(RdpWrapperRuntime.WrapperDir));
        runner.Apply(Kinds.Directory, RdpWrapperRuntime.VendorDir);
        runner.Apply(Kinds.File, RdpWrapperRuntime.DefaultVendorExe, new JsonObject { ["resource"] = options.RdpWrapperResource });
        runner.Apply(Kinds.ThirdPartyComponent, RdpRuntimeComponent.Id);
    }

    private async Task<string?> ApplyRdpSettingsAsync(CancellationToken ct)
    {
        runner.Apply(Kinds.WindowsSetting, $@"{TerminalServer}|fDenyTSConnections", new JsonObject { ["value"] = 0 });
        runner.Apply(Kinds.WindowsSetting, $@"{RdpTcp}|UserAuthentication", new JsonObject { ["value"] = 1 });
        runner.Apply(Kinds.WindowsSetting, $@"{RdpTcp}|SecurityLayer", new JsonObject { ["value"] = 2 });

        // The listener starts once connections are allowed; give it a moment.
        for (var i = 0; i < 15; i++)
        {
            var probe = host.ProbeRdp();
            if (probe.State == RdpStates.Healthy) return null;
            await host.DelayAsync(TimeSpan.FromSeconds(2), ct);
        }

        var last = host.ProbeRdp();
        return last.State == RdpStates.Healthy ? null : $"{last.State}: {last.Detail}";
    }

    private void ApplyGate()
    {
        runner.Apply(Kinds.FirewallRule, LicenseGate.AccessRule, Args(LicenseGate.AccessRuleArgs()));
        runner.Apply(Kinds.FirewallRule, LicenseGate.GateRule, Args(LicenseGate.GateRuleArgs())); // Created blocking.
        runner.Apply(Kinds.ScheduledTask, LicenseGate.WatchdogTask, new JsonObject { ["xml"] = LicenseGate.WatchdogTaskXml() });
    }

    private static JsonObject Args(IEnumerable<string> args) =>
        new() { ["args"] = new JsonArray(args.Select(a => (JsonNode?)JsonValue.Create(a)).ToArray()) };

    private async Task<EnrollResponse> EnrollAsync(CancellationToken ct)
    {
        var key = host.DeviceKey();
        var device = new EnrollDevice(Environment.MachineName, Cli.WindowsBuild(), AgentPaths.AgentVersion, key.KeyProtection, key.Jwk);
        var enrolled = await host.EnrollAsync(options.BaseUrl, options.EnrollToken, device, ct);
        var state = new AgentState
        {
            BaseUrl = options.BaseUrl.GetLeftPart(UriPartial.Authority),
            DeviceId = enrolled.DeviceId,
            TenantId = enrolled.TenantId,
            TenantCode = enrolled.TenantCode,
            DeviceName = enrolled.DeviceName,
            DeviceToken = enrolled.DeviceToken,
            KeyProtection = key.KeyProtection,
            KeyThumbprint = key.Thumbprint,
            EnrolledAt = DateTimeOffset.UtcNow,
            CloudLicenseState = enrolled.LicenseState,
            CloudMessage = enrolled.Message,
        };
        try
        {
            state.PinnedSigningKeys.AddRange(await host.SigningKeysAsync(options.BaseUrl, enrolled.DeviceToken, ct));
        }
        catch (CloudApiException)
        {
            // Not fatal: the verifier fetches the keys the first time a lease names an unpinned kid.
        }

        host.SaveState(state);
        host.RestartAgentService();
        return enrolled;
    }

    private async Task<(string? Status, string? Warning)> HealthCheckAsync(CancellationToken ct)
    {
        var until = HealthCheckTimeout;
        var waited = TimeSpan.Zero;
        string? last = null;
        while (waited < until)
        {
            last = host.ReadStatus();
            if (last is not null && HealthSettled(last)) return (last, null);
            await host.DelayAsync(TimeSpan.FromSeconds(3), ct);
            waited += TimeSpan.FromSeconds(3);
        }

        return (last, last is null
            ? "The CloudBox Agent did not answer yet; open CloudBox Status in a few minutes"
            : "The first licence check is still running; CloudBox Status shows the result when it finishes");
    }

    /// <summary>Settled = enrolled, first cycle done, and (when licensed) the managed users are in place.</summary>
    public static bool HealthSettled(string statusJson)
    {
        try
        {
            var doc = JsonNode.Parse(statusJson);
            if (doc?["enrolled"]?.GetValue<bool>() != true) return false;
            if (doc["cloud"]?.GetValue<string>() is null or "starting") return false;
            var license = doc["license"]?["state"]?.GetValue<string>();
            if (license is null) return false;
            if (!Licensing.LicenseStates.AllowsRemoteAccess(license)) return true;
            var users = doc["users"];
            int? limit = users?["limit"] is JsonValue l ? l.GetValue<int>() : null;
            int? configured = users?["configured"] is JsonValue c ? c.GetValue<int>() : null;
            return users?["state"]?.GetValue<string>() is "not_installed" or "error" || (limit is not null && configured == limit);
        }
        catch (Exception ex) when (ex is System.Text.Json.JsonException or InvalidOperationException or FormatException)
        {
            return false;
        }
    }
}
