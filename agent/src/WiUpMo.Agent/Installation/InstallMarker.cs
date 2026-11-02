using System.Text.Json;
using System.Text.Json.Serialization;
using WiUpMo.Agent.Contracts;

namespace WiUpMo.Agent.Installation;

[JsonConverter(typeof(JsonStringEnumConverter<InstallState>))]
public enum InstallState
{
    /// <summary>
    /// Angenommen und begonnen. Findet ein frisch gestarteter Dienst diesen
    /// Zustand vor, wurde er mittendrin beendet — der Auftrag gilt dann als
    /// unterbrochen.
    /// </summary>
    Running,

    /// <summary>Alles Angebotene ist installiert. Wartet auf die Meldung ans Backend.</summary>
    Done,

    /// <summary>Gescheitert, ganz oder teilweise. Wartet auf die Meldung ans Backend.</summary>
    Failed,
}

/// <summary>
/// Stand eines Installationsauftrags, neben der Warteschlange abgelegt.
///
/// Die Datei ist der Grund, warum ein Auftrag nicht verloren geht: Startet der
/// Dienst waehrend einer Installation neu, meldet er ihn als unterbrochen statt
/// ihn zu vergessen; ist das Backend beim Abschluss nicht erreichbar, holt der
/// naechste Durchlauf die Meldung nach. Weggeraeumt wird sie erst, wenn das
/// Backend das Ergebnis hat.
/// </summary>
public sealed class InstallMarker
{
    public required string JobId { get; init; }
    public required List<string> UpdateIds { get; init; }
    public required InstallState State { get; set; }
    public required DateTimeOffset StartedAt { get; init; }
    public DateTimeOffset? CompletedAt { get; set; }
    public List<InstallUpdateResult>? Results { get; set; }
    public string? Error { get; set; }

    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true,
    };

    public static InstallMarker? TryLoad(string path)
    {
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<InstallMarker>(File.ReadAllText(path), Options);
        }
        catch (Exception ex) when (ex is JsonException or IOException)
        {
            // Wie beim Update-Marker: Eine unlesbare Datei darf nicht jeden
            // weiteren Auftrag blockieren. Im Backend laeuft der Auftrag nach
            // sechs Stunden als unterbrochen aus.
            TryDelete(path);
            return null;
        }
    }

    public void Save(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);

        // Ueber eine temporaere Datei und Verschieben, damit ein Absturz keine
        // halbe Datei hinterlaesst.
        string temporary = path + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(this, Options));
        File.Move(temporary, path, overwrite: true);
    }

    public static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (IOException)
        {
            // Beim naechsten Durchlauf noch einmal.
        }
    }
}
