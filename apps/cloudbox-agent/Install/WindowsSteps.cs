// Concrete install steps, one per manifest kind (PLAN_5AM.md §10). Later Windows slices reuse these; if a new kind
// is ever needed, add it here AND to Kinds.All AND to verify-clean, never write to the machine around the manifest.
using System.Diagnostics;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text.Json.Nodes;
using CloudBox.Agent.Identity;
using Microsoft.Win32;

namespace CloudBox.Agent.Install;

public static class WindowsSteps
{
    public static IReadOnlyList<IInstallStep> Create(IDeviceKeyStore keys) =>
    [
        new ServiceStep(),
        new DirectoryStep(),
        new FileStep(),
        new RegistryKeyStep(Kinds.RegistryKey),
        new RegistryKeyStep(Kinds.ArpEntry),
        new RegistryValueStep(Kinds.RegistryValue),
        new RegistryValueStep(Kinds.WindowsSetting),
        new FirewallRuleStep(),
        new LocalUserStep(),
        new LocalGroupMembershipStep(),
        new ScheduledTaskStep(),
        new CngKeyStep(keys),
        new EventLogSourceStep(),
        new ThirdPartyComponentStep(),
    ];

    internal static JsonObject Existed(bool existed) => new() { ["existed"] = existed };

    internal static bool IsUnder(string? path, string dir) =>
        path is not null && Path.GetFullPath(path).StartsWith(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(dir)) + Path.DirectorySeparatorChar,
            StringComparison.OrdinalIgnoreCase);

    /// <summary>String form of a JSON value without JSON quoting.</summary>
    internal static string? Str(JsonNode? n) =>
        n is JsonValue v && v.TryGetValue<string>(out var s) ? s : n?.ToJsonString();

    internal static string[] Args(JsonObject? spec, string name = "args") =>
        spec?[name] is JsonArray a ? a.Select(x => x!.GetValue<string>()).ToArray() : [];
}

/// <summary>Windows service. spec: { binPath, displayName, description }. Automatic (Delayed Start), LocalSystem,
/// recovery restart/restart/restart-with-backoff.</summary>
public sealed class ServiceStep : IInstallStep
{
    public string Kind => Kinds.Service;

    public static bool Exists(string name) =>
        ServiceController.GetServices().Any(s => string.Equals(s.ServiceName, name, StringComparison.OrdinalIgnoreCase));

    public JsonObject CapturePriorState(string id, JsonObject? spec) => WindowsSteps.Existed(Exists(id));

    public void Apply(ManifestEntry e)
    {
        var bin = e.Spec?["binPath"]?.GetValue<string>() ?? throw new ArgumentException("service spec needs binPath");
        if (!Exists(e.Id))
        {
            ProcessRunner.RunChecked("sc.exe", "create", e.Id, "binPath=", $"\"{bin}\"", "start=", "delayed-auto",
                "obj=", "LocalSystem", "DisplayName=", e.Spec?["displayName"]?.GetValue<string>() ?? e.Id);
        }

        if (e.Spec?["description"]?.GetValue<string>() is { } d) ProcessRunner.RunChecked("sc.exe", "description", e.Id, d);
        ConfigureRecovery(e.Id);
    }

    /// <summary>Spec §30: restart, restart, then restart after a longer delay; counters reset daily.</summary>
    public static void ConfigureRecovery(string name)
    {
        ProcessRunner.RunChecked("sc.exe", "config", name, "start=", "delayed-auto");
        ProcessRunner.RunChecked("sc.exe", "failure", name, "reset=", "86400", "actions=", "restart/5000/restart/10000/restart/60000");
        ProcessRunner.RunChecked("sc.exe", "failureflag", name, "1");
    }

    public static void Start(string name, TimeSpan timeout)
    {
        using var sc = new ServiceController(name);
        if (sc.Status != ServiceControllerStatus.Running) sc.Start();
        sc.WaitForStatus(ServiceControllerStatus.Running, timeout);
    }

    public RevertOutcome Revert(ManifestEntry e, RevertContext context)
    {
        if (e.PriorExisted) return RevertOutcome.Restored;
        if (!Exists(e.Id)) return RevertOutcome.Missing;
        using (var sc = new ServiceController(e.Id))
        {
            if (sc.Status is not (ServiceControllerStatus.Stopped or ServiceControllerStatus.StopPending)) sc.Stop();
            sc.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30));
        }

        ProcessRunner.RunChecked("sc.exe", "delete", e.Id);
        return RevertOutcome.Removed;
    }

    public bool Remains(ManifestEntry e) => !e.PriorExisted && Exists(e.Id);
}

