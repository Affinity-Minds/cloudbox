using CloudBox.Connect.State;

namespace CloudBox.Connect.Tests;

/// <summary>Real DPAPI (current-user scope) round trip on a temp file — no fake, matching the
/// Agent's own state-store tests (apps/cloudbox-agent.tests). Runs on `windows-latest`.</summary>
public class SessionPersistenceTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), $"cloudbox-connect-test-{Guid.NewGuid():N}.bin");

    public void Dispose()
    {
        if (File.Exists(_path)) File.Delete(_path);
    }

    private static readonly ConnectSession Sample = new(
        "https://box.affinity.ai.in",
        "__Secure-cbx_session=super-secret-value",
        "usr_1",
        "person@example.test",
        "Person",
        "ten_1",
        "CBX-00001");

    [Fact]
    public void Save_then_load_returns_an_identical_session()
    {
        var store = new FileSessionStore(_path, new DpapiUserProtector("test-purpose"));
        store.Save(Sample);

        var loaded = store.Load();

        Assert.Equal(Sample, loaded);
    }

    [Fact]
    public void The_file_on_disk_never_contains_the_session_cookie_in_the_clear()
    {
        var store = new FileSessionStore(_path, new DpapiUserProtector("test-purpose"));
        store.Save(Sample);

        var bytes = File.ReadAllBytes(_path);
        var raw = System.Text.Encoding.UTF8.GetString(bytes);

        Assert.DoesNotContain("super-secret-value", raw);
        Assert.DoesNotContain(Sample.UserEmail, raw);
    }

    [Fact]
    public void Clear_removes_the_file_and_load_then_returns_null()
    {
        var store = new FileSessionStore(_path, new DpapiUserProtector("test-purpose"));
        store.Save(Sample);
        Assert.True(File.Exists(_path));

        store.Clear();

        Assert.False(File.Exists(_path));
        Assert.Null(store.Load());
    }

    [Fact]
    public void Loading_a_missing_file_returns_null_instead_of_throwing()
    {
        var store = new FileSessionStore(_path, new DpapiUserProtector("test-purpose"));
        Assert.Null(store.Load());
    }

    [Fact]
    public void A_file_that_is_not_valid_protected_data_is_treated_as_signed_out_not_a_crash()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        File.WriteAllText(_path, "not protected data at all");
        var store = new FileSessionStore(_path, new DpapiUserProtector("test-purpose"));

        Assert.Null(store.Load());
    }
}
