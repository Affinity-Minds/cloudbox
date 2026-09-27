using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace CloudBox.Connect;

/// <summary>Minimal `INotifyPropertyChanged` base — no MVVM package, just enough for WPF binding
/// and for tests to assert on property values directly (plain C#, no WPF types involved).</summary>
public abstract class ObservableObject : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;

    protected void RaisePropertyChanged([CallerMemberName] string? name = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));

    protected bool SetField<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return false;
        field = value;
        RaisePropertyChanged(name);
        return true;
    }
}
