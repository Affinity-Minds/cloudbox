using System.Text.Json;

namespace CloudBox.Connect;

public static class Json
{
    /// <summary>camelCase, matching the connect.ts / agent.ts wire contracts.</summary>
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web) { WriteIndented = false };
}
