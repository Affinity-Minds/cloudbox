using CloudBox.Connect.Cloud;

namespace CloudBox.Connect.Devices;

/// <summary>One row exactly as the device-list screen should show it (spec §59: name, Online/Offline
/// pill, licence state; "No active plan" and "offline" states explained plainly). Pure mapping —
/// no WPF types — so xUnit can assert on it directly against fixed `ConnectDevice` values.</summary>
public sealed record DeviceRow(
    string DeviceId,
    string Name,
    string OnlinePill,
    bool Online,
    /// <summary>Plain-English explanation shown under the row when the device is not simply
    /// "online, licensed" — e.g. "No active plan" or "Offline". Empty when there is nothing to explain.</summary>
    string Explanation,
    /// <summary>Whether the big Connect button should be enabled for this row.</summary>
    bool CanConnect
);

public static class DeviceListPresenter
{
    public static DeviceRow ToRow(ConnectDevice device)
    {
        var explanations = new List<string>();
        if (!device.Online)
        {
            explanations.Add("Offline — this CloudBox hasn't checked in recently. Make sure it's powered on and connected.");
        }
        switch (device.LicenseState)
        {
            case "none":
                explanations.Add("No active plan — ask your CloudBox admin to add one.");
                break;
            case "expired":
                explanations.Add("Licence expired — ask your CloudBox admin to renew it.");
                break;
        }

        var canConnect = device.Online && device.LicenseState == "active";
        return new DeviceRow(
            device.DeviceId,
            device.Name,
            device.Online ? "Online" : "Offline",
            device.Online,
            string.Join(" ", explanations),
            canConnect);
    }

    public static IReadOnlyList<DeviceRow> ToRows(ConnectDevicesResponse response) =>
        response.Devices.Select(ToRow).ToList();

    /// <summary>Shown instead of the (empty) table. Never invented metrics — just what to do next.</summary>
    public const string NoDevicesMessage = "No CloudBoxes yet. Ask your CloudBox admin to add you to one.";

    /// <summary>Shown above the list when the tenant itself has no active plan (spec: "No active
    /// plan" explained plainly) — distinct from a single device's own licence state.</summary>
    public static string? TenantBanner(ConnectDevicesResponse response) =>
        response.Plan.State == "no_active_plan"
            ? response.Plan.Message ?? "No active plan found. Please contact your CloudBox admin."
            : null;
}
