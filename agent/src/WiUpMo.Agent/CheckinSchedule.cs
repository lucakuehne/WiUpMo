using System.Globalization;
using Microsoft.Extensions.Logging;
using WiUpMo.Agent.Storage;

namespace WiUpMo.Agent;

/// <summary>
/// Der Abstand zwischen zwei regulaeren Durchlaeufen.
///
/// Er kommt bevorzugt aus dem Backend: Dort laesst er sich fuer die ganze
/// Flotte an einer Stelle einstellen, waehrend die oertliche Einstellung auf
/// jedem Geraet einzeln steht und nur ueber eine erneute Verteilung zu aendern
/// waere. Die oertliche bleibt der Rueckfall — fuer ein Geraet, das sich noch
/// nie gemeldet hat, und fuer ein Backend, das das Feld nicht kennt.
///
/// Der zuletzt empfangene Wert liegt in der Warteschlangendatenbank und
/// ueberlebt damit Neustart und Selbst-Update. Ohne diese Ablage liefe ein
/// frisch gestarteter Dienst bis zum ersten Check-in nach dem oertlichen Takt
/// — bei einer Flotte, die auf zwoelf Stunden gestellt ist, ein unnoetiger
/// Durchlauf pro Neustart.
/// </summary>
public sealed class CheckinSchedule(
    AgentOptions options,
    SnapshotQueue queue,
    ILogger<CheckinSchedule> logger)
{
    private const string Key = "checkin_interval_minutes";

    /// <summary>
    /// Grenzen wie im Backend. Sie stehen hier ein zweites Mal, weil ein
    /// unsinniger Wert — aus einer aelteren Version, einem Fehler, was auch
    /// immer — den Agent sonst dauerhaft verstummen liesse. Eine Zahl, die von
    /// aussen kommt, wird nicht ungeprueft zum Taktgeber.
    /// </summary>
    private const int MinMinutes = 5;
    private const int MaxMinutes = 360;

    public TimeSpan Interval => TimeSpan.FromMinutes(Stored() ?? options.CheckIntervalMinutes);

    /// <summary>Uebernimmt die Vorgabe aus einer Check-in-Antwort.</summary>
    public void Apply(int? fromBackend)
    {
        if (fromBackend is not { } vorgabe)
        {
            return;
        }

        int begrenzt = Math.Clamp(vorgabe, MinMinutes, MaxMinutes);

        if (begrenzt != vorgabe)
        {
            logger.LogWarning(
                "Das Backend gab {Vorgabe} min vor; verwendet werden {Verwendet} min.",
                vorgabe, begrenzt);
        }

        int? bisher = Stored();
        if (bisher == begrenzt)
        {
            return;
        }

        queue.SetMeta(Key, begrenzt.ToString(CultureInfo.InvariantCulture));

        logger.LogInformation(
            "Melde-Intervall vom Backend uebernommen: {Minuten} min (vorher {Vorher} min).",
            begrenzt, bisher ?? options.CheckIntervalMinutes);
    }

    private int? Stored()
    {
        return queue.GetMeta(Key) is string wert
            && int.TryParse(wert, NumberStyles.Integer, CultureInfo.InvariantCulture, out int parsed)
            && parsed >= MinMinutes
            && parsed <= MaxMinutes
            ? parsed
            : null;
    }
}
