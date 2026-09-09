using System.Diagnostics;
using Microsoft.Extensions.Logging;
using WiUpMo.Agent.Contracts;
using WiUpMo.Agent.Install;
using WiUpMo.Agent.Storage;
using WiUpMo.Agent.Update;

namespace WiUpMo.Agent;

/// <summary>
/// Der Zustand des Agents selbst, wie er mit jedem Snapshot ans Backend geht.
///
/// Der Anlass: Ein Auftrag, der auf "zugestellt" stehen bleibt, ein Geraet, das
/// sich nicht meldet — die Erklaerung stand bisher ausschliesslich in einer
/// Protokolldatei auf dem Rechner. Wer sie lesen wollte, musste sich auf das
/// Geraet verbinden, und genau die betroffenen sind oft gerade nicht erreichbar.
/// </summary>
public sealed class AgentHealth(
    SnapshotQueue queue,
    AgentPaths paths,
    ILogger<AgentHealth> logger)
{
    /// <summary>
    /// Die Abfrage des geplanten Tasks startet einen Prozess. Bei einem
    /// Melde-Intervall von Minuten faellt das nicht ins Gewicht, mehrmals pro
    /// Durchlauf soll es trotzdem nicht passieren.
    /// </summary>
    private static readonly TimeSpan TaskCacheDuration = TimeSpan.FromHours(1);

    private const int MaxErrorLength = 500;

    private readonly Lock _gate = new();

    private string? _lastError;
    private DateTimeOffset? _lastErrorAt;

    private bool _taskRegistered;
    private DateTimeOffset _taskCheckedAt = DateTimeOffset.MinValue;

    /// <summary>
    /// Haelt die juengste Stoerung fest. Aufgerufen an den Stellen, die im
    /// Protokoll eine Warnung erzeugen — was dort steht, gehoert auch hierher.
    /// </summary>
    public void Record(string message)
    {
        lock (_gate)
        {
            _lastError = Limits.Truncate(message, MaxErrorLength);
            _lastErrorAt = DateTimeOffset.UtcNow;
        }
    }

    public AgentDiagnostics Read()
    {
        UpdateMarker? marker = UpdateMarker.TryLoad(paths.MarkerPath);

        lock (_gate)
        {
            return new AgentDiagnostics
            {
                QueuedSnapshots = queue.Count(),
                SelfUpdateState = marker?.State.ToString(),
                SelfUpdateTarget = marker?.TargetVersion,
                SelfUpdateStartedAt = marker?.StartedAt,
                UpdaterTaskRegistered = IsUpdaterTaskRegistered(),
                LastError = _lastError,
                LastErrorAt = _lastErrorAt,
            };
        }
    }

    /// <summary>
    /// Fragt <c>schtasks</c>. Der Rueckgabewert genuegt — es geht nur darum, ob
    /// der Task ueberhaupt existiert, nicht um seine Einstellungen.
    /// </summary>
    private bool IsUpdaterTaskRegistered()
    {
        if (DateTimeOffset.UtcNow - _taskCheckedAt < TaskCacheDuration)
        {
            return _taskRegistered;
        }

        try
        {
            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = "schtasks.exe",
                ArgumentList = { "/Query", "/TN", ServiceInstaller.UpdaterTaskName },
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            });

            if (process is null || !process.WaitForExit(10_000))
            {
                return _taskRegistered;
            }

            _taskRegistered = process.ExitCode == 0;
            _taskCheckedAt = DateTimeOffset.UtcNow;
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            // Kein Grund, den Durchlauf zu gefaehrden: Die Angabe ist Beiwerk.
            logger.LogDebug("Der Updater-Task liess sich nicht abfragen: {Fehler}", ex.Message);
        }

        return _taskRegistered;
    }
}
