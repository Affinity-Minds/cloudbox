// Phase 5 local enforcement, run by the health loop at boot and on every cycle:
//   licence (Slice 3.3) → gate (5.5) → managed users when the slot allowance changed or at boot (5.4) → RDP probe (5.2)
//   → active sessions. Everything is published on the pipe (Status app) and in the §29 health document.
using CloudBox.Agent.Cloud;
using CloudBox.Agent.Gate;
using CloudBox.Agent.Identity;
using CloudBox.Agent.Install;
using CloudBox.Agent.Licensing;
using CloudBox.Agent.ManagedUsers;
using CloudBox.Agent.Rdp;
using CloudBox.Agent.State;
using Serilog;

namespace CloudBox.Agent.Service;

public sealed record UsersView(int? Configured, int? Limit, int? ActiveSessions, string State, IReadOnlyList<string> Conflicts);

public sealed record LocalReport(LicenseSnapshot License, string Gate, UsersView Users, RdpProbeResult Rdp);

public sealed class ServerRuntime(
    LocalLicense license,
    LicenseGate gate,
    Func<ManagedUserReconciler?> reconcilerFactory,
    IRdpRuntime rdp,
    ISessionCounter sessions)
{
    private readonly ILogger _log = Log.ForContext<ServerRuntime>();
    private int? _reconciledLimit;
    private ReconcileResult? _lastReconcile;
    private string? _reconcileError;

    public static ServerRuntime CreateDefault(IDeviceKeyStore keys, ISigningKeysClient signingKeys)
    {
        var accounts = new WindowsLocalAccounts();
        return new ServerRuntime(
            new LocalLicense(keys, signingKeys),
            new LicenseGate(new WindowsFirewall()),
            () =>
            {
                // Managed users exist only on a Server Setup install (the CloudBoxUsers group is its manifest entry).
                if (!accounts.GroupExists(WellKnownGroups.CloudBoxUsers)) return null;
                var users = new ManifestManagedUsers(
                    () => new ManifestRunner(WindowsManifestStore.CreateDefault(), WindowsSteps.Create(keys)), accounts);
                return new ManagedUserReconciler(accounts, users, DpapiCredentialStore.CreateDefault(), WellKnownGroups.RemoteDesktopUsers);
            },
            RdpWrapperRuntime.CreateDefault(),
            new WtsSessions());
    }

    public LocalLicense License => license;

    /// <summary>Fail closed before anything is validated (service start) and when the service stops.</summary>
    public string BlockGate()
    {
        try
        {
            return gate.Block();
        }
        catch (Exception ex)
        {
            _log.Error(ex, "Could not close the RDP gate");
            return "error";
        }
    }

    public async Task<LicenseSnapshot> EvaluateAsync(AgentState state, DateTimeOffset now, string clockState, bool cloudConnected)
    {
        var (claims, error) = await license.VerifyStoredAsync(state);
        if (error is not null) Security.Log.Warning("Stored entitlement rejected by the local verifier ({Reason})", error);
        return LicenseEvaluator.Evaluate(new LicenseInputs
        {
            State = state,
            LocalNow = now,
            ClockState = clockState,
            CloudConnected = cloudConnected,
            Claims = claims,
            VerifyError = error,
        });
    }

    /// <summary>Applies the gate, reconciles users when the allowance changed (and at boot), probes RDP.</summary>
    public LocalReport Enforce(LicenseSnapshot lic)
    {
        string gateState;
        try
        {
            gateState = gate.Apply(lic.State);
        }
        catch (Exception ex)
        {
            _log.Error(ex, "Could not apply the RDP gate for {State}", lic.State);
            gateState = "error";
        }

        var users = ReconcileUsers(lic);

        RdpProbeResult probe;
        try
        {
            probe = rdp.Probe();
        }
        catch (Exception ex)
        {
            _log.Warning(ex, "RDP probe failed");
            probe = new RdpProbeResult(HealthBuilder.Unknown, null, ex.Message);
        }

        return new LocalReport(lic, gateState, users, probe);
    }

    private UsersView ReconcileUsers(LicenseSnapshot lic)
    {
        int? active = null;
        try
        {
            active = WtsSessions.ActiveManaged(sessions.Sessions());
        }
        catch (Exception ex)
        {
            _log.Warning(ex, "Could not enumerate sessions");
        }

        ManagedUserReconciler? reconciler;
        try
        {
            reconciler = reconcilerFactory();
        }
        catch (Exception ex)
        {
            _log.Warning(ex, "Managed users unavailable");
            return new UsersView(null, lic.MaxManagedUsers, active, "error", []);
        }

        if (reconciler is null) return new UsersView(null, lic.MaxManagedUsers, active, "not_installed", []);

        // Only a verified lease says how many slots there are; TAMPER / NO_PLAN never change accounts.
        if (lic.MaxManagedUsers is not { } limit)
        {
            return new UsersView(_lastReconcile?.Configured, null, active, "waiting_for_licence", []);
        }

        if (_reconciledLimit != limit)
        {
            try
            {
                _lastReconcile = reconciler.Reconcile(limit);
                _reconciledLimit = limit;
                _reconcileError = null;
                _log.Information("Managed users reconciled to {Limit}: created {Created}, enabled {Enabled}, disabled {Disabled}, conflicts {Conflicts}",
                    limit, _lastReconcile.Created, _lastReconcile.Enabled, _lastReconcile.Disabled, _lastReconcile.Conflicts);
            }
            catch (Exception ex)
            {
                _reconcileError = ex.Message;
                _log.Error(ex, "Managed user reconciliation to {Limit} failed; retrying next cycle", limit);
            }
        }

        var configured = _lastReconcile?.Configured;
        return new UsersView(configured, limit, active, _reconcileError is null ? "reconciled" : "error",
            _lastReconcile?.Conflicts ?? []);
    }
}
