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
    private const string Key = "checkin_interval_hours";

    /// <summary>
    /// Grenzen wie im Backend. Sie stehen hier ein zweites Mal, weil ein
    /// unsinniger Wert — aus einer aelteren Version, einem Fehler, was auch
    /// immer — den Agent sonst dauerhaft verstummen liesse. Eine Zahl, die von
    /// aussen kommt, wird nicht ungeprueft zum Taktgeber.
    /// </summary>
    private const double MinHours = 0.25;
    private const double MaxHours = 168;

    public TimeSpan Interval => TimeSpan.FromHours(Stored() ?? options.CheckIntervalHours);

    /// <summary>Uebernimmt die Vorgabe aus einer Check-in-Antwort.</summary>
    public void Apply(double? fromBackend)
    {
        if (fromBackend is not { } vorgabe || double.IsNaN(vorgabe))
        {
            return;
        }

        double begrenzt = Math.Clamp(vorgabe, MinHours, MaxHours);

        if (Math.Abs(begrenzt - vorgabe) > 0.001)
        {
            logger.LogWarning(
                "Das Backend gab {Vorgabe} h vor; verwendet werden {Verwendet} h.", vorgabe, begrenzt);
        }

        double? bisher = Stored();
        if (bisher is { } alt && Math.Abs(alt - begrenzt) < 0.001)
        {
            return;
        }

        queue.SetMeta(Key, begrenzt.ToString("R", CultureInfo.InvariantCulture));

        logger.LogInformation(
            "Melde-Intervall vom Backend uebernommen: {Stunden} h (vorher {Vorher} h).",
            begrenzt, bisher ?? options.CheckIntervalHours);
    }

    private double? Stored()
    {
        return queue.GetMeta(Key) is string wert
            && double.TryParse(wert, NumberStyles.Float, CultureInfo.InvariantCulture, out double parsed)
            && parsed >= MinHours
            && parsed <= MaxHours
            ? parsed
            : null;
    }
}
