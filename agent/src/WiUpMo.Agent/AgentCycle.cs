using System.Net;
using Microsoft.Extensions.Logging;
using WiUpMo.Agent.Backend;
using WiUpMo.Agent.Contracts;
using WiUpMo.Agent.Storage;
using WiUpMo.Agent.Update;

namespace WiUpMo.Agent;

/// <summary>
/// Ein vollstaendiger Durchlauf: erfassen, ablegen, uebermitteln.
///
/// Erfassen und Uebermitteln sind bewusst getrennt. Der Snapshot liegt nach dem
/// ersten Schritt dauerhaft in der Warteschlange — ob das Backend gerade
/// erreichbar ist, spielt fuer die Erfassung keine Rolle mehr. Genau das macht
/// den Offline-Betrieb aus.
/// </summary>
public sealed class AgentCycle(
    AgentOptions options,
    SnapshotCollector collector,
    SnapshotQueue queue,
    DeviceIdentityStore identityStore,
    BackendClient backend,
    SelfUpdateService selfUpdate,
    ILogger<AgentCycle> logger)
{
    public async Task RunAsync(CancellationToken ct)
    {
        await CollectAsync(ct).ConfigureAwait(false);
        await FlushAsync(ct).ConfigureAwait(false);
    }

    private async Task CollectAsync(CancellationToken ct)
    {
        DateTimeOffset since = queue.GetLastHistoryTimestamp()
            ?? DateTimeOffset.UtcNow.AddDays(-options.InitialHistoryDays);

        logger.LogInformation("Erfasse Update-Zustand, Historie seit {Seit:u}.", since);

        Snapshot snapshot = await collector.CollectAsync(since, ct).ConfigureAwait(false);

        logger.LogInformation(
            "{Offen} offene Updates, {Historie} Historieneintraege, Quelle {Quelle}, Neustart ausstehend: {Reboot}.",
            snapshot.AvailableUpdates.Count,
            snapshot.History.Count,
            snapshot.UpdateSource.Source,
            snapshot.PendingReboot);

        queue.Enqueue(snapshot);

        int discarded = queue.Prune();
        if (discarded > 0)
        {
            logger.LogWarning(
                "{Anzahl} Snapshots aus der Warteschlange verworfen (Grenze: {Max} Stueck bzw. {Tage} Tage). " +
                "Das Geraet war laenger nicht erreichbar.",
                discarded, options.QueueMaxSnapshots, options.QueueMaxAgeDays);
        }
    }

    /// <summary>
    /// Uebermittelt die gesamte Warteschlange. Fehler beim Senden werden
    /// protokolliert, aber nicht weitergereicht: ein unerreichbares Backend ist
    /// der Normalfall bei einem Laptop, kein Grund den Dienst zu beenden. Die
    /// Snapshots bleiben liegen und gehen beim naechsten Mal mit.
    /// </summary>
    private async Task FlushAsync(CancellationToken ct)
    {
        IReadOnlyList<QueuedSnapshot> pending = queue.Peek(options.QueueMaxSnapshots);
        if (pending.Count == 0)
        {
            return;
        }

        try
        {
            DeviceIdentity identity = await EnsureIdentityAsync(pending[^1].Snapshot.Host, ct)
                .ConfigureAwait(false);

            CheckinResponse response;
            try
            {
                response = await SendAsync(identity, pending, ct).ConfigureAwait(false);
            }
            catch (BackendException ex) when (ex.StatusCode == HttpStatusCode.Unauthorized)
            {
                // Secret gesperrt oder Geraet im Backend entfernt. Einmal neu
                // registrieren und dieselben Snapshots erneut senden — die
                // snapshotId bleibt gleich, ein doppelter Empfang ist deshalb
                // unschaedlich.
                logger.LogWarning("Das Backend hat die Geraeteidentitaet abgelehnt, neue Registrierung.");
                identity = await EnrollAsync(pending[^1].Snapshot.Host, ct).ConfigureAwait(false);
                response = await SendAsync(identity, pending, ct).ConfigureAwait(false);
            }

            Settle(pending, response);

            // Erst das Ergebnis eines laufenden Updates abschliessen, dann
            // einen neuen Auftrag annehmen — und beides erst, nachdem die
            // Warteschlange draussen ist. Ein Selbst-Update mitten in einer
            // vollen Warteschlange wuerde im Fehlerfall beides mitnehmen.
            await selfUpdate.ReportPendingOutcomeAsync(identity, ct).ConfigureAwait(false);

            if (response.AgentUpdate is { } job)
            {
                await selfUpdate.PrepareAsync(identity, job, ct).ConfigureAwait(false);
            }
        }
        catch (Exception ex) when (ex is BackendException or HttpRequestException or TaskCanceledException
                                      && !ct.IsCancellationRequested)
        {
            logger.LogWarning(
                "Uebermittlung fehlgeschlagen, {Anzahl} Snapshots bleiben in der Warteschlange: {Fehler}",
                pending.Count, ex.Message);
        }
        catch (InvalidOperationException ex)
        {
            // Fehlendes Enrollment-Token bei noch nicht registriertem Geraet.
            logger.LogError("{Fehler}", ex.Message);
        }
    }

    private Task<CheckinResponse> SendAsync(
        DeviceIdentity identity,
        IReadOnlyList<QueuedSnapshot> pending,
        CancellationToken ct)
    {
        logger.LogInformation("Uebermittle {Anzahl} Snapshot(s).", pending.Count);
        return backend.CheckinBatchAsync(identity, [.. pending.Select(p => p.Snapshot)], ct);
    }

    /// <summary>
    /// Entfernt alles, was das Backend quittiert hat — auch Abgelehntes. Ein
    /// abgelehnter Snapshot wird durch Wiederholen nicht besser und wuerde die
    /// Warteschlange sonst dauerhaft blockieren.
    /// </summary>
    private void Settle(IReadOnlyList<QueuedSnapshot> pending, CheckinResponse response)
    {
        Dictionary<string, SnapshotResult> byId = response.Results
            .Where(r => !string.IsNullOrEmpty(r.SnapshotId))
            .ToDictionary(r => r.SnapshotId, StringComparer.OrdinalIgnoreCase);

        var settled = new List<long>();
        int accepted = 0;
        int duplicates = 0;

        foreach (QueuedSnapshot queued in pending)
        {
            if (!byId.TryGetValue(queued.Snapshot.SnapshotId.ToString(), out SnapshotResult? result))
            {
                // Ohne Quittung bleibt der Snapshot liegen.
                continue;
            }

            switch (result.Outcome)
            {
                case "accepted":
                    accepted++;
                    settled.Add(queued.Id);
                    break;

                case "duplicate":
                    duplicates++;
                    settled.Add(queued.Id);
                    break;

                case "rejected":
                    logger.LogError(
                        "Snapshot {Id} wurde abgelehnt und wird verworfen: {Grund}",
                        queued.Snapshot.SnapshotId, result.Error ?? "ohne Begruendung");
                    settled.Add(queued.Id);
                    break;

                default:
                    logger.LogWarning(
                        "Unbekanntes Ergebnis '{Ergebnis}' fuer Snapshot {Id}; bleibt in der Warteschlange.",
                        result.Outcome, queued.Snapshot.SnapshotId);
                    break;
            }
        }

        queue.Remove(settled);

        logger.LogInformation(
            "Uebermittlung abgeschlossen: {Angenommen} angenommen, {Doppelt} bereits bekannt, {Rest} verbleiben.",
            accepted, duplicates, queue.Count());
    }

    private async Task<DeviceIdentity> EnsureIdentityAsync(HostInfo host, CancellationToken ct) =>
        identityStore.TryLoad() ?? await EnrollAsync(host, ct).ConfigureAwait(false);

    private async Task<DeviceIdentity> EnrollAsync(HostInfo host, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(options.EnrollmentToken))
        {
            throw new InvalidOperationException(
                "Das Geraet ist nicht registriert und es ist kein Enrollment-Token konfiguriert " +
                "('Agent:EnrollmentToken'). Die Snapshots bleiben so lange in der Warteschlange.");
        }

        logger.LogInformation("Registriere Geraet beim Backend.");

        DeviceIdentity identity = await backend.EnrollAsync(
            new EnrollRequest
            {
                EnrollmentToken = options.EnrollmentToken,
                Host = host,
                AgentVersion = AgentVersion.Current,
            },
            ct).ConfigureAwait(false);

        // Sofort ablegen: das Secret wird genau einmal ausgeliefert.
        identityStore.Save(identity);
        logger.LogInformation("Registriert als Geraet {GeraeteId}.", identity.DeviceId);

        return identity;
    }
}
