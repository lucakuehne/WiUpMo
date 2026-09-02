using WiUpMo.Agent.Contracts;
using WiUpMo.Agent.Windows;

namespace WiUpMo.Agent;

public sealed class SnapshotCollector(AgentOptions options)
{
    private readonly WindowsUpdateReader _updates = new(options);
    private readonly HostInspector _host = new();
    private readonly UpdateSourceInspector _updateSource = new();

    /// <summary>
    /// Erfasst den vollstaendigen Zustand des Geraets.
    ///
    /// <c>collectedAt</c> wird zu Beginn gesetzt, nicht am Ende: der Zeitstempel
    /// ist zugleich der Fortschrittsmarker fuer die Historie. Wird er auf den
    /// Startzeitpunkt gesetzt, faellt ein Historieneintrag, der waehrend der
    /// laufenden Erfassung entsteht, in das naechste Fenster — bei einem
    /// Endzeitpunkt fiele er dagegen durch beide Fenster und ginge verloren.
    /// </summary>
    public async Task<Snapshot> CollectAsync(DateTimeOffset historySince, CancellationToken ct)
    {
        DateTimeOffset collectedAt = DateTimeOffset.UtcNow;

        HostInfo host = _host.Read();
        UpdateSourceInfo updateSource = _updateSource.Read();
        bool pendingReboot = _host.IsRebootPending();

        IReadOnlyList<AvailableUpdate> available =
            await _updates.GetAvailableUpdatesAsync(ct).ConfigureAwait(false);
        IReadOnlyList<HistoryEntry> history =
            await _updates.GetHistoryAsync(historySince, ct).ConfigureAwait(false);

        return new Snapshot
        {
            SnapshotId = Guid.NewGuid(),
            CollectedAt = collectedAt,
            AgentVersion = AgentVersion.Current,
            Host = host,
            UpdateSource = updateSource,
            PendingReboot = pendingReboot,
            AvailableUpdates = available,
            History = history,
        };
    }
}
