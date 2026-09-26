using System.Text.Json;
using System.Text.Json.Nodes;
using CloudBox.Agent.Identity;
using CloudBox.Agent.Install;
using CloudBox.Agent.Service;
using Microsoft.Win32;

namespace CloudBox.Agent.Tests;

/// <summary>Real Windows APIs on the CI runner (windows-latest, elevated). No TPM assumptions.</summary>
public sealed class WindowsIntegrationTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("cbx-win-").FullName;
    private readonly string _regKey = $@"HKCU\Software\CloudBoxTests\{Guid.NewGuid():N}";

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
        Registry.CurrentUser.DeleteSubKeyTree(@"Software\CloudBoxTests", throwOnMissingSubKey: false);
    }

    [Fact]
    public void Cng_software_key_is_created_non_exportable_reopened_and_deleted()
    {
        var store = new CngDeviceKeyStore($"CloudBox.Tests.{Guid.NewGuid():N}", allowTpm: false);
        try
        {
            var created = store.OpenOrCreate();
            Assert.Equal("software", created.KeyProtection);
            Assert.Equal("AQAB", created.Jwk.E);
            Assert.Equal(342, created.Jwk.N.Length);
            Assert.Equal(created.Thumbprint, store.TryOpen()!.Thumbprint);
            Assert.True(store.Exists());
        }
        finally
        {
            store.Delete();
        }

        Assert.False(store.Exists());
        Assert.False(store.Delete());
    }

    [Fact]
    public void Cng_store_prefers_tpm_and_falls_back_to_software()
    {
        var store = new CngDeviceKeyStore($"CloudBox.Tests.{Guid.NewGuid():N}");
        try
        {
            var key = store.OpenOrCreate();
            Assert.Contains(key.KeyProtection, new[] { "tpm", "software" });
        }
        finally
        {
            store.Delete();
        }
    }

    [Fact]
    public void Real_steps_apply_and_revert_directory_file_and_registry()
    {
        var store = new InMemoryManifestStore();
        var runner = new ManifestRunner(store, WindowsSteps.Create(new InMemoryDeviceKeyStore()));
        var dir = Path.Combine(_dir, "Agent");
        var source = Path.Combine(_dir, "source.txt");
        File.WriteAllText(source, "payload");
        var (root, sub) = (Registry.CurrentUser, _regKey["HKCU\\".Length..]);
        using (var k = root.CreateSubKey(sub)) k.SetValue("Existing", "original");

        runner.Apply(Kinds.Directory, dir);
        runner.Apply(Kinds.File, Path.Combine(dir, "x.txt"), new JsonObject { ["source"] = source });
        runner.Apply(Kinds.RegistryValue, $"{_regKey}|Existing", new JsonObject { ["value"] = "cloudbox" });
        runner.Apply(Kinds.WindowsSetting, $"{_regKey}|fDenyTSConnections", new JsonObject { ["value"] = 0 });
        runner.Apply(Kinds.RegistryKey, $@"{_regKey}\Child", new JsonObject { ["values"] = new JsonObject { ["N"] = 1 } });

        Assert.Equal("payload", File.ReadAllText(Path.Combine(dir, "x.txt")));
        using (var k = root.OpenSubKey(sub)!)
        {
            Assert.Equal("cloudbox", k.GetValue("Existing"));
            Assert.Equal(0, k.GetValue("fDenyTSConnections"));
        }

        Assert.Equal(1, CleanVerifier.Run(runner, runner.Manifest.Entries, new StringWriter()));

        var results = runner.RevertAll(runner.Manifest.Entries, new RevertContext { ProcessPath = null });
        Assert.All(results, r => Assert.NotEqual(RevertOutcome.Failed, r.Outcome));
        Assert.False(Directory.Exists(dir));
        using (var k = root.OpenSubKey(sub)!)
        {
            Assert.Equal("original", k.GetValue("Existing"));
            Assert.Null(k.GetValue("fDenyTSConnections"));
            Assert.Null(k.OpenSubKey("Child"));
        }

        Assert.Equal(0, CleanVerifier.Run(runner, runner.Manifest.Entries, new StringWriter()));

        // Revert is idempotent: a second uninstall reports missing/restored, never fails.
        Assert.All(runner.RevertAll(runner.Manifest.Entries, new RevertContext { ProcessPath = null }),
            r => Assert.Contains(r.Outcome, new[] { RevertOutcome.Missing, RevertOutcome.Restored }));
    }

    [Fact]
    public void Running_executable_is_scheduled_for_self_delete_not_deleted()
    {
        var dir = Path.Combine(_dir, "Install");
        Directory.CreateDirectory(dir);
        var exe = Path.Combine(dir, "CloudBox.Agent.exe");
        File.WriteAllText(exe, "exe");
        File.WriteAllText(Path.Combine(dir, "other.dll"), "x");
        var entry = new ManifestEntry { Kind = Kinds.Directory, Id = dir, PriorState = new JsonObject { ["existed"] = false } };
        var ctx = new RevertContext { ProcessPath = exe };

        Assert.Equal(RevertOutcome.Scheduled, new DirectoryStep().Revert(entry, ctx));
        Assert.True(File.Exists(exe));
        Assert.False(File.Exists(Path.Combine(dir, "other.dll")));
        Assert.Equal(new[] { dir }, ctx.SelfDeletePaths);
    }

    [Fact]
    public async Task Status_pipe_serves_the_current_snapshot()
    {
        var pipe = $"CloudBoxAgent.Tests.{Guid.NewGuid():N}";
        var status = new AgentStatus();
        status.Set(new AgentStatusSnapshot { Enrolled = true, DeviceId = "dev_7", Cloud = "connected", KeyProtection = "tpm" });
        using var server = new StatusPipeServer(status, pipe);
        await server.StartAsync(CancellationToken.None);
        try
        {
            string? json = null;
            for (var i = 0; i < 20 && json is null; i++)
            {
                json = await Task.Run(() => StatusPipeServer.TryRead(pipe, 1000));
            }

            Assert.NotNull(json);
            using var doc = JsonDocument.Parse(json);
            Assert.Equal("dev_7", doc.RootElement.GetProperty("deviceId").GetString());
            Assert.Equal("connected", doc.RootElement.GetProperty("cloud").GetString());
        }
        finally
        {
            await server.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public void Pipe_acl_grants_interactive_users_read_only()
    {
        var rules = StatusPipeServer.CreateSecurity()
            .GetAccessRules(true, false, typeof(System.Security.Principal.SecurityIdentifier))
            .Cast<System.IO.Pipes.PipeAccessRule>()
            .ToDictionary(r => ((System.Security.Principal.SecurityIdentifier)r.IdentityReference).Value, r => r.PipeAccessRights);

        Assert.Equal(3, rules.Count);
        var interactive = rules["S-1-5-4"];
        Assert.True(interactive.HasFlag(System.IO.Pipes.PipeAccessRights.ReadData));
        Assert.False(interactive.HasFlag(System.IO.Pipes.PipeAccessRights.WriteData));
        Assert.False(interactive.HasFlag(System.IO.Pipes.PipeAccessRights.CreateNewInstance));
        Assert.False(interactive.HasFlag(System.IO.Pipes.PipeAccessRights.ChangePermissions));
    }
}
