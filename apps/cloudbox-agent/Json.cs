using System.Text.Json;

namespace CloudBox.Agent;

public static class Json
{
    /// <summary>camelCase, used for the agent API contract, state and the manifest.</summary>
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web) { WriteIndented = false };

    public static readonly JsonSerializerOptions Indented = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    /// <summary>snake_case, used for the spec §29 health document.</summary>
    public static readonly JsonSerializerOptions Snake = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
    };
}
