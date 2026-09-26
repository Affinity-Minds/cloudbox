using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Serilog;

namespace CloudBox.Agent.Service;

/// <summary>Health loop: heartbeat every ~60 s, exponential backoff with jitter on failure. Cloud downtime never crashes it.</summary>
public sealed class AgentWorker(HeartbeatCycle cycle, TimeProvider clock) : BackgroundService
{
    private readonly ILogger _log = Log.ForContext<AgentWorker>();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _log.Information("CloudBox Agent {Version} started", AgentPaths.AgentVersion);
        while (!stoppingToken.IsCancellationRequested)
        {
            TimeSpan delay;
            try
            {
                delay = await cycle.RunOnceAsync(stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _log.Error(ex, "Health cycle fault");
                delay = Cloud.Backoff.Interval;
            }

            try
            {
                await Task.Delay(delay, clock, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }
}

/// <summary>
/// Serves the status JSON on \\.\pipe\CloudBoxAgent. ACL: SYSTEM and Administrators full control,
/// Interactive users read-only. The pipe has no persistent artefact; it disappears with the process.
/// </summary>
public sealed class StatusPipeServer(AgentStatus status, string pipeName = AgentPaths.PipeName) : BackgroundService
{
    private readonly ILogger _log = Log.ForContext<StatusPipeServer>();

    public static PipeSecurity CreateSecurity()
    {
        var ps = new PipeSecurity();
        ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            PipeAccessRights.FullControl, AccessControlType.Allow));
        ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
            PipeAccessRights.FullControl, AccessControlType.Allow));
        ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.InteractiveSid, null),
            PipeAccessRights.Read | PipeAccessRights.Synchronize, AccessControlType.Allow));
        return ps;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var security = CreateSecurity();
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                // FirstPipeInstance: fail loudly if someone else squatted the pipe name.
                await using var pipe = NamedPipeServerStreamAcl.Create(pipeName, PipeDirection.Out, 1,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.FirstPipeInstance, 0, 0, security);
                await pipe.WaitForConnectionAsync(stoppingToken);
                var bytes = JsonSerializer.SerializeToUtf8Bytes(status.Current, Json.Indented);
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                timeout.CancelAfter(TimeSpan.FromSeconds(5));
                await pipe.WriteAsync(bytes, timeout.Token);
                await pipe.FlushAsync(timeout.Token);
                var drain = Task.Run(pipe.WaitForPipeDrain, CancellationToken.None);
                await Task.WhenAny(drain, Task.Delay(TimeSpan.FromSeconds(5), stoppingToken));
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (UnauthorizedAccessException ex)
            {
                Security.Log.Error(ex, "Status pipe name {Pipe} is held by another process", pipeName);
                await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken).ContinueWith(_ => { }, TaskScheduler.Default);
            }
            catch (Exception ex) when (ex is IOException or OperationCanceledException)
            {
                _log.Debug(ex, "Status pipe client disconnected");
            }
        }
    }

    /// <summary>Client side, used by <c>status</c> and CloudBox.Status.</summary>
    public static string? TryRead(string pipeName = AgentPaths.PipeName, int timeoutMs = 3000)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.In);
            client.Connect(timeoutMs);
            using var reader = new StreamReader(client);
            return reader.ReadToEnd();
        }
        catch (Exception ex) when (ex is TimeoutException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
