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
    CheckinSchedule schedule,
    ILogger<AgentCycle> logger)
{
    public async Task RunAsync(CancellationToken ct)
    {
        // Ganz am Anfang und ohne Netz: Laeuft dieser Prozess in der Zielversion
        // eines laufenden Selbst-Updates, ist der Tausch gelungen. Die Frist des
        // Updaters ist knapp bemessen — sie darf nicht an einer langsamen
        // Update-Suche oder einem unerreichbaren Backend verstreichen.
        selfUpdate.ConfirmSelf();

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
    /// Uebermittelt die Warteschlange, in Schueben. Fehler beim Senden werden
    /// protokolliert, aber nicht weitergereicht: ein unerreichbares Backend ist
    /// der Normalfall bei einem Laptop, kein Grund den Dienst zu beenden. Die
    /// Snapshots bleiben liegen und gehen beim naechsten Mal mit.
    /// </summary>
    private async Task FlushAsync(CancellationToken ct)
    {
        IReadOnlyList<QueuedSnapshot> pending = queue.Peek(options.QueueMaxSnapshots);

        if (pending.Count == 0)
        {
            // Eine leere Warteschlange heisst nicht, dass es nichts zu melden
            // gibt: Ein abgeschlossenes Selbst-Update wartet moeglicherweise
            // noch auf seine Rueckmeldung.
            await ReportUpdateOutcomeAsync(ct).ConfigureAwait(false);
            return;
        }

        int verbleibend = pending.Count;

        try
        {
            DeviceIdentity identity = await EnsureIdentityAsync(pending[^1].Snapshot.Host, ct)
                .ConfigureAwait(false);

            CheckinResponse? letzte = null;

            foreach (IReadOnlyList<QueuedSnapshot> schub in Batches(pending))
            {
                CheckinResponse response;

                try
                {
                    response = await SendAsync(identity, schub, ct).ConfigureAwait(false);
                }
                catch (BackendException ex) when (ex.StatusCode == HttpStatusCode.Unauthorized)
                {
                    // Secret gesperrt oder Geraet im Backend entfernt. Einmal neu
                    // registrieren und dieselben Snapshots erneut senden — die
                    // snapshotId bleibt gleich, ein doppelter Empfang ist deshalb
                    // unschaedlich.
                    logger.LogWarning("Das Backend hat die Geraeteidentitaet abgelehnt, neue Registrierung.");
                    identity = await EnrollAsync(schub[^1].Snapshot.Host, ct).ConfigureAwait(false);
                    response = await SendAsync(identity, schub, ct).ConfigureAwait(false);
                }

                Settle(schub, response);
                schedule.Apply(response.CheckIntervalMinutes);
                verbleibend -= schub.Count;
                letzte = response;
            }

            // Erst das Ergebnis eines laufenden Updates abschliessen, dann
            // einen neuen Auftrag annehmen — und beides erst, nachdem die
            // Warteschlange draussen ist. Ein Selbst-Update mitten in einer
            // vollen Warteschlange wuerde im Fehlerfall beides mitnehmen.
            await selfUpdate.ReportPendingOutcomeAsync(identity, ct).ConfigureAwait(false);

            if (letzte?.AgentUpdate is { } job)
            {
                await selfUpdate.PrepareAsync(identity, job, ct).ConfigureAwait(false);
            }
        }
        catch (BackendException ex) when (ex.StatusCode == HttpStatusCode.Forbidden)
        {
            /**
             * Das Geraet ist im Backend archiviert — meist, weil es nicht mehr
             * im abgeglichenen Bereich des Verzeichnisses liegt.
             *
             * Anders als bei 401 ist das kein Grund, sich neu zu registrieren:
             * Die Identitaet stimmt, sie ist nur nicht mehr erwuenscht. Die
             * gepufferten Snapshots werden verworfen, sonst laeuft die
             * Warteschlange bis an ihre Grenze und der Dienst schleppt Daten
             * mit, die niemand haben will. Kommt das Geraet zurueck, geht es
             * beim naechsten Durchlauf ohne Zutun weiter.
             */
            logger.LogWarning(
                "Das Backend fuehrt dieses Geraet als archiviert; {Anzahl} Snapshots werden verworfen. {Meldung}",
                verbleibend, ex.Message);

            queue.Remove([.. pending.Select(p => p.Id)]);
        }
        catch (Exception ex) when (ex is BackendException or HttpRequestException or TaskCanceledException
                                      && !ct.IsCancellationRequested)
        {
            logger.LogWarning(
                "Uebermittlung fehlgeschlagen, {Anzahl} Snapshots bleiben in der Warteschlange: {Fehler}",
                verbleibend, ex.Message);
        }
        catch (InvalidOperationException ex)
        {
            // Fehlendes Enrollment-Token bei noch nicht registriertem Geraet.
            logger.LogError("{Fehler}", ex.Message);
        }
    }

    /// <summary>
    /// Zerlegt die Warteschlange in Schuebe, die das Backend annimmt.
    ///
    /// Begrenzt wird zuerst nach Groesse, dann nach Stueckzahl. Ein einzelner
    /// Snapshot, der die Byte-Grenze allein schon reisst, geht trotzdem als
    /// eigener Schub hinaus: Ihn zurueckzuhalten hiesse, die Warteschlange
    /// dahinter dauerhaft zu blockieren — und ob er durchkommt, entscheidet
    /// ohnehin erst das Backend.
    /// </summary>
    private IEnumerable<IReadOnlyList<QueuedSnapshot>> Batches(IReadOnlyList<QueuedSnapshot> pending)
    {
        var schub = new List<QueuedSnapshot>();
        int bytes = 0;

        foreach (QueuedSnapshot eintrag in pending)
        {
            if (schub.Count > 0
                && (bytes + eintrag.PayloadBytes > options.BatchMaxBytes
                    || schub.Count >= options.BatchMaxSnapshots))
            {
                yield return schub;
                schub = [];
                bytes = 0;
            }

            schub.Add(eintrag);
            bytes += eintrag.PayloadBytes;
        }

        if (schub.Count > 0)
        {
            yield return schub;
        }
    }

    /// <summary>
    /// Meldet das Ergebnis eines Selbst-Updates ohne anhaengende Warteschlange.
    ///
    /// Nur mit bereits vorhandener Identitaet: Eine Registrierung braucht
    /// Angaben zum Host, die hier gar nicht vorliegen — und ein nie
    /// registriertes Geraet hat auch keinen Auftrag bekommen.
    /// </summary>
    private async Task ReportUpdateOutcomeAsync(CancellationToken ct)
    {
        DeviceIdentity? identity = identityStore.TryLoad();
        if (identity is null)
        {
            return;
        }

        try
        {
            await selfUpdate.ReportPendingOutcomeAsync(identity, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is BackendException or HttpRequestException or TaskCanceledException
                                      && !ct.IsCancellationRequested)
        {
            logger.LogWarning(
                "Das Ergebnis des Selbst-Updates liess sich nicht melden: {Fehler}", ex.Message);
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
