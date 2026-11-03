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
    HealthLogSink logs,
    ILogger<AgentHealth> logger)
{
    /// <summary>
    /// Der Zustand des Tasks wird nicht bei jedem Durchlauf neu abgefragt. Fuenf
    /// Minuten genuegen, damit der letzte Lauf nach einem Update aktuell ist.
    /// </summary>
    private static readonly TimeSpan TaskCacheDuration = TimeSpan.FromMinutes(5);

    /// <summary>Wie weit das Updater-Protokoll zurueck gelesen wird.</summary>
    private static readonly TimeSpan UpdaterLogWindow = TimeSpan.FromDays(7);

    private const int MaxUpdaterEntries = 10;

    private const int MaxErrorLength = 500;

    /// <summary>Wie viele Eintraege das Backend je Snapshot annimmt.</summary>
    private const int MaxLogEntries = 50;

    private readonly Lock _gate = new();

    private UpdaterTaskStatus? _task;
    private DateTimeOffset _taskCheckedAt = DateTimeOffset.MinValue;

    public AgentDiagnostics Read()
    {
        UpdateMarker? marker = UpdateMarker.TryLoad(paths.MarkerPath);

        // Was der Updater gemeldet hat, steht in seiner eigenen Datei; es geht
        // mit denselben Eintraegen hinaus wie die des Dienstes, als solches
        // gekennzeichnet.
        IReadOnlyList<AgentLogEntry> entries =
        [
            .. logs.Recent()
                .Concat(UpdaterLog.ReadProblems(paths.LogDirectory, UpdaterLogWindow, MaxUpdaterEntries)
                    .Select(problem => new AgentLogEntry
                    {
                        At = problem.At,
                        Level = problem.Level,
                        Message = Limits.Truncate($"Updater: {problem.Message}", 1000),
                    }))
                .OrderBy(entry => entry.At)
                .TakeLast(MaxLogEntries),
        ];

        // Die juengste Stoerung ist der letzte Eintrag — sie steht zusaetzlich
        // als eigenes Feld, weil sie in der Oberflaeche an anderer Stelle
        // gebraucht wird als die Liste.
        AgentLogEntry? letzte = entries.Count > 0 ? entries[^1] : null;

        lock (_gate)
        {
            UpdaterTaskStatus? task = ReadUpdaterTask();

            return new AgentDiagnostics
            {
                QueuedSnapshots = queue.Count(),
                SelfUpdateState = marker?.State.ToString(),
                SelfUpdateTarget = marker?.TargetVersion,
                SelfUpdateStartedAt = marker?.StartedAt,
                UpdaterTaskRegistered = task?.Registered ?? false,
                UpdaterTaskEnabled = task is { Registered: true } ? task.Enabled : null,
                UpdaterLastRunAt = task?.LastRunAt,
                UpdaterLastResult = task?.LastRunAt is null ? null : task.LastResult,
                LastError = letzte is null ? null : Limits.Truncate(letzte.Message, MaxErrorLength),
                LastErrorAt = letzte?.At,
                RecentLogs = entries.Count > 0 ? entries : null,
            };
        }
    }

    /// <summary>
    /// Ueber die Aufgabenplanung, mit <c>schtasks</c> als Rueckfall fuer die
    /// blosse Frage, ob es den Task gibt.
    /// </summary>
    private UpdaterTaskStatus? ReadUpdaterTask()
    {
        if (DateTimeOffset.UtcNow - _taskCheckedAt < TaskCacheDuration)
        {
            return _task;
        }

        _task = UpdaterTask.ReadStatus() ?? FallbackStatus();
        _taskCheckedAt = DateTimeOffset.UtcNow;
        return _task;
    }

    /// <summary>
    /// Fragt <c>schtasks</c>. Der Rueckgabewert genuegt — es geht nur darum, ob
    /// der Task ueberhaupt existiert, nicht um seine Einstellungen.
    /// </summary>
    private UpdaterTaskStatus? FallbackStatus()
    {
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
                return _task;
            }

            return new UpdaterTaskStatus(process.ExitCode == 0, Enabled: true, LastRunAt: null, LastResult: null);
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            // Kein Grund, den Durchlauf zu gefaehrden: Die Angabe ist Beiwerk.
            logger.LogDebug("Der Updater-Task liess sich nicht abfragen: {Fehler}", ex.Message);
            return _task;
        }
    }
}
