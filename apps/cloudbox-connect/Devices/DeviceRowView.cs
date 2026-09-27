using System.Windows;
using System.Windows.Media;

namespace CloudBox.Connect.Devices;

/// <summary>WPF-only adapter over the (tested, WPF-free) <see cref="DeviceRow"/>: turns its plain
/// values into the `Brush`/`Visibility` types XAML binds to directly. No logic of its own beyond
/// that mapping — <see cref="DeviceListPresenter"/> owns every decision about what a row says.</summary>
public sealed class DeviceRowView(DeviceRow row)
{
    public string DeviceId => row.DeviceId;
    public string Name => row.Name;
    public string OnlinePill => row.OnlinePill;
    public string Explanation => row.Explanation;
    public bool CanConnect => row.CanConnect;

    public Visibility ExplanationVisibility =>
        string.IsNullOrEmpty(row.Explanation) ? Visibility.Collapsed : Visibility.Visible;

    public Brush PillColor => row.Online
        ? new SolidColorBrush(Color.FromRgb(0x1E, 0x8E, 0x3E))
        : new SolidColorBrush(Color.FromRgb(0x9E, 0x9E, 0x9E));
}