/// <summary>Directory. spec: { acl: "system-admins" } restricts it to SYSTEM and Administrators.</summary>
public sealed class DirectoryStep : IInstallStep
{
    public string Kind => Kinds.Directory;

    public JsonObject CapturePriorState(string id, JsonObject? spec) => WindowsSteps.Existed(Directory.Exists(id));

    public void Apply(ManifestEntry e)
    {
        var dir = Directory.CreateDirectory(e.Id);
        if (e.Spec?["acl"]?.GetValue<string>() == "system-admins")
        {
            var sec = new DirectorySecurity();
            sec.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
            foreach (var sid in new[] { WellKnownSidType.LocalSystemSid, WellKnownSidType.BuiltinAdministratorsSid })
            {
                sec.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid, null), FileSystemRights.FullControl,
                    InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None,
                    AccessControlType.Allow));
            }

            dir.SetAccessControl(sec);
        }
    }

    public RevertOutcome Revert(ManifestEntry e, RevertContext context)
    {
        if (e.PriorExisted) return RevertOutcome.Restored;
        if (!Directory.Exists(e.Id)) return RevertOutcome.Missing;
        if (WindowsSteps.IsUnder(context.ProcessPath, e.Id))
        {
            // Delete everything except the running exe; a detached cmd removes the rest after exit.
            foreach (var f in Directory.EnumerateFiles(e.Id, "*", SearchOption.AllDirectories))
            {
                if (!string.Equals(Path.GetFullPath(f), Path.GetFullPath(context.ProcessPath!), StringComparison.OrdinalIgnoreCase))
                {
                    File.Delete(f);
                }
            }

            context.SelfDeletePaths.Add(e.Id);
            return RevertOutcome.Scheduled;
        }

        Directory.Delete(e.Id, recursive: true);
        return RevertOutcome.Removed;
    }

    public bool Remains(ManifestEntry e) => !e.PriorExisted && Directory.Exists(e.Id);
}

/// <summary>File. spec: { source }.</summary>
public sealed class FileStep : IInstallStep
{
    public string Kind => Kinds.File;

    public JsonObject CapturePriorState(string id, JsonObject? spec) => WindowsSteps.Existed(File.Exists(id));

    public void Apply(ManifestEntry e)
    {
        var source = e.Spec?["source"]?.GetValue<string>() ?? throw new ArgumentException("file spec needs source");
        if (!string.Equals(Path.GetFullPath(source), Path.GetFullPath(e.Id), StringComparison.OrdinalIgnoreCase))
        {
            File.Copy(source, e.Id, overwrite: true);
        }
    }

    public RevertOutcome Revert(ManifestEntry e, RevertContext context)
    {
        if (e.PriorExisted) return RevertOutcome.Restored;
        if (!File.Exists(e.Id)) return RevertOutcome.Missing;
        if (context.ProcessPath is not null &&
            string.Equals(Path.GetFullPath(context.ProcessPath), Path.GetFullPath(e.Id), StringComparison.OrdinalIgnoreCase))
        {
            context.SelfDeletePaths.Add(e.Id);
            return RevertOutcome.Scheduled;
        }

        File.Delete(e.Id);
        return RevertOutcome.Removed;
    }

    public bool Remains(ManifestEntry e) => !e.PriorExisted && File.Exists(e.Id);
}

internal static class Reg
{
    /// <summary>"HKLM\SOFTWARE\X" → (HKLM base key in the 64-bit view, "SOFTWARE\X").</summary>
    public static (RegistryKey Root, string SubKey) Parse(string path)
    {
        var i = path.IndexOf('\\');
        var hive = i < 0 ? path : path[..i];
        var sub = i < 0 ? "" : path[(i + 1)..];
        var h = hive.ToUpperInvariant() switch
        {
            "HKLM" or "HKEY_LOCAL_MACHINE" => RegistryHive.LocalMachine,
            "HKCU" or "HKEY_CURRENT_USER" => RegistryHive.CurrentUser,
            "HKU" or "HKEY_USERS" => RegistryHive.Users,
            _ => throw new ArgumentException($"Unsupported registry hive in '{path}'"),
        };
        return (RegistryKey.OpenBaseKey(h, RegistryView.Registry64), sub);
    }

    public static bool KeyExists(string path)
    {
        var (root, sub) = Parse(path);
        using (root)
        using (var k = root.OpenSubKey(sub))
        {
            return k is not null;
        }
    }
}

