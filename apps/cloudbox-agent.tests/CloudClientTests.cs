using System.Net;
using System.Text.Json;
using CloudBox.Agent.Cloud;
using CloudBox.Agent.Identity;
using CloudBox.Agent.Service;

namespace CloudBox.Agent.Tests;

public class EnrollmentClientTests
{
    private static readonly Uri BaseUrl = new("https://box.example.test");

    private static EnrollDevice Device(DeviceKeyInfo key) =>
        new("LAB-PC", "10.0.22631.4317", "0.1.0", key.KeyProtection, key.Jwk);

    [Fact]
    public async Task Enroll_payload_matches_the_fixed_contract()
    {
        var handler = new FakeHttpHandler((_, _) => FakeHttpHandler.Json(HttpStatusCode.Created,
            """{"deviceId":"dev_9","tenantId":"ten_1","tenantCode":"CBX-00481","deviceName":"CLOUDBOX-00017","deviceToken":"tok"}"""));
        var key = new InMemoryDeviceKeyStore("software").OpenOrCreate();
        var client = new AgentApiClient(new HttpClient(handler), () => true);

        var res = await client.EnrollAsync(BaseUrl, "CBX-ENROLL-ABC", Device(key), CancellationToken.None);

        var (req, body) = Assert.Single(handler.Requests);
        Assert.Equal(HttpMethod.Post, req.Method);
        Assert.Equal("https://box.example.test/api/v1/agent/enroll", req.RequestUri!.ToString());
        using var doc = JsonDocument.Parse(body!);
        var root = doc.RootElement;
        Assert.Equal(new[] { "token", "device" }, root.EnumerateObject().Select(p => p.Name));
        Assert.Equal("CBX-ENROLL-ABC", root.GetProperty("token").GetString());
        var device = root.GetProperty("device");
        Assert.Equal(new[] { "hostname", "windowsBuild", "agentVersion", "keyProtection", "publicKeyJwk" },
            device.EnumerateObject().Select(p => p.Name));
        Assert.Equal("LAB-PC", device.GetProperty("hostname").GetString());
        Assert.Equal("software", device.GetProperty("keyProtection").GetString());
        var jwk = device.GetProperty("publicKeyJwk");
        Assert.Equal(new[] { "kty", "n", "e" }, jwk.EnumerateObject().Select(p => p.Name));
        Assert.Equal("RSA", jwk.GetProperty("kty").GetString());
        Assert.Equal(key.Jwk.N, jwk.GetProperty("n").GetString());
        Assert.Equal("AQAB", jwk.GetProperty("e").GetString());

        Assert.Equal(new EnrollResponse("dev_9", "ten_1", "CBX-00481", "CLOUDBOX-00017", "tok"), res);
    }

    [Theory]
    [InlineData(HttpStatusCode.BadRequest, CloudFailure.InvalidToken)]
    [InlineData(HttpStatusCode.Conflict, CloudFailure.AlreadyEnrolled)]
    [InlineData(HttpStatusCode.ServiceUnavailable, CloudFailure.CloudUnavailable)]
    public async Task Enroll_errors_map_to_distinct_failures(HttpStatusCode code, CloudFailure expected)
    {
        var handler = new FakeHttpHandler((_, _) => FakeHttpHandler.Json(code, """{"error":"x"}"""));
        var client = new AgentApiClient(new HttpClient(handler), () => true);
        var key = new InMemoryDeviceKeyStore().OpenOrCreate();

        var ex = await Assert.ThrowsAsync<CloudApiException>(() =>
            client.EnrollAsync(BaseUrl, "t", Device(key), CancellationToken.None));
        Assert.Equal(expected, ex.Failure);
    }

