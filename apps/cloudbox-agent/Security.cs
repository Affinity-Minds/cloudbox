namespace CloudBox.Agent;

/// <summary>SECURITY channel. Every log event carries Channel=OPS unless written through this logger.</summary>
public static class Security
{
    public static Serilog.ILogger Log => Serilog.Log.ForContext("Channel", "SECURITY");
}