/// <summary>Registry key (kind registry_key) and Apps &amp; Features entry (kind arp_entry, id = full key path).
/// spec: { values: { name: string | number } } — numbers are written as DWORD.</summary>
public sealed class RegistryKeyStep(string kind) : IInstallStep
{
    public string Kind { get; } = kind;

    public JsonObject CapturePriorState(string id, JsonObject? spec) => WindowsSteps.Existed(Reg.KeyExists(id));

    public void Apply(ManifestEntry e)
    {
        var (root, sub) = Reg.Parse(e.Id);
        using (root)
        using (var key = root.CreateSubKey(sub, writable: true))
        {
            if (e.Spec?["values"] is not JsonObject values) return;
            foreach (var (name, node) in values)
            {
                if (node is JsonValue v && v.TryGetValue<int>(out var n)) key.SetValue(name, n, RegistryValueKind.DWord);
                else key.SetValue(name, node?.GetValue<string>() ?? "", RegistryValueKind.String);
            }
        }
    }

    public RevertOutcome Revert(ManifestEntry e, RevertContext context)
    {
        if (e.PriorExisted) return RevertOutcome.Restored;
        if (!Reg.KeyExists(e.Id)) return RevertOutcome.Missing;
        var (root, sub) = Reg.Parse(e.Id);
        using (root) root.DeleteSubKeyTree(sub, throwOnMissingSubKey: false);
        return RevertOutcome.Removed;
    }

    public bool Remains(ManifestEntry e) => !e.PriorExisted && Reg.KeyExists(e.Id);
}

/// <summary>Registry value (kinds registry_value and windows_setting, e.g. fDenyTSConnections).
/// id = "HKLM\key\path|ValueName"; spec: { value: string | number }. priorState keeps the old value and type.</summary>
public sealed class RegistryValueStep(string kind) : IInstallStep
{
    public string Kind { get; } = kind;

    private static (string Key, string Name) Split(string id)
    {
        var i = id.LastIndexOf('|');
        return i < 0 ? throw new ArgumentException($"registry value id must be 'key|name': {id}") : (id[..i], id[(i + 1)..]);
    }

    private static (bool Exists, object? Value, RegistryValueKind Kind) Read(string id)
    {
        var (path, name) = Split(id);
        var (root, sub) = Reg.Parse(path);
        using (root)
        using (var k = root.OpenSubKey(sub))
        {
            if (k is null || !k.GetValueNames().Contains(name, StringComparer.OrdinalIgnoreCase)) return (false, null, RegistryValueKind.Unknown);
            return (true, k.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames), k.GetValueKind(name));
        }
    }

    private static void Write(string id, JsonNode? value, RegistryValueKind? kind = null)
    {
        var (path, name) = Split(id);
        var (root, sub) = Reg.Parse(path);
        using (root)
        using (var k = root.CreateSubKey(sub, writable: true))
        {
            if (value is JsonValue v && v.TryGetValue<int>(out var n) && kind is null or RegistryValueKind.DWord)
            {
                k.SetValue(name, n, RegistryValueKind.DWord);
            }
            else
            {
                k.SetValue(name, WindowsSteps.Str(value) ?? "", kind is RegistryValueKind.ExpandString ? kind.Value : RegistryValueKind.String);
            }
        }
    }

    public JsonObject CapturePriorState(string id, JsonObject? spec)
    {
        var (exists, value, kind) = Read(id);
        var prior = WindowsSteps.Existed(exists);
        if (exists && kind is not (RegistryValueKind.String or RegistryValueKind.ExpandString or RegistryValueKind.DWord))
        {
            // Refuse to change what we could not restore exactly.
            throw new NotSupportedException($"Prior value kind {kind} of {id} cannot be captured for restore");
        }

        if (exists)
        {
            prior["valueKind"] = kind.ToString();
            prior["value"] = value is int i ? JsonValue.Create(i) : JsonValue.Create(value?.ToString());
        }

        return prior;
    }

    public void Apply(ManifestEntry e) => Write(e.Id, e.Spec?["value"]);

    public RevertOutcome Revert(ManifestEntry e, RevertContext context)
    {
        var (exists, _, _) = Read(e.Id);
        if (e.PriorExisted)
        {
            var kind = Enum.Parse<RegistryValueKind>(e.PriorState!["valueKind"]!.GetValue<string>());
            Write(e.Id, e.PriorState["value"]?.DeepClone(), kind);
            return RevertOutcome.Restored;
        }

        if (!exists) return RevertOutcome.Missing;
        var (path, name) = Split(e.Id);
        var (root, sub) = Reg.Parse(path);
        using (root)
        using (var k = root.OpenSubKey(sub, writable: true))
        {
            k?.DeleteValue(name, throwOnMissingValue: false);
        }

        return RevertOutcome.Removed;
    }

    public bool Remains(ManifestEntry e)
    {
        var (exists, value, _) = Read(e.Id);
        if (!e.PriorExisted) return exists;
        var prior = e.PriorState!["value"];
        var current = value is int i ? i.ToString(System.Globalization.CultureInfo.InvariantCulture) : value?.ToString();
        return !exists || WindowsSteps.Str(prior) != current;
    }
}

