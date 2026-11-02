using System.Net;
using Microsoft.Extensions.Logging;
using WiUpMo.Agent.Backend;
using WiUpMo.Agent.Contracts;
using WiUpMo.Agent.Storage;
using WiUpMo.Agent.Update;
using WiUpMo.Agent.Windows;

namespace WiUpMo.Agent.Installation;

/// <summary>
/// Fuehrt Installationsauftraege aus der Check-in-Antwort aus.
///
/// Die Installation laeuft im Hintergrund, nicht im Durchlauf: Sie kann Stunden
/// dauern, und der Dienst soll in der Zeit weiter melden koennen. Gesucht wird
/// waehrenddessen nicht (siehe <see cref="AgentCycle"/>), weil eine Suche neben
/// einer laufenden Installation auf Windows wartet und ins Zeitlimit liefe.
///
/// Hoechstens ein Auftrag zur Zeit. Das Backend vergibt ohnehin nur einen je
/// Geraet; hier ist es die zweite Sicherung, falls eine Meldung verloren ging
/// und derselbe Auftrag noch einmal kommt.
/// </summary>
public sealed class InstallJobRunner(
    AgentPaths paths,
    BackendClient backend,
    WindowsUpdateInstaller installer,
    CheckinTrigger trigger,
    ILogger<InstallJobRunner> logger)
{
    private readonly Lock _gate = new();
    private Task _current = Task.CompletedTask;

    public bool IsRunning
    {
        get
        {
            lock (_gate)
            {
                return !_current.IsCompleted;
            }
        }
    }

    /// <summary>Fuer <c>--once</c>: wartet, bis eine laufende Installation fertig ist.</summary>
    public Task WhenIdleAsync()
    {
        lock (_gate)
        {
            return _current;
        }
    }

    /// <summary>
    /// Meldet ein Ergebnis, das noch auf der Platte liegt. Laeuft bei jedem
    /// Durchlauf, weil das Backend beim Abschluss nicht erreichbar gewesen sein
    /// kann.
    /// </summary>
    public async Task ReportPendingOutcomeAsync(DeviceIdentity identity, CancellationToken ct)
    {
        if (IsRunning)
        {
            return;
        }

        InstallMarker? marker = InstallMarker.TryLoad(paths.InstallMarkerPath);
        if (marker is null)
        {
            return;
        }

        if (marker.State == InstallState.Running)
        {
            // In diesem Prozess laeuft nichts — der Dienst wurde waehrend der
            // Installation beendet, meist durch Herunterfahren oder Neustart.
            // Was Windows davon noch fertig bekam, zeigt der naechste Snapshot.
            marker.State = InstallState.Failed;
            marker.CompletedAt = DateTimeOffset.UtcNow;
            marker.Error = "Unterbrochen: Der Dienst wurde waehrend der Installation beendet.";
            marker.Save(paths.InstallMarkerPath);

            logger.LogWarning(
                "Installationsauftrag {Auftrag} vom {Start:u} wurde unterbrochen.", marker.JobId, marker.StartedAt);
        }

        try
        {
            await ReportOutcomeAsync(identity, marker, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is BackendException or HttpRequestException or TaskCanceledException
                                      && !ct.IsCancellationRequested)
        {
            logger.LogWarning(
                "Das Ergebnis des Installationsauftrags {Auftrag} liess sich nicht melden: {Fehler}",
                marker.JobId, ex.Message);
        }
    }

    /// <summary>
    /// Nimmt einen Auftrag an und startet ihn im Hintergrund — sofern gerade
    /// keiner laeuft, kein Selbst-Update ansteht und Windows bereit ist.
    ///
    /// Was nicht sofort geht, bleibt im Backend auf "zugestellt" und kommt mit
    /// dem naechsten Check-in wieder. Der Agent muss sich dafuer nichts merken.
    /// </summary>
    public async Task AcceptAsync(DeviceIdentity identity, InstallRequest request, CancellationToken ct)
    {
        if (IsRunning || InstallMarker.TryLoad(paths.InstallMarkerPath) is not null)
        {
            // Derselbe Auftrag noch einmal, weil "running" nicht ankam — oder ein
            // Ergebnis wartet noch auf seine Meldung. Beides erledigt sich ohne Zutun.
            logger.LogInformation(
                "Installationsauftrag {Auftrag} wartet: Ein anderer laeuft noch oder ist nicht gemeldet.",
                request.JobId);
            return;
        }

        if (UpdateMarker.TryLoad(paths.MarkerPath) is not null)
        {
            // Der Updater koennte den Dienst mitten in der Installation anhalten.
            logger.LogInformation(
                "Installationsauftrag {Auftrag} wartet auf das Ende des Selbst-Updates.", request.JobId);
            return;
        }

        InstallReadiness readiness;
        try
        {
            readiness = await installer.CheckReadinessAsync(ct).ConfigureAwait(false);
        }
        catch (WindowsUpdateException ex)
        {
            logger.LogWarning(
                "Installationsauftrag {Auftrag} wartet, der Installer ist nicht ansprechbar: {Fehler}",
                request.JobId, ex.Message);
            return;
        }

        if (readiness == InstallReadiness.Busy)
        {
            logger.LogInformation(
                "Installationsauftrag {Auftrag} wartet: Windows installiert gerade selbst.", request.JobId);
            return;
        }

        var marker = new InstallMarker
        {
            JobId = request.JobId,
            UpdateIds = [.. request.UpdateIds.Take(Limits.ArrayItems)],
            State = InstallState.Running,
            StartedAt = DateTimeOffset.UtcNow,
        };

        if (readiness == InstallReadiness.RebootRequired)
        {
            // Warten hilft hier nicht, und neu gestartet wird nie vom Agent.
            // Gescheitert mit Begruendung ist ehrlicher als wochenlang
            // "zugestellt": Nach dem Neustart laesst sich neu beauftragen.
            marker.State = InstallState.Failed;
            marker.CompletedAt = DateTimeOffset.UtcNow;
            marker.Error = "Windows verlangt vor weiteren Installationen einen Neustart. " +
                           "Nach dem Neustart den Auftrag neu anlegen.";
            marker.Save(paths.InstallMarkerPath);

            logger.LogWarning("Installationsauftrag {Auftrag}: {Fehler}", request.JobId, marker.Error);
            await ReportPendingOutcomeAsync(identity, ct).ConfigureAwait(false);
            return;
        }

        // Erst ablegen, dann melden: Ein Absturz dazwischen hinterlaesst so
        // einen Marker, den der naechste Start als unterbrochen meldet — statt
        // eines Auftrags, der im Backend ewig laeuft.
        marker.Save(paths.InstallMarkerPath);

        try
        {
            await backend.ReportInstallResultAsync(
                identity,
                new InstallResultRequest { JobId = marker.JobId, State = "running" },
                ct).ConfigureAwait(false);
        }
        catch (BackendException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            // Inzwischen abgebrochen oder abgelaufen. Dann wird nicht installiert.
            InstallMarker.TryDelete(paths.InstallMarkerPath);
            logger.LogInformation(
                "Installationsauftrag {Auftrag} ist im Backend nicht mehr offen und entfaellt.", marker.JobId);
            return;
        }
        catch (Exception ex) when (ex is BackendException or HttpRequestException or TaskCanceledException
                                      && !ct.IsCancellationRequested)
        {
            // Der Auftrag kam eben erst vom Backend; dass es jetzt nicht
            // antwortet, ist kein Grund, ihn liegen zu lassen. Das Ergebnis
            // nimmt das Backend auch ohne vorherige Startmeldung an.
            logger.LogWarning(
                "Der Start des Installationsauftrags {Auftrag} liess sich nicht melden, er laeuft trotzdem: {Fehler}",
                marker.JobId, ex.Message);
        }

        logger.LogInformation(
            "Installationsauftrag {Auftrag} gestartet: {Anzahl} Update(s).", marker.JobId, marker.UpdateIds.Count);

        lock (_gate)
        {
            _current = Task.Run(() => RunAsync(identity, marker, ct), CancellationToken.None);
        }
    }

    private async Task RunAsync(DeviceIdentity identity, InstallMarker marker, CancellationToken ct)
    {
        try
        {
            InstallOutcome outcome = await installer.InstallAsync(marker.UpdateIds, ct).ConfigureAwait(false);

            marker.Results = [.. outcome.Results];
            marker.State = outcome.Installed == outcome.Offered ? InstallState.Done : InstallState.Failed;
            marker.Error = Describe(outcome);

            logger.LogInformation(
                "Installationsauftrag {Auftrag} abgeschlossen: {Installiert} von {Angeboten} angebotenen Update(s) " +
                "installiert, {Nicht} nicht angeboten. Neustart noetig: {Neustart}.",
                marker.JobId, outcome.Installed, outcome.Offered, outcome.Results.Count - outcome.Offered,
                outcome.RebootRequired);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Der Dienst endet. Der Marker bleibt auf "laeuft"; der naechste
            // Start meldet den Auftrag als unterbrochen.
            return;
        }
        catch (WindowsUpdateException ex)
        {
            marker.State = InstallState.Failed;
            marker.Error = ex.Message;
            logger.LogWarning("Installationsauftrag {Auftrag} gescheitert: {Fehler}", marker.JobId, ex.Message);
        }
        catch (Exception ex)
        {
            marker.State = InstallState.Failed;
            marker.Error = ex.Message;
            logger.LogError(ex, "Installationsauftrag {Auftrag} mit unerwartetem Fehler abgebrochen.", marker.JobId);
        }

        marker.CompletedAt = DateTimeOffset.UtcNow;

        try
        {
            marker.Save(paths.InstallMarkerPath);
            await ReportOutcomeAsync(identity, marker, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is IOException or BackendException or HttpRequestException
                                      or TaskCanceledException && !ct.IsCancellationRequested)
        {
            logger.LogWarning(
                "Das Ergebnis des Installationsauftrags {Auftrag} liess sich nicht melden, der naechste " +
                "Durchlauf versucht es erneut: {Fehler}",
                marker.JobId, ex.Message);
        }

        // Der neue Stand soll sofort im Backend stehen, nicht erst nach dem
        // naechsten Intervall — und waehrend der Installation wurde nicht gesucht.
        trigger.RequestRun("Installation abgeschlossen");
    }

    /// <summary>Was die Zahlen nicht sagen: nichts mehr angeboten, teilweise gescheitert.</summary>
    private static string? Describe(InstallOutcome outcome)
    {
        if (outcome.Offered == 0)
        {
            return "Keines der Updates wird dem Geraet noch angeboten — inzwischen installiert, " +
                   "zurueckgezogen oder an der Update-Quelle nicht freigegeben.";
        }

        int failed = outcome.Offered - outcome.Installed;
        return failed > 0 ? $"{failed} von {outcome.Offered} Update(s) nicht installiert." : null;
    }

    /// <summary>
    /// Meldet ein abgeschlossenes Ergebnis und raeumt den Marker weg. 404 heisst,
    /// das Backend fuehrt den Auftrag nicht mehr als offen — dann ist auch hier
    /// nichts mehr zu tun.
    /// </summary>
    private async Task ReportOutcomeAsync(DeviceIdentity identity, InstallMarker marker, CancellationToken ct)
    {
        try
        {
            await backend.ReportInstallResultAsync(
                identity,
                new InstallResultRequest
                {
                    JobId = marker.JobId,
                    State = marker.State == InstallState.Done ? "done" : "failed",
                    Results = marker.Results,
                    Error = Limits.TruncateOrNull(marker.Error, Limits.InstallError),
                },
                ct).ConfigureAwait(false);
        }
        catch (BackendException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            logger.LogWarning(
                "Installationsauftrag {Auftrag} ist im Backend nicht mehr offen; das Ergebnis wird verworfen.",
                marker.JobId);
        }

        InstallMarker.TryDelete(paths.InstallMarkerPath);
    }
}
