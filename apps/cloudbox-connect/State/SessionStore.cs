using System.Security.Cryptography;
using System.Text.Json;
using CloudBox.Connect.Cloud;

namespace CloudBox.Connect.State;

/// <summary>The signed-in session, persisted between launches. `SessionCookie` is the confidential
/// artefact (the verbatim `Set-Cookie` value) — never logged, never shown, DPAPI-protected at rest.</summary>
public sealed record ConnectSession(
    string BaseUrl,
    string SessionCookie,
    string UserId,
    string UserEmail,
    string UserName,
    string TenantId,
    string TenantCode
);

public interface ISessionStore
{
    ConnectSession? Load();
    void Save(ConnectSession session);
    void Clear();
}

/// <summary>Wraps the bytes written to disk. DPAPI (current-user scope) in production, pass-through in tests.</summary>
public interface IBlobProtector
{
    byte[] Protect(byte[] data);
    byte[] Unprotect(byte[] data);
}

/// <summary>DPAPI, **current-user** scope (unlike the Agent's machine-scope state): Connect is a
/// per-user install with no admin, so only Windows itself — not a folder ACL — keeps one user's
/// session away from another on a shared machine.</summary>
public sealed class DpapiUserProtector(string purpose) : IBlobProtector
{
    private readonly byte[] _entropy = System.Text.Encoding.UTF8.GetBytes(purpose);

    public byte[] Protect(byte[] data) => ProtectedData.Protect(data, _entropy, DataProtectionScope.CurrentUser);

    public byte[] Unprotect(byte[] data) => ProtectedData.Unprotect(data, _entropy, DataProtectionScope.CurrentUser);
}

/// <summary>JSON session in one protected file, written atomically (temp file + replace).</summary>
public sealed class FileSessionStore(string path, IBlobProtector protector) : ISessionStore
{
    public static FileSessionStore CreateDefault() =>
        new(ConnectPaths.SessionFile, new DpapiUserProtector("CloudBox.Connect.Session.v1"));

    public ConnectSession? Load()
    {
        if (!File.Exists(path)) return null;
        try
        {
            var json = protector.Unprotect(File.ReadAllBytes(path));
            return JsonSerializer.Deserialize<ConnectSession>(json, Json.Options);
        }
        catch (Exception ex) when (ex is CryptographicException or JsonException)
        {
            // Unreadable (another user's file copied here, or corrupted): treat as signed out,
            // never crash the app over a stale session file.
            return null;
        }
    }

    public void Save(ConnectSession session)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var tmp = path + ".tmp";
        File.WriteAllBytes(tmp, protector.Protect(JsonSerializer.SerializeToUtf8Bytes(session, Json.Options)));
        File.Move(tmp, path, overwrite: true);
    }

    public void Clear()
    {
        if (File.Exists(path)) File.Delete(path);
    }
}
