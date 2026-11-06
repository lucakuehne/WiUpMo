using System.Text.Json;
using System.Text.Json.Serialization;
using WiUpMo.Agent.Contracts;

namespace WiUpMo.Agent.Restart;

/// <summary>
/// Stand eines Neustart-Auftrags auf der Platte.
///
/// Er muss einen Neustart des Dienstes ueberstehen — und den Neustart des
/// Rechners selbst: Verschiebungen und Frist gelten weiter, und nach dem
/// Neustart zeigt <see cref="RestartingAt"/>, dass der Auftrag erledigt ist.
/// Rueckmeldungen, die das Backend noch nicht bestaetigt hat, liegen mit dabei
/// und gehen beim naechsten Durchlauf hinaus.
/// </summary>
public sealed class RestartState
{
    public required RestartRequest Request { get; set; }
    public DateTimeOffset ReceivedAt { get; set; }

    /// <summary>Gesetzt mit der ersten Meldung beim Benutzer.</summary>
    public DateTimeOffset? DeadlineAt { get; set; }

    public int Deferrals { get; set; }

    /// <summary>Verschoben bis — oder wann es nach einer geschlossenen Meldung erneut versucht wird.</summary>
    public DateTimeOffset? NextPromptAt { get; set; }

    /// <summary>Wann der Neustart eingeleitet wurde.</summary>
    public DateTimeOffset? RestartingAt { get; set; }

    /// <summary>
    /// Abgeschlossen, nur Rueckmeldungen stehen noch aus. Danach wird der Stand
    /// geloescht.
    /// </summary>
    public bool Closed { get; set; }

    /// <summary>Noch nicht bestaetigte Rueckmeldungen, aelteste zuerst.</summary>
    public List<RestartResultRequest> Unreported { get; set; } = [];

    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true,
    };

    public static RestartState? TryLoad(string path)
    {
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<RestartState>(File.ReadAllText(path), Options);
        }
        catch (Exception ex) when (ex is JsonException or IOException)
        {
            // Eine unlesbare Datei darf keinen weiteren Auftrag blockieren. Der
            // Auftrag kommt mit dem naechsten Check-in wieder.
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
            // Beim naechsten Mal.
        }
    }
}
