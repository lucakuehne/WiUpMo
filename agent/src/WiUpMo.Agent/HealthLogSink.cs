using Serilog.Core;
using Serilog.Events;
using WiUpMo.Agent.Contracts;

namespace WiUpMo.Agent;

/// <summary>
/// Haelt die juengsten Warnungen und Fehler aus dem Protokoll fest, damit sie
/// mit dem naechsten Snapshot ans Backend gehen koennen.
///
/// Als Serilog-Sink und nicht als Aufruf an jeder Fundstelle: Sonst muesste
/// jede kuenftige Warnung daran denken, sich auch zu melden — und genau die, an
/// die niemand gedacht hat, ist die interessante.
///
/// Der Sink puffert selbst, statt in <see cref="AgentHealth"/> zu schreiben.
/// Der Grund ist die Reihenfolge beim Start: Der Logger entsteht, bevor es
/// einen Host und damit einen <see cref="AgentHealth"/> gibt. Andersherum ginge
/// alles verloren, was vor dem Hochlauf schiefging — und das ist selten das
/// Uninteressanteste.
/// </summary>
public sealed class HealthLogSink : ILogEventSink
{
    /// <summary>
    /// Fuenfzig Eintraege zu je einem Kilobyte sind im schlechtesten Fall 50 KB
    /// je Check-in. Mehr braucht niemand, um zu sehen, woran ein Geraet haengt.
    /// </summary>
    private const int MaxEntries = 50;
    private const int MaxMessageLength = 1000;

    private readonly Lock _gate = new();
    private readonly Queue<AgentLogEntry> _entries = new();

    public void Emit(LogEvent logEvent)
    {
        if (logEvent.Level < LogEventLevel.Warning)
        {
            return;
        }

        string message = logEvent.RenderMessage();

        // Die Ausnahme gehoert dazu, aber nur ihre Meldung: Eine Stapelspur
        // waere hier Ballast und in der Oberflaeche unlesbar.
        if (logEvent.Exception is { } ex)
        {
            message = $"{message} — {ex.GetType().Name}: {ex.Message}";
        }

        var entry = new AgentLogEntry
        {
            At = logEvent.Timestamp,
            Level = logEvent.Level >= LogEventLevel.Error ? "error" : "warning",
            Message = Limits.Truncate(message, MaxMessageLength),
        };

        lock (_gate)
        {
            _entries.Enqueue(entry);

            while (_entries.Count > MaxEntries)
            {
                _entries.Dequeue();
            }
        }
    }

    /// <summary>Aelteste zuerst. Leer, wenn nichts vorgefallen ist.</summary>
    public IReadOnlyList<AgentLogEntry> Recent()
    {
        lock (_gate)
        {
            return [.. _entries];
        }
    }
}
