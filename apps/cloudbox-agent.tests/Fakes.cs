using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using CloudBox.Agent;
using CloudBox.Agent.Cloud;
using CloudBox.Agent.Identity;
using CloudBox.Agent.Install;
using CloudBox.Agent.State;

namespace CloudBox.Agent.Tests;

/// <summary>Device key held in memory; stands in for the CNG/TPM store.</summary>
public sealed class InMemoryDeviceKeyStore(string protection = "tpm", RSA? key = null) : IDeviceKeyStore
{
    private RSA? _key = key;

    public RSA? OpenPrivateKey()
    {
        if (_key is null) return null;
        var copy = RSA.Create();
        copy.ImportParameters(_key.ExportParameters(true));
        return copy;
    }

    public DeviceKeyInfo OpenOrCreate()
    {
        _key ??= RSA.Create(2048);
        return TryOpen()!;
    }

    public DeviceKeyInfo? TryOpen() =>
        _key is null ? null : new DeviceKeyInfo(protection, PublicKeyJwk.FromRsa(_key.ExportParameters(false)));

    public bool Exists() => _key is not null;

    public bool Delete()
    {
        var had = _key is not null;
        _key?.Dispose();
        _key = null;
        return had;
    }
}

public sealed class InMemoryStateStore : ILocalStateStore
{
    private byte[]? _json;

    public AgentState? Load() => _json is null ? null : JsonSerializer.Deserialize<AgentState>(_json, Json.Options);

    public void Save(AgentState state) => _json = JsonSerializer.SerializeToUtf8Bytes(state, Json.Options);

    public void Delete() => _json = null;
}

public sealed class PassThroughProtector : IBlobProtector
{
    public byte[] Protect(byte[] data) => data;

    public byte[] Unprotect(byte[] data) => data;
}

/// <summary>Persists the manifest as JSON so tests exercise the same serialisation as disk/registry.</summary>
public sealed class InMemoryManifestStore : IManifestStore
{
    public string? Json { get; private set; }
    public int Saves { get; private set; }

    public InstallManifest? Load() =>
        Json is null ? null : JsonSerializer.Deserialize<InstallManifest>(Json, CloudBox.Agent.Json.Options);

    public void Save(InstallManifest manifest)
    {
        Json = JsonSerializer.Serialize(manifest, CloudBox.Agent.Json.Options);
        Saves++;
    }
}

/// <summary>A pretend machine: id → value.</summary>
public sealed class FakeMachine
{
    public Dictionary<string, string> Values { get; } = [];
    public List<string> RevertOrder { get; } = [];
}

/// <summary>Sets machine[id] = spec.value. Optionally fails after partially applying. <paramref name="keyByKind"/> keys
/// the pretend machine by kind + id (a service and an event source may share a name).</summary>
public sealed class FakeStep(string kind, FakeMachine machine, string? failOnId = null, bool keyByKind = false) : IInstallStep
{
    public string Kind => kind;

    private string Key(string id) => keyByKind ? $"{kind} {id}" : id;

    public JsonObject CapturePriorState(string id, JsonObject? spec)
    {
        var prior = new JsonObject { ["existed"] = machine.Values.ContainsKey(Key(id)) };
        if (machine.Values.TryGetValue(Key(id), out var v)) prior["value"] = v;
        return prior;
    }

    public void Apply(ManifestEntry entry)
    {
        var value = entry.Spec?["value"];
        machine.Values[Key(entry.Id)] = value is JsonValue v && v.TryGetValue<string>(out var text) ? text : value?.ToJsonString() ?? "applied";
        if (entry.Id == failOnId) throw new InvalidOperationException($"simulated failure in {entry.Id}");
    }

    public RevertOutcome Revert(ManifestEntry entry, RevertContext context)
    {
        machine.RevertOrder.Add(entry.Id);
        if (entry.PriorExisted)
        {
            machine.Values[Key(entry.Id)] = entry.PriorState!["value"]!.GetValue<string>();
            return RevertOutcome.Restored;
        }

        return machine.Values.Remove(Key(entry.Id)) ? RevertOutcome.Removed : RevertOutcome.Missing;
    }

    public bool Remains(ManifestEntry entry) => entry.PriorExisted
        ? machine.Values.GetValueOrDefault(Key(entry.Id)) != entry.PriorState!["value"]!.GetValue<string>()
        : machine.Values.ContainsKey(Key(entry.Id));
}

/// <summary>Captures requests and returns canned responses.</summary>
public sealed class FakeHttpHandler(Func<HttpRequestMessage, string?, HttpResponseMessage> respond) : HttpMessageHandler
{
    public List<(HttpRequestMessage Request, string? Body)> Requests { get; } = [];

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
        Requests.Add((request, body));
        return respond(request, body);
    }

    public static HttpResponseMessage Json(HttpStatusCode code, string json) =>
        new(code) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
}

public sealed class ScriptedHeartbeat : IHeartbeatClient, IEntitlementClient
{
    public Queue<Func<HeartbeatResponse>> Script { get; } = new();
    public EntitlementResponse? Entitlement { get; set; }
    public int Calls { get; private set; }

    public Task<HeartbeatResponse> HeartbeatAsync(Uri baseUrl, string deviceToken, AgentHealth health, CancellationToken ct)
    {
        Calls++;
        return Task.FromResult(Script.Dequeue()());
    }

    public Task<EntitlementResponse?> GetEntitlementAsync(Uri baseUrl, string deviceToken, CancellationToken ct) =>
        Task.FromResult(Entitlement);
}

public sealed class FixedClock(DateTimeOffset now) : TimeProvider
{
    public DateTimeOffset Now { get; set; } = now;

    public override DateTimeOffset GetUtcNow() => Now;
}

public static class TestState
{
    public static AgentState For(DeviceKeyInfo key) => new()
    {
        BaseUrl = "https://box.example.test",
        DeviceId = "dev_1",
        TenantId = "ten_1",
        TenantCode = "CBX-00001",
        DeviceName = "CLOUDBOX-00001",
        DeviceToken = "device-token",
        KeyProtection = key.KeyProtection,
        KeyThumbprint = key.Thumbprint,
    };
}
