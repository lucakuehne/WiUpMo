using System.Globalization;
using Microsoft.Extensions.Logging;
using WiUpMo.Agent.Storage;

namespace WiUpMo.Agent;

/// <summary>
/// Wann der Agent online nach Updates sucht (ab 0.10.1).
///
/// Nicht mehr bei jedem Check-in: Der kommt alle paar Minuten, damit Auftraege
/// und Neustarts zuegig ankommen. Eine Suche bei WSUS bzw. Microsoft Update
/// braucht es so oft nicht — bis 0.10.0 waren es bei fuenf Minuten zwoelf pro
/// Stunde und Geraet. Der Abstand kommt aus den Einstellungen des Backends, wie
/// das Melde-Intervall.
///
/// Sofort gesucht wird nach dem Start des Agents — also auch nach jedem
/// Neustart des Geraets — und nach einer Installation. Scheitert eine Suche,
/// folgt der naechste Versuch nach einer Viertelstunde, nicht erst nach dem
/// vollen Abstand.
/// </summary>
public sealed class UpdateSearchSchedule(
    AgentOptions options,
    SnapshotQueue queue,
    ILogger<UpdateSearchSchedule> logger)
{
    private const string Key = "search_interval_minutes";

    /// <summary>Grenzen wie im Backend; ein unsinniger Wert von aussen wird nicht zum Taktgeber.</summary>
    private const int MinMinutes = 5;

    private const int MaxMinutes = 1440;

    private static readonly TimeSpan RetryAfterFailure = TimeSpan.FromMinutes(15);

    /// <summary>
    /// Der Durchlauf kommt nicht auf die Sekunde: Ohne diese Toleranz fiele die
    /// faellige Suche gelegentlich auf den uebernaechsten Durchlauf.
    /// </summary>
    private static readonly TimeSpan Tolerance = TimeSpan.FromMinutes(1);

    private readonly Lock _sync = new();
    private DateTimeOffset? _lastSuccess;
    private DateTimeOffset? _lastFailure;
    private string? _requested;

    public TimeSpan Interval =>
        TimeSpan.FromMinutes(Stored() ?? Math.Clamp(options.SearchIntervalMinutes, MinMinutes, MaxMinutes));

    /// <summary>Uebernimmt die Vorgabe aus einer Check-in-Antwort.</summary>
    public void Apply(int? fromBackend)
    {
        if (fromBackend is not { } vorgabe)
        {
            return;
        }

        int begrenzt = Math.Clamp(vorgabe, MinMinutes, MaxMinutes);
        int? bisher = Stored();
        if (bisher == begrenzt)
        {
            return;
        }

        queue.SetMeta(Key, begrenzt.ToString(CultureInfo.InvariantCulture));
        logger.LogInformation(
            "Abstand der Update-Suche vom Backend uebernommen: {Minuten} min (vorher {Vorher} min).",
            begrenzt, bisher ?? options.SearchIntervalMinutes);
    }

    /// <summary>Beim naechsten Durchlauf suchen, unabhaengig vom Abstand — etwa nach einer Installation.</summary>
    public void Request(string reason)
    {
        lock (_sync)
        {
            _requested = reason;
        }
    }

    /// <summary>Warum dieser Durchlauf suchen soll; null, wenn er es nicht soll.</summary>
    public string? Due(DateTimeOffset now)
    {
        lock (_sync)
        {
            if (_requested is not null)
            {
                return _requested;
            }

            TimeSpan retry = RetryAfterFailure < Interval ? RetryAfterFailure : Interval;
            if (_lastFailure is { } failed && now - failed < retry - Tolerance)
            {
                return null;
            }

            if (_lastSuccess is not { } success)
            {
                return _lastFailure is null ? "Start des Agents" : "neuer Versuch";
            }

            if (_lastFailure is not null)
            {
                return "neuer Versuch";
            }

            return now - success >= Interval - Tolerance ? "Abstand erreicht" : null;
        }
    }

    /// <summary>Ab wann die naechste Suche faellig ist, fuers Protokoll.</summary>
    public DateTimeOffset? NextAt
    {
        get
        {
            lock (_sync)
            {
                return _lastFailure is { } failed
                    ? failed + (RetryAfterFailure < Interval ? RetryAfterFailure : Interval)
                    : _lastSuccess + Interval;
            }
        }
    }

    public void Succeeded(DateTimeOffset at)
    {
        lock (_sync)
        {
            _lastSuccess = at;
            _lastFailure = null;
            _requested = null;
        }
    }

    public void Failed(DateTimeOffset at)
    {
        lock (_sync)
        {
            _lastFailure = at;
            _requested = null;
        }
    }

    private int? Stored() =>
        queue.GetMeta(Key) is string wert
        && int.TryParse(wert, NumberStyles.Integer, CultureInfo.InvariantCulture, out int parsed)
        && parsed is >= MinMinutes and <= MaxMinutes
            ? parsed
            : null;
}
