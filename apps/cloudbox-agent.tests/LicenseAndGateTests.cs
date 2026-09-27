using CloudBox.Agent.Gate;
using CloudBox.Agent.Licensing;
using CloudBox.Agent.State;

namespace CloudBox.Agent.Tests;

public sealed class LicenseEvaluatorTests
{
    private static readonly DateTimeOffset ValidFrom = DateTimeOffset.Parse("2026-09-27T00:00:00Z");
    private static readonly DateTimeOffset ValidUntil = DateTimeOffset.Parse("2027-09-27T00:00:00Z");

    private static EntitlementClaims Claims(int generation = 1) => new()
    {
        Iss = "cloudbox", Kid = "k", Jti = "lic_1", LicenseId = "lic_1", TenantId = "ten_1", DeviceId = "dev_1",
        DeviceKeyThumbprint = "t", MaxManagedUsers = 6, ValidFrom = ValidFrom, ValidUntil = ValidUntil,
        RenewalWarningDays = 30, OfflineGraceDays = 7, Generation = generation,
    };

    private static AgentState Leased(int generation = 1)
    {
        var s = TestState.For(new InMemoryDeviceKeyStore().OpenOrCreate());
        s.Entitlement = "jwe";
        s.EntitlementGeneration = generation;
        s.HighestEntitlementGeneration = generation;
        return s;
    }

    private static LicenseSnapshot Eval(AgentState s, DateTimeOffset now, bool connected = true, EntitlementClaims? claims = null,
        string? error = null, string clock = TrustedTimeState.Healthy) =>
        LicenseEvaluator.Evaluate(new LicenseInputs
        {
            State = s,
            LocalNow = now,
            CloudConnected = connected,
            Claims = error is null ? claims ?? Claims(s.EntitlementGeneration) : null,
            VerifyError = error,
            ClockState = clock,
        });

    [Fact]
    public void Valid_online_and_offline_with_days_remaining()
    {
        var now = DateTimeOffset.Parse("2027-01-01T00:00:00Z");
        var online = Eval(Leased(), now);
        Assert.Equal(LicenseStates.Valid, online.State);
        Assert.Equal(269, online.DaysRemaining);
        Assert.False(online.RenewalDue);
        Assert.Equal(6, online.MaxManagedUsers);
        Assert.Equal(LicenseStates.OfflineValid, Eval(Leased(), now, connected: false).State);
    }

    [Fact]
    public void Renewal_is_due_inside_the_warning_window()
    {
        var snap = Eval(Leased(), ValidUntil.AddDays(-10));
        Assert.Equal(LicenseStates.Valid, snap.State);
        Assert.True(snap.RenewalDue);
        Assert.Equal(10, snap.DaysRemaining);
    }

    [Fact]
    public void Grace_then_expired()
    {
        var grace = Eval(Leased(), ValidUntil.AddDays(3), connected: false);
        Assert.Equal(LicenseStates.Grace, grace.State);
        Assert.Equal(4, grace.GraceDaysRemaining);
        Assert.Equal(LicenseStates.Expired, Eval(Leased(), ValidUntil.AddDays(8)).State);
    }

    [Fact]
    public void Trusted_time_high_water_mark_wins_over_a_clock_set_back()
    {
        var s = Leased();
        s.TrustedTime.ObserveServerTime(ValidUntil.AddDays(30));
        // The local clock claims an earlier date; the lease is still evaluated at the trusted time.
        Assert.Equal(LicenseStates.Expired, Eval(s, DateTimeOffset.Parse("2027-01-01T00:00:00Z")).State);
    }

    [Fact]
    public void Clock_rollback_verifier_failure_and_stale_generation_are_tamper()
    {
        var now = DateTimeOffset.Parse("2027-01-01T00:00:00Z");
        Assert.Equal("clock_rollback", Eval(Leased(), now, clock: TrustedTimeState.ClockRollbackSuspected).Reason);
        var bad = Eval(Leased(), now, error: EntitlementErrors.DeviceMismatch);
        Assert.Equal(LicenseStates.Tamper, bad.State);
        Assert.Equal(EntitlementErrors.DeviceMismatch, bad.Reason);

        var stale = Leased(1);
        stale.HighestEntitlementGeneration = 2;
        var snap = Eval(stale, now);
        Assert.Equal(LicenseStates.Tamper, snap.State);
        Assert.Equal("stale_generation", snap.Reason);

        var otherDevice = Eval(Leased(), now, claims: Claims() with { DeviceId = "dev_2" });
        Assert.Equal(LicenseStates.Tamper, otherDevice.State);
    }