    [Fact]
    public async Task Heartbeat_sends_bearer_token_and_spec_health_document()
    {
        var handler = new FakeHttpHandler((_, _) => FakeHttpHandler.Json(HttpStatusCode.OK,
            """{"serverTime":"2026-09-26T20:00:00Z","entitlementGeneration":null,"commands":[]}"""));
        var client = new AgentApiClient(new HttpClient(handler), () => true);
        var health = HealthBuilder.Build("dev_9", "tpm", "none", 123);

        var res = await client.HeartbeatAsync(BaseUrl, "tok", health, CancellationToken.None);

        var (req, body) = Assert.Single(handler.Requests);
        Assert.Equal("https://box.example.test/api/v1/agent/heartbeat", req.RequestUri!.ToString());
        Assert.Equal("Bearer", req.Headers.Authorization!.Scheme);
        Assert.Equal("tok", req.Headers.Authorization.Parameter);
        using var doc = JsonDocument.Parse(body!);
        var h = doc.RootElement.GetProperty("health");
        Assert.Equal(new[] { "device", "agent", "license", "network", "rdp", "users", "backup", "storage", "updates", "security" },
            h.EnumerateObject().Select(p => p.Name));
        Assert.Equal("dev_9", h.GetProperty("device").GetString());
        Assert.True(h.GetProperty("agent").GetProperty("healthy").GetBoolean());
        Assert.Equal(123, h.GetProperty("storage").GetProperty("free_bytes").GetInt64());
        Assert.Equal("tpm", h.GetProperty("security").GetProperty("device_key").GetString());
        Assert.Equal("none", h.GetProperty("security").GetProperty("tamper").GetString());
        Assert.Equal("unknown", h.GetProperty("license").GetProperty("state").GetString());
        Assert.True(h.GetProperty("license").TryGetProperty("days_remaining", out _));
        Assert.True(h.GetProperty("users").TryGetProperty("active_sessions", out _));
        Assert.True(h.GetProperty("updates").TryGetProperty("reboot_required", out _));
        Assert.Equal(DateTimeOffset.Parse("2026-09-26T20:00:00Z"), res.ServerTime);
        Assert.Null(res.EntitlementGeneration);
    }

    [Fact]
    public async Task Entitlement_404_means_none_issued()
    {
        var handler = new FakeHttpHandler((_, _) => new HttpResponseMessage(HttpStatusCode.NotFound));
        var client = new AgentApiClient(new HttpClient(handler), () => true);
        Assert.Null(await client.GetEntitlementAsync(BaseUrl, "tok", CancellationToken.None));
    }

    [Fact]
    public async Task Revoked_device_is_unauthorized_not_offline()
    {
        var handler = new FakeHttpHandler((_, _) => new HttpResponseMessage(HttpStatusCode.Unauthorized));
        var client = new AgentApiClient(new HttpClient(handler), () => true);
        var ex = await Assert.ThrowsAsync<CloudApiException>(() =>
            client.HeartbeatAsync(BaseUrl, "tok", HealthBuilder.Build("d", "tpm", "none", 1), CancellationToken.None));
        Assert.Equal("unauthorized", ex.State);
    }

    [Fact]
    public void Transport_failures_distinguish_network_from_cloud()
    {
        var connect = new HttpRequestException(HttpRequestError.ConnectionError, "refused");
        var dns = new HttpRequestException(HttpRequestError.NameResolutionError, "no dns");

        Assert.Equal(CloudFailure.CloudUnavailable, AgentApiClient.Classify(connect, networkAvailable: true).Failure);
        Assert.Equal(CloudFailure.NetworkUnavailable, AgentApiClient.Classify(connect, networkAvailable: false).Failure);
        Assert.Equal(CloudFailure.NetworkUnavailable, AgentApiClient.Classify(dns, networkAvailable: true).Failure);
        Assert.Equal("cloud_unavailable", AgentApiClient.Classify(connect, true).State);
        Assert.Equal("network_unavailable", AgentApiClient.Classify(dns, true).State);
    }
}

public class HeartbeatLoopTests
{
    [Fact]
    public void Backoff_is_60s_with_jitter_when_healthy_and_grows_to_a_cap_on_failure()
    {
        var rng = new Random(42);
        for (var i = 0; i < 100; i++)
        {
            var d = Backoff.Next(0, rng).TotalSeconds;
            Assert.InRange(d, 54, 66);
        }

        var previousMax = 0.0;
        for (var failures = 1; failures <= 12; failures++)
        {
            var samples = Enumerable.Range(0, 50).Select(_ => Backoff.Next(failures, rng).TotalSeconds).ToList();
            Assert.All(samples, s => Assert.InRange(s, 0, Backoff.Max.TotalSeconds * 1.1));
            Assert.True(samples.Max() >= previousMax * 0.9, $"backoff shrank at {failures} failures");
            previousMax = samples.Max();
        }

        Assert.InRange(Backoff.Next(20, rng).TotalSeconds, Backoff.Max.TotalSeconds * 0.9, Backoff.Max.TotalSeconds * 1.1);
    }

