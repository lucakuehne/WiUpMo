using System.Text.Json;
using System.Text.Json.Serialization;

namespace WiUpMo.Agent.Contracts;

/// <summary>
/// Eine einzige Stelle fuer die Serialisierung.
///
/// Dieselben Einstellungen gelten fuer die Uebertragung ans Backend und fuer
/// die Ablage in der Warteschlange. Das ist kein Zufall: ein Snapshot wird
/// gespeichert, spaeter wieder eingelesen und dann gesendet — weichen die
/// Einstellungen auseinander, faellt das erst im Offline-Fall auf, also genau
/// dann, wenn niemand zusieht.
/// </summary>
public static class AgentJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}