    [Fact]
    public void Revocation_by_the_cloud_blocks()
    {
        var now = DateTimeOffset.Parse("2027-01-01T00:00:00Z");
        var s = Leased();
        s.EntitlementRevoked = true;
        Assert.Equal(LicenseStates.Revoked, Eval(s, now).State);

        var device = Leased();
        device.DeviceRevoked = true;
        Assert.Equal(LicenseStates.Revoked, Eval(device, now).State);
        Assert.Equal("device_revoked", Eval(device, now).Reason);
    }

    [Fact]
    public void No_lease_is_no_plan_with_the_cloud_message()
    {
        var s = TestState.For(new InMemoryDeviceKeyStore().OpenOrCreate());
        s.CloudLicenseState = CloudLicenseStates.NoActivePlan;
        s.CloudMessage = CloudLicenseStates.NoActivePlanMessage;
        var snap = Eval(s, DateTimeOffset.UtcNow);
        Assert.Equal(LicenseStates.NoPlan, snap.State);
        Assert.Equal("No active plan found. Please contact the CloudBox admin.", snap.Message);
        Assert.Null(snap.MaxManagedUsers);
    }
}

public sealed class LicenseGateTests
{
    private sealed class FakeFirewall : IFirewall
    {
        public Dictionary<string, bool> Rules { get; } = new() { [LicenseGate.GateRule] = true };
        public int Writes { get; private set; }

        public bool RuleExists(string name) => Rules.ContainsKey(name);

        public bool? IsEnabled(string name) => Rules.TryGetValue(name, out var e) ? e : null;

        public void SetEnabled(string name, bool enabled)
        {
            Writes++;
            Rules[name] = enabled;
        }
    }

    [Theory]
    [InlineData(LicenseStates.Valid, false)]
    [InlineData(LicenseStates.OfflineValid, false)]
    [InlineData(LicenseStates.Grace, false)]
    [InlineData(LicenseStates.Expired, true)]
    [InlineData(LicenseStates.Tamper, true)]
    [InlineData(LicenseStates.Revoked, true)]
    [InlineData(LicenseStates.NoPlan, true)]
    [InlineData("SOMETHING_NEW", true)]
    [InlineData(null, true)]
    public void Block_rule_follows_the_licence_state(string? state, bool blocked)
    {
        var fw = new FakeFirewall();
        var result = new LicenseGate(fw).Apply(state);
        Assert.Equal(blocked, fw.Rules[LicenseGate.GateRule]);
        Assert.Equal(blocked ? GateStates.Blocked : GateStates.Open, result);
    }

    [Fact]
    public void Gate_is_idempotent_and_block_fails_closed()
    {
        var fw = new FakeFirewall();
        var gate = new LicenseGate(fw);
        gate.Apply(LicenseStates.Valid);
        gate.Apply(LicenseStates.Valid);
        Assert.Equal(1, fw.Writes);
        Assert.Equal(GateStates.Blocked, gate.Block());
        Assert.True(fw.Rules[LicenseGate.GateRule]);
    }

    [Fact]
    public void Missing_rule_is_reported_not_created()
    {
        var fw = new FakeFirewall();
        fw.Rules.Clear();
        Assert.Equal(GateStates.NotInstalled, new LicenseGate(fw).Apply(LicenseStates.Valid));
        Assert.Empty(fw.Rules);
    }

    [Fact]
    public void Watchdog_task_closes_the_gate_only_when_the_agent_is_not_running()
    {
        var xml = LicenseGate.WatchdogTaskXml();
        Assert.Contains("<BootTrigger>", xml);
        Assert.Contains("<Interval>PT1M</Interval>", xml);
        Assert.Contains("S-1-5-18", xml);
        Assert.Contains("Get-Service -Name &apos;CloudBoxAgent&apos;", xml);
        Assert.Contains("Set-NetFirewallRule -DisplayName &apos;CloudBox RDP Gate&apos; -Enabled True", xml);
    }
}
