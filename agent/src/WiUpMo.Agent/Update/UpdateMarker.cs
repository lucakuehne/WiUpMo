using System.Text.Json;
using System.Text.Json.Serialization;

namespace WiUpMo.Agent.Update;

[JsonConverter(typeof(JsonStringEnumConverter<UpdateState>))]
public enum UpdateState
{
    /// <summary>Neue Fassung liegt bereit, der Updater soll tauschen.</summary>
    PendingSwap,

    /// <summary>
    /// Getauscht und gestartet. Bestaetigt der Dienst sich nicht bis zum
    /// Zeitpunkt in <see cref="UpdateMarker.VerifyDeadline"/>, nimmt der
    /// Updater den Tausch zurueck.
    /// </summary>
    Verifying,

    /// <summary>
    /// Der neue Dienst laeuft — lokal festgestellt, ohne Netzwerk.
    ///
    /// Dieser Zwischenschritt ist nicht redundant: Die Bestaetigung muss vom
    /// Melden ans Backend getrennt sein. Waere sie es nicht, wuerde ein
    /// unerreichbares Backend dazu fuehren, dass der Updater eine
    /// einwandfrei laufende neue Version nach Ablauf der Frist zurueckdreht —
    /// bei einem Laptop im Homeoffice der Normalfall, nicht die Ausnahme.
    /// </summary>
    Verified,

    /// <summary>
    /// Der Updater hat zurueckgetauscht. Der wieder laufende alte Dienst
    /// meldet das ans Backend und raeumt den Marker weg.
    /// </summary>
    RolledBack,
}

/// <summary>
/// Zustand eines laufenden Selbst-Updates, geteilt zwischen Dienst und
/// Updater — die beiden reden nur ueber diese Datei miteinander.
///
/// Sie liegt bewusst neben der Warteschlange und nicht im Programmverzeichnis:
/// Sie muss den Tausch der EXE ueberleben.
/// </summary>
public sealed class UpdateMarker
{
    public required string JobId { get; init; }
    public required string TargetVersion { get; init; }
    public required string FromVersion { get; init; }
    public required UpdateState State { get; set; }
    public required DateTimeOffset StartedAt { get; init; }
    public DateTimeOffset? VerifyDeadline { get; set; }
    public string? Error { get; set; }

    /// <summary>
    /// Die EXE, auf die der Dienst umgestellt wird, und die, von der er kommt.
    /// Beide gesetzt heisst: neuer Weg, Umstellen per <c>binPath</c>. Fehlen sie,
    /// stammt der Marker von einem Dienst vor 0.8.0, und es wird per Datei
    /// getauscht. Ein aelterer Updater kennt die Felder nicht und laesst sie beim
    /// Speichern weg — deshalb nutzt der Dienst den neuen Weg nur, wenn der
    /// Updater ihn beherrscht.
    /// </summary>
    public string? TargetPath { get; init; }

    public string? FromPath { get; init; }

    /// <summary>Anlaeufe des Updaters fuer den aktuellen Schritt; begrenzt, damit er nicht ewig kreist.</summary>
    public int Attempts { get; set; }

    public DateTimeOffset? LastAttemptAt { get; set; }

    /// <summary>Der letzte Fehlschlag eines Anlaufs, der noch wiederholt wird.</summary>
    public string? LastAttemptError { get; set; }

    [JsonIgnore]
    public bool IsVersioned => TargetPath is not null && FromPath is not null;

    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
    };

    public static UpdateMarker? TryLoad(string path)
    {
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<UpdateMarker>(File.ReadAllText(path), Options);
        }
        catch (Exception ex) when (ex is JsonException or IOException)
        {
            // Ein unlesbarer Marker darf nicht zum Dauerzustand werden: Sonst
            // scheiterte jeder weitere Update-Versuch daran, dass "schon eines
            // laeuft". Wegwerfen ist hier richtig — die EXE selbst ist davon
            // unberuehrt, und das Backend beauftragt beim naechsten Check-in
            // erneut.
            TryDelete(path);
            return null;
        }
    }

    public void Save(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);

        // Ueber eine temporaere Datei und Verschieben: Ein abgebrochener
        // Schreibvorgang wuerde sonst einen halben Marker hinterlassen, und der
        // Updater trifft danach Entscheidungen auf einer beschaedigten Datei.
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