/// <summary>Windows Firewall rule via netsh. id = rule name; spec: { args: ["dir=in", "action=allow", ...] }.</summary>
public sealed class FirewallRuleStep : IInstallStep
{
    public string Kind => Kinds.FirewallRule;

    private static bool Exists(string name) =>
        ProcessRunner.Run("netsh.exe", ["advfirewall", "firewall", "show", "rule", $"name={name}"]).ExitCode == 0;

    public JsonObject CapturePriorState(string id, JsonObject? spec) => WindowsSteps.Existed(Exists(id));

    public void Apply(ManifestEntry e) =>
        ProcessRunner.RunChecked("netsh.exe", ["advfirewall", "firewall", "add", "rule", $"name={e.Id}", .. WindowsSteps.Args(e.Spec)]);

    public RevertOutcome Revert(ManifestEntry e, RevertContext context)
    {
        if (e.PriorExisted) return RevertOutcome.Restored;
        if (!Exists(e.Id)) return RevertOutcome.Missing;
        ProcessRunner.RunChecked("netsh.exe", "advfirewall", "firewall", "delete", "rule", $"name={e.Id}");
        return RevertOutcome.Removed;
    }

    public bool Remains(ManifestEntry e) => !e.PriorExisted && Exists(e.Id);
}

/// <summary>Local user. Created disabled without a password; the owning slice sets credentials through its own
/// reversible steps. Passwords never enter the manifest.</summary>
public sealed class LocalUserStep : IInstallStep
{
    public string Kind => Kinds.LocalUser;

    private static bool Exists(string name) => ProcessRunner.Run("net.exe", ["user", name]).ExitCode == 0;

    public JsonObject CapturePriorState(string id, JsonObject? spec) => WindowsSteps.Existed(Exists(id));

    public void Apply(ManifestEntry e) =>
        ProcessRunner.RunChecked("net.exe", "user", e.Id, "/add", "/active:no", "/passwordreq:yes");

    public RevertOutcome Revert(ManifestEntry e, RevertContext context)
    {
        if (e.PriorExisted) return RevertOutcome.Restored;
        if (!Exists(e.Id)) return RevertOutcome.Missing;
        ProcessRunner.RunChecked("net.exe", "user", e.Id, "/delete");
        return RevertOutcome.Removed;
    }

    public bool Remains(ManifestEntry e) => !e.PriorExisted && Exists(e.Id);
}

/// <summary>Local group membership. id = "Group|User".</summary>
public sealed class LocalGroupMembershipStep : IInstallStep
{
    public string Kind => Kinds.LocalGroupMembership;

    private static (string Group, string User) Split(string id)
    {
        var i = id.IndexOf('|');
        return i < 0 ? throw new ArgumentException($"membership id must be 'group|user': {id}") : (id[..i], id[(i + 1)..]);
    }

    private static bool IsMember(string id)
    {
        var (group, user) = Split(id);
        var r = ProcessRunner.Run("net.exe", ["localgroup", group]);
        return r.ExitCode == 0 && r.Output.Split('\n').Any(l => string.Equals(l.Trim(), user, StringComparison.OrdinalIgnoreCase));
    }

    public JsonObject CapturePriorState(string id, JsonObject? spec) => WindowsSteps.Existed(IsMember(id));

    public void Apply(ManifestEntry e)
    {
        var (group, user) = Split(e.Id);
        ProcessRunner.RunChecked("net.exe", "localgroup", group, user, "/add");
    }

    public RevertOutcome Revert(ManifestEntry e, RevertContext context)
    {
        if (e.PriorExisted) return RevertOutcome.Restored;
        if (!IsMember(e.Id)) return RevertOutcome.Missing;
        var (group, user) = Split(e.Id);
        ProcessRunner.RunChecked("net.exe", "localgroup", group, user, "/delete");
        return RevertOutcome.Removed;
    }

    public bool Remains(ManifestEntry e) => !e.PriorExisted && IsMember(e.Id);
}