    [Fact]
    public async Task Cycle_backs_off_while_cloud_is_down_then_recovers_and_downloads_entitlement()
    {
        var keys = new InMemoryDeviceKeyStore();
        var store = new InMemoryStateStore();
        store.Save(TestState.For(keys.OpenOrCreate()));
        var cloud = new ScriptedHeartbeat();
        var status = new AgentStatus();
        var clock = new FixedClock(DateTimeOffset.Parse("2026-09-26T20:00:00Z"));
        var cycle = new HeartbeatCycle(store, keys, cloud, cloud, status, clock, new Random(1), () => 1000);

        var down = new CloudApiException(CloudFailure.CloudUnavailable, "503", 503);
        for (var i = 0; i < 3; i++) cloud.Script.Enqueue(() => throw down);
        var serverTime = DateTimeOffset.Parse("2026-09-26T20:05:00Z");
        cloud.Script.Enqueue(() => new HeartbeatResponse(serverTime, 1, []));
        cloud.Entitlement = new EntitlementResponse("eyJhbGciOi.jwe", 1);

        var delays = new List<TimeSpan>();
        for (var i = 0; i < 4; i++) delays.Add(await cycle.RunOnceAsync(CancellationToken.None));

        Assert.True(delays[1] > delays[0] * 1.5 && delays[2] > delays[1] * 1.5, string.Join(",", delays));
        Assert.InRange(delays[3].TotalSeconds, 54, 66);
        Assert.Equal(0, cycle.ConsecutiveFailures);

        var state = store.Load()!;
        Assert.Equal(serverTime, state.TrustedTime.HighestTrustedTime);
        Assert.Equal(1, state.EntitlementGeneration);
        Assert.Equal("eyJhbGciOi.jwe", state.Entitlement);
        Assert.Equal("connected", status.Current.Cloud);
        Assert.Equal(1, status.Current.EntitlementGeneration);
    }

    [Fact]
    public async Task Cycle_reports_cloud_unavailable_without_crashing()
    {
        var keys = new InMemoryDeviceKeyStore();
        var store = new InMemoryStateStore();
        store.Save(TestState.For(keys.OpenOrCreate()));
        var cloud = new ScriptedHeartbeat();
        cloud.Script.Enqueue(() => throw new CloudApiException(CloudFailure.NetworkUnavailable, "down"));
        var status = new AgentStatus();
        var cycle = new HeartbeatCycle(store, keys, cloud, cloud, status, TimeProvider.System, new Random(1), () => 1);

        await cycle.RunOnceAsync(CancellationToken.None);

        Assert.Equal("network_unavailable", status.Current.Cloud);
        Assert.Equal(1, status.Current.ConsecutiveFailures);
    }

    [Fact]
    public async Task Cycle_refuses_state_bound_to_another_key()
    {
        var store = new InMemoryStateStore();
        store.Save(TestState.For(new InMemoryDeviceKeyStore().OpenOrCreate()));
        var localKeys = new InMemoryDeviceKeyStore();
        localKeys.OpenOrCreate();
        var cloud = new ScriptedHeartbeat();
        var status = new AgentStatus();
        var cycle = new HeartbeatCycle(store, localKeys, cloud, cloud, status, TimeProvider.System, new Random(1), () => 1);

        await cycle.RunOnceAsync(CancellationToken.None);

        Assert.Equal(0, cloud.Calls);
        Assert.Equal("DEVICE_BINDING_FAILED", status.Current.Tamper);
    }

    [Fact]
    public async Task Not_enrolled_is_reported_honestly()
    {
        var cloud = new ScriptedHeartbeat();
        var status = new AgentStatus();
        var cycle = new HeartbeatCycle(new InMemoryStateStore(), new InMemoryDeviceKeyStore(), cloud, cloud, status,
            TimeProvider.System, new Random(1), () => 1);
        await cycle.RunOnceAsync(CancellationToken.None);
        Assert.Equal("not_enrolled", status.Current.Cloud);
        Assert.False(status.Current.Enrolled);
    }
}
