// Slice 5.5 licence gate (spec §31). Two CloudBox-owned Windows Firewall rules, both installed through the manifest:
//   "CloudBox RDP Access"  allow TCP 3389 inbound (so the gate does not depend on Windows' own Remote Desktop rule group)
//   "CloudBox RDP Gate"    BLOCK TCP 3389 inbound; created ENABLED (default block). Block rules win over allow rules.
// The Agent disables the block rule only while the local verifier says VALID | OFFLINE_VALID | GRACE, and re-enables it
// for anything else, at service start and at service stop. A SYSTEM scheduled task ("CloudBox RDP Gate Watchdog", at
// boot and every minute) re-enables it whenever the Agent service is not running, so a crashed or stopped Agent fails
// closed. Remote scope is any address until the private overlay lands (WT-9 narrows it). The firewall never affects the
// local console, established sessions are not cut, and nothing is deleted to enforce a licence state.
using System.Text;
using CloudBox.Agent.Install;
using CloudBox.Agent.Licensing;

namespace CloudBox.Agent.Gate;

public interface IFirewall
{
    bool RuleExists(string name);

    /// <summary>Null when the rule does not exist.</summary>
    bool? IsEnabled(string name);

    void SetEnabled(string name, bool enabled);
}

public static class GateStates
{
    public const string Open = "open";
    public const string Blocked = "blocked";
    public const string NotInstalled = "not_installed";
}

public sealed class LicenseGate(IFirewall firewall)
{
    public const string GateRule = "CloudBox RDP Gate";
    public const string AccessRule = "CloudBox RDP Access";
    public const string WatchdogTask = "CloudBox RDP Gate Watchdog";
    public const int RdpPort = 3389;

    /// <summary>Opens or closes the gate for <paramref name="licenseState"/>. Unknown states close it.</summary>
    public string Apply(string? licenseState) => Set(block: !LicenseStates.AllowsRemoteAccess(licenseState));

    /// <summary>Fail closed (service start before validation, service stop).</summary>
    public string Block() => Set(block: true);

    private string Set(bool block)
    {
        var enabled = firewall.IsEnabled(GateRule);
        if (enabled is null) return GateStates.NotInstalled;
        if (enabled.Value != block) firewall.SetEnabled(GateRule, block);
        return block ? GateStates.Blocked : GateStates.Open;
    }

    public static string[] AccessRuleArgs() =>
    [
        "dir=in", "action=allow", "protocol=TCP", $"localport={RdpPort}", "remoteip=any", "profile=any", "enable=yes",
        "description=CloudBox managed remote access (allow). Paired with CloudBox RDP Gate.",
    ];

    public static string[] GateRuleArgs() =>
    [
        "dir=in", "action=block", "protocol=TCP", $"localport={RdpPort}", "remoteip=any", "profile=any", "enable=yes",
        "description=CloudBox licence gate: enabled (blocking) unless the CloudBox Agent validated the licence.",
    ];

    /// <summary>Task Scheduler XML for the watchdog: SYSTEM, at boot and every minute, closes the gate when the Agent
    /// service is not running.</summary>
    public static string WatchdogTaskXml()
    {
        var script =
            $"if ((Get-Service -Name '{AgentPaths.ServiceName}' -ErrorAction SilentlyContinue).Status -ne 'Running') " +
            $"{{ Set-NetFirewallRule -DisplayName '{GateRule}' -Enabled True }}";
        var args = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"" + script + "\"";
        return TaskXml.Build(
            "CloudBox: keep the RDP licence gate closed while the CloudBox Agent service is not running.",
            triggers: """
                <BootTrigger><Enabled>true</Enabled></BootTrigger>
                <TimeTrigger><StartBoundary>2026-01-01T00:00:00</StartBoundary><Enabled>true</Enabled><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></TimeTrigger>
                """,
            principal: "<UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel>",
            command: @"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe",
            arguments: args,
            hidden: true);
    }
}

/// <summary>HNetCfg.FwPolicy2 (COM) for reading and toggling a rule; independent of the UI language.</summary>
public sealed class WindowsFirewall : IFirewall
{
    private static dynamic Policy() =>
        Activator.CreateInstance(Type.GetTypeFromProgID("HNetCfg.FwPolicy2", throwOnError: true)!)!;

    private static dynamic? Find(string name)
    {
        try
        {
            return Policy().Rules.Item(name);
        }
        catch (System.Runtime.InteropServices.COMException)
        {
            return null;
        }
        catch (FileNotFoundException)
        {
            return null; // HRESULT 0x80070002: no such rule.
        }
    }

    public bool RuleExists(string name) => Find(name) is not null;

    public bool? IsEnabled(string name)
    {
        var rule = Find(name);
        return rule is null ? null : (bool)rule.Enabled;
    }

    public void SetEnabled(string name, bool enabled)
    {
        // netsh sets every rule with this name (the COM Item() returns only the first).
        ProcessRunner.RunChecked("netsh.exe", "advfirewall", "firewall", "set", "rule", $"name={name}", "new",
            $"enable={(enabled ? "yes" : "no")}");
    }
}

/// <summary>Minimal Task Scheduler 1.2 XML (schtasks /create /xml). No credentials are ever stored in a task.</summary>
public static class TaskXml
{
    public static string Build(string description, string triggers, string principal, string command, string arguments,
        bool hidden)
    {
        static string X(string s) => System.Security.SecurityElement.Escape(s);
        var sb = new StringBuilder();
        sb.Append("<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n");
        sb.Append("<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\n");
        sb.Append($"<RegistrationInfo><Author>CloudBox</Author><Description>{X(description)}</Description></RegistrationInfo>\n");
        sb.Append($"<Triggers>{triggers}</Triggers>\n");
        sb.Append($"<Principals><Principal id=\"Author\">{principal}</Principal></Principals>\n");
        sb.Append("<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
        sb.Append("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
        sb.Append("<AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable>");
        sb.Append("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Enabled>true</Enabled>");
        sb.Append($"<Hidden>{(hidden ? "true" : "false")}</Hidden></Settings>\n");
        sb.Append($"<Actions Context=\"Author\"><Exec><Command>{X(command)}</Command><Arguments>{X(arguments)}</Arguments></Exec></Actions>\n");
        sb.Append("</Task>\n");
        return sb.ToString();
    }
}