/// <summary>Scheduled task via schtasks. id = task path (e.g. \CloudBox\Status); spec: { args: [...] } for /create.</summary>
public sealed class ScheduledTaskStep : IInstallStep
{
    public string Kind => Kinds.ScheduledTask;

    private static bool Exists(string name) => ProcessRunner.Run("schtasks.exe", ["/query", "/tn", name]).ExitCode == 0;

    public JsonObject CapturePriorState(string id, JsonObject? spec) => WindowsSteps.Existed(Exists(id));

    public void Apply(ManifestEntry e) =>
        ProcessRunner.RunChecked("schtasks.exe", ["/create", "/tn", e.Id, .. WindowsSteps.Args(e.Spec), "/f"]);

    public RevertOutcome Revert(ManifestEntry e, RevertContext context)
    {
        if (e.PriorExisted) return RevertOutcome.Restored;
        if (!Exists(e.Id)) return RevertOutcome.Missing;
        ProcessRunner.RunChecked("schtasks.exe", "/delete", "/tn", e.Id, "/f");
        return RevertOutcome.Removed;
    }

    public bool Remains(ManifestEntry e) => !e.PriorExisted && Exists(e.Id);
}

/// <summary>Device key. id = CNG key name.</summary>
public sealed class CngKeyStep(IDeviceKeyStore keys) : IInstallStep
{
    public string Kind => Kinds.CngKey;

    public JsonObject CapturePriorState(string id, JsonObject? spec) => WindowsSteps.Existed(keys.Exists());

    public void Apply(ManifestEntry e) => keys.OpenOrCreate();

    public RevertOutcome Revert(ManifestEntry e, RevertContext context)
    {
        if (e.PriorExisted) return RevertOutcome.Restored;
        return keys.Delete() ? RevertOutcome.Removed : RevertOutcome.Missing;
    }

    public bool Remains(ManifestEntry e) => !e.PriorExisted && keys.Exists();
}

/// <summary>Event log source. spec: { log: "Application" }.</summary>
public sealed class EventLogSourceStep : IInstallStep
{
    public string Kind => Kinds.EventLogSource;

    public JsonObject CapturePriorState(string id, JsonObject? spec) => WindowsSteps.Existed(EventLog.SourceExists(id));

    public void Apply(ManifestEntry e)
    {
        if (!EventLog.SourceExists(e.Id))
        {
            EventLog.CreateEventSource(e.Id, e.Spec?["log"]?.GetValue<string>() ?? "Application");
        }
    }

    public RevertOutcome Revert(ManifestEntry e, RevertContext context)
    {
        if (e.PriorExisted) return RevertOutcome.Restored;
        if (!EventLog.SourceExists(e.Id)) return RevertOutcome.Missing;
        EventLog.DeleteEventSource(e.Id);
        return RevertOutcome.Removed;
    }

    public bool Remains(ManifestEntry e) => !e.PriorExisted && EventLog.SourceExists(e.Id);
}

/// <summary>Bundled third-party component (RDP Wrapper, Netclient, ...). spec: { install: {file, args[]},
/// uninstall: {file, args[]}, probe: path-or-registry-key proving presence }.</summary>
public sealed class ThirdPartyComponentStep : IInstallStep
{
    public string Kind => Kinds.ThirdPartyComponent;

    private static bool Present(JsonObject? spec)
    {
        var probe = spec?["probe"]?.GetValue<string>();
        if (string.IsNullOrEmpty(probe)) return false;
        return probe.StartsWith("HK", StringComparison.OrdinalIgnoreCase) ? Reg.KeyExists(probe) : Path.Exists(probe);
    }

    public JsonObject CapturePriorState(string id, JsonObject? spec) => WindowsSteps.Existed(Present(spec));

    public void Apply(ManifestEntry e) => RunCommand(e.Spec?["install"] as JsonObject);

    private static void RunCommand(JsonObject? cmd)
    {
        var file = cmd?["file"]?.GetValue<string>() ?? throw new ArgumentException("third_party_component command needs file");
        ProcessRunner.RunChecked(file, WindowsSteps.Args(cmd));
    }

    public RevertOutcome Revert(ManifestEntry e, RevertContext context)
    {
        if (e.PriorExisted) return RevertOutcome.Restored;
        if (!Present(e.Spec)) return RevertOutcome.Missing;
        RunCommand(e.Spec?["uninstall"] as JsonObject);
        return RevertOutcome.Removed;
    }

    public bool Remains(ManifestEntry e) => !e.PriorExisted && Present(e.Spec);
}
