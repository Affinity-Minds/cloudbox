using CloudBox.Agent;
using CloudBox.Agent.Cloud;
using CloudBox.Agent.Identity;
using CloudBox.Agent.Service;
using CloudBox.Agent.State;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Hosting.WindowsServices;
using Microsoft.Extensions.Logging;
using Serilog;

const string Template = "{Timestamp:yyyy-MM-ddTHH:mm:ss.fffzzz} [{Level:u3}] [{Channel}] {SourceContext} {Message:lj}{NewLine}{Exception}";

// Service mode: started by the SCM with no arguments, or `run` for a console debug session.
if (args.Length > 0 && !string.Equals(args[0], "run", StringComparison.OrdinalIgnoreCase))
{
    Log.Logger = new LoggerConfiguration()
        .Enrich.WithProperty("Channel", "OPS")
        .WriteTo.Console(outputTemplate: "[{Channel}] {Message:lj}{NewLine}{Exception}")
        .MinimumLevel.Warning()
        .CreateLogger();
    return await Cli.RunAsync(args);
}

if (args.Length == 0 && !WindowsServiceHelpers.IsWindowsService())
{
    Console.WriteLine(Cli.Usage);
    return 2;
}

Log.Logger = new LoggerConfiguration()
    .MinimumLevel.Information()
    .Enrich.WithProperty("Channel", "OPS")
    .Enrich.FromLogContext()
    .WriteTo.File(Path.Combine(AgentPaths.LogsDir, "agent-.log"), rollingInterval: RollingInterval.Day,
        retainedFileCountLimit: 14, outputTemplate: Template)
    .WriteTo.Console(outputTemplate: Template)
    .CreateLogger();

try
{
    var builder = Host.CreateApplicationBuilder();
    builder.Services.AddWindowsService(o => o.ServiceName = AgentPaths.ServiceName);
    builder.Logging.ClearProviders(); // No EventLog provider: it would create an unrecorded event source.
    builder.Services.AddSerilog();
    builder.Services.AddSingleton(TimeProvider.System);
    builder.Services.AddSingleton<AgentStatus>();
    builder.Services.AddSingleton<IDeviceKeyStore>(_ => new CngDeviceKeyStore(AgentPaths.KeyName));
    builder.Services.AddSingleton<ILocalStateStore>(_ => FileStateStore.CreateDefault());
    builder.Services.AddSingleton(_ => new AgentApiClient(AgentApiClient.CreateHttpClient()));
    builder.Services.AddSingleton(sp =>
        ServerRuntime.CreateDefault(sp.GetRequiredService<IDeviceKeyStore>(), sp.GetRequiredService<AgentApiClient>()));
    builder.Services.AddSingleton(sp =>
    {
        var api = sp.GetRequiredService<AgentApiClient>();
        return new HeartbeatCycle(sp.GetRequiredService<ILocalStateStore>(), sp.GetRequiredService<IDeviceKeyStore>(),
            api, api, sp.GetRequiredService<AgentStatus>(), TimeProvider.System, Random.Shared,
            server: sp.GetRequiredService<ServerRuntime>());
    });
    builder.Services.AddHostedService<AgentWorker>();
    builder.Services.AddHostedService(sp => new StatusPipeServer(sp.GetRequiredService<AgentStatus>()));
    await builder.Build().RunAsync();
    return 0;
}
catch (Exception ex)
{
    Log.Fatal(ex, "CloudBox Agent terminated unexpectedly");
    return 1; // Non-zero exit + failureflag 1 lets the SCM recovery policy restart the service.
}
finally
{
    await Log.CloseAndFlushAsync();
}
