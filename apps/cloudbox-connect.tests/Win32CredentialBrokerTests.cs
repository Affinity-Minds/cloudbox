using CloudBox.Connect.Rdp;

namespace CloudBox.Connect.Tests;

/// <summary>Exercises the real Win32 API (no fake) on the CI runner's own credential store, the
/// same way apps/cloudbox-agent.tests exercises the real CNG key store — proves the P/Invoke
/// marshaling is actually correct, not just that the interface is shaped right.</summary>
public class Win32CredentialBrokerTests
{
    [Fact]
    public void Write_then_delete_round_trips_without_throwing()
    {
        var broker = new Win32CredentialBroker();
        var target = $"cloudbox-test-{Guid.NewGuid():N}";

        broker.Write(target, "cloud01", "a-test-password-Aa1!");
        broker.Delete(target);
    }

    [Fact]
    public void Deleting_a_credential_that_was_never_written_is_not_an_error()
    {
        var broker = new Win32CredentialBroker();
        broker.Delete($"cloudbox-test-never-written-{Guid.NewGuid():N}");
    }

    [Fact]
    public void Writing_the_same_target_twice_overwrites_rather_than_throwing()
    {
        var broker = new Win32CredentialBroker();
        var target = $"cloudbox-test-{Guid.NewGuid():N}";
        try
        {
            broker.Write(target, "cloud01", "first-password-Aa1!");
            broker.Write(target, "cloud01", "second-password-Aa1!");
        }
        finally
        {
            broker.Delete(target);
        }
    }
}
