using System.Text.Json.Nodes;
using CloudBox.Agent.Install;

namespace CloudBox.Agent.Rdp;

/// <summary>
/// Manifest handler for the <c>third_party_component</c> entry <c>rdp-runtime</c>: install = <c>-install -offline</c>
/// verified through ServiceDll; revert = <c>-uninstall -offline</c> verified back to termsrv.dll.
/// </summary>
public sealed class RdpRuntimeComponent(Func<RdpWrapperRuntime>? factory = null) : IComponentHandler
{
    public const string Id = "rdp-runtime";

    private RdpWrapperRuntime Runtime => (factory ?? RdpWrapperRuntime.CreateDefault)();

    public bool Handles(string id) => id == Id;

    public bool Present(string id, JsonObject? spec) => Runtime.Present();

    public void Install(string id, JsonObject? spec) => Runtime.Install();

    public void Uninstall(string id, JsonObject? spec) => Runtime.Uninstall();
}
