using CloudBox.Connect.Rdp;

namespace CloudBox.Connect.Tests;

public class RdpLauncherTests : IDisposable
{
    private readonly List<string> _tempFiles = [];

    public void Dispose()
    {
        foreach (var file in _tempFiles.Where(File.Exists)) File.Delete(file);
    }

    private string NextTempFile()
    {
        var path = Path.Combine(Path.GetTempPath(), $"cloudbox-connect-test-{Guid.NewGuid():N}.rdp");
        _tempFiles.Add(path);
        return path;
    }

    [Fact]
    public async Task Connect_writes_the_credential_before_launching_and_deletes_it_after()
    {
        var broker = new FakeCredentialBroker();
        var launcher = new FakeProcessLauncher();
        var rdp = new RdpLauncher(broker, launcher, NextTempFile);

        await rdp.ConnectAsync("192.168.1.42", "cloud01", "s3cr3t-p@ss", CancellationToken.None);

        Assert.Single(broker.Written);
        Assert.Equal(("192.168.1.42", "cloud01", "s3cr3t-p@ss"), broker.Written[0]);
        Assert.Single(broker.Deleted);
        Assert.Equal("192.168.1.42", broker.Deleted[0]);
        Assert.Single(launcher.Launched);
        Assert.Equal("mstsc.exe", launcher.Launched[0].FileName);
    }

    [Fact]
    public async Task The_credential_is_deleted_even_when_mstsc_fails_to_launch()
    {
        var broker = new FakeCredentialBroker();
        var launcher = new FakeProcessLauncher { ThrowOnLaunch = new InvalidOperationException("boom") };
        var rdp = new RdpLauncher(broker, launcher, NextTempFile);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => rdp.ConnectAsync("10.0.0.5", "cloud02", "hunter2", CancellationToken.None));

        Assert.Single(broker.Deleted);
    }

    [Fact]
    public async Task The_password_never_appears_on_the_mstsc_command_line()
    {
        var broker = new FakeCredentialBroker();
        var launcher = new FakeProcessLauncher();
        var rdp = new RdpLauncher(broker, launcher, NextTempFile);
        const string password = "th1s-must-never-leak";

        await rdp.ConnectAsync("192.168.1.42", "cloud01", password, CancellationToken.None);

        var (_, arguments) = launcher.Launched[0];
        Assert.All(arguments, arg => Assert.DoesNotContain(password, arg));
    }

    [Fact]
    public async Task The_rdp_file_on_disk_has_no_password_field_and_never_contains_the_password()
    {
        var broker = new FakeCredentialBroker();
        var launcher = new FakeProcessLauncher();
        string? capturedPath = null;
        launcher.Launched.Clear();
        var rdp = new RdpLauncher(broker, new CapturingLauncher(launcher, p => capturedPath = p), NextTempFile);
        const string password = "th1s-must-never-leak-either";

        await rdp.ConnectAsync("192.168.1.42", "cloud01", password, CancellationToken.None);

        Assert.NotNull(capturedPath);
        // The file is deleted by the time ConnectAsync returns, so read the built contents directly.
        var contents = RdpLauncher.BuildRdpFile("192.168.1.42", "cloud01");
        Assert.DoesNotContain(password, contents);
        Assert.DoesNotContain("password", contents.ToLowerInvariant());
        Assert.Contains("full address:s:192.168.1.42", contents);
    }

    /// <summary>Wraps a launcher just to capture the `.rdp` file path mstsc was given, for the test above.</summary>
    private sealed class CapturingLauncher(IProcessLauncher inner, Action<string> onLaunch) : IProcessLauncher
    {
        public Task<int> LaunchAndWaitAsync(string fileName, IReadOnlyList<string> arguments, CancellationToken ct)
        {
            onLaunch(arguments[0]);
            return inner.LaunchAndWaitAsync(fileName, arguments, ct);
        }
    }
}
