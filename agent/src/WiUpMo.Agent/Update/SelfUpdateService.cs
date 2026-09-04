using System.Globalization;
using System.Security.Cryptography;
using Microsoft.Extensions.Logging;
using WiUpMo.Agent.Backend;
using WiUpMo.Agent.Contracts;
using WiUpMo.Agent.Storage;

namespace WiUpMo.Agent.Update;

/// <summary>
/// Die Dienst-Seite des Selbst-Updates: herunterladen, pruefen, bereitlegen —
/// und nach dem Tausch das Ergebnis melden.
///
/// Getauscht wird hier nichts. Das macht der Updater-Task, weil eine laufende
/// EXE sich nicht selbst ersetzen kann.
/// </summary>
public sealed class SelfUpdateService(
    AgentPaths paths,
    BackendClient backend,
    ILogger<SelfUpdateService> logger)
{
    /// <summary>
    /// Verarbeitet ein Ergebnis, das noch offen ist, weil der Dienst zwischen
    /// Tausch und Meldung neu gestartet wurde. Laeuft bei jedem Durchlauf, weil
    /// beim ersten Versuch das Backend unerreichbar sein kann.
    /// </summary>
    public async Task ReportPendingOutcomeAsync(DeviceIdentity identity, CancellationToken ct)
    {
        UpdateMarker? marker = UpdateMarker.TryLoad(paths.MarkerPath);
        if (marker is null)
        {
            return;
        }

        // Wir laufen in der Zielversion — der Tausch hat geklappt. Das sofort
        // festhalten, noch vor jedem Netzwerkzugriff: Ab hier darf der Updater
        // nicht mehr zurueckdrehen, auch wenn das Backend tagelang nicht
        // erreichbar ist.
        if (marker.State == UpdateState.Verifying && marker.TargetVersion == AgentVersion.Current)
        {
            marker.State = UpdateState.Verified;
            marker.Save(paths.MarkerPath);
            logger.LogInformation("Selbst-Update auf {Version} bestaetigt.", marker.TargetVersion);
        }

        switch (marker.State)
        {
            case UpdateState.Verified:
                await backend.ReportUpdateResultAsync(
                    identity,
                    new UpdateResultRequest
                    {
                        JobId = marker.JobId,
                        State = "done",
                        AgentVersion = AgentVersion.Current,
                    },
                    ct).ConfigureAwait(false);

                UpdateMarker.TryDelete(paths.MarkerPath);
                TryDeleteFile(paths.BackupExe);
                break;

            case UpdateState.RolledBack:
                logger.LogWarning(
                    "Selbst-Update auf {Version} wurde zurueckgenommen: {Fehler}",
                    marker.TargetVersion, marker.Error ?? "ohne Angabe");

                await backend.ReportUpdateResultAsync(
                    identity,
                    new UpdateResultRequest
                    {
                        JobId = marker.JobId,
                        State = "failed",
                        AgentVersion = AgentVersion.Current,
                        Error = marker.Error ?? "Der Dienst startete nach dem Tausch nicht.",
                    },
                    ct).ConfigureAwait(false);

                UpdateMarker.TryDelete(paths.MarkerPath);
                break;

            case UpdateState.PendingSwap:
            case UpdateState.Verifying:
                // Der Updater ist zustaendig. Nichts tun — und vor allem keinen
                // zweiten Auftrag annehmen.
                break;
        }
    }

    /// <summary>
    /// Nimmt einen Auftrag an, sofern gerade keiner laeuft.
    /// </summary>
    public async Task PrepareAsync(
        DeviceIdentity identity,
        AgentUpdateJob job,
        CancellationToken ct)
    {
        if (job.TargetVersion == AgentVersion.Current)
        {
            // Das Backend kennt unsere Version noch nicht — der letzte
            // Check-in war der erste in dieser Fassung. Nichts zu tun; als
            // erledigt melden, damit der Auftrag nicht ewig offen bleibt.
            await backend.ReportUpdateResultAsync(
                identity,
                new UpdateResultRequest
                {
                    JobId = job.JobId,
                    State = "done",
                    AgentVersion = AgentVersion.Current,
                },
                ct).ConfigureAwait(false);
            return;
        }

        if (UpdateMarker.TryLoad(paths.MarkerPath) is not null)
        {
            logger.LogInformation("Es laeuft bereits ein Selbst-Update, der neue Auftrag wartet.");
            return;
        }

        logger.LogInformation(
            "Selbst-Update von {Von} auf {Nach} vorbereiten.", AgentVersion.Current, job.TargetVersion);

        string temporary = paths.StagedExe + ".part";

        try
        {
            await backend.DownloadAsync(identity, job.DownloadPath, temporary, ct).ConfigureAwait(false);

            string actual = await ComputeSha256Async(temporary, ct).ConfigureAwait(false);

            if (!string.Equals(actual, job.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                // Abbruch statt Tausch. Eine Datei unbekannter Herkunft als
                // Dienst unter LocalSystem zu starten, waere der schlimmste
                // denkbare Ausgang dieses Vorgangs.
                throw new InvalidOperationException(
                    $"Die Pruefsumme stimmt nicht. Erwartet {job.Sha256}, erhalten {actual}.");
            }

            File.Move(temporary, paths.StagedExe, overwrite: true);

            new UpdateMarker
            {
                JobId = job.JobId,
                TargetVersion = job.TargetVersion,
                FromVersion = AgentVersion.Current,
                State = UpdateState.PendingSwap,
                StartedAt = DateTimeOffset.UtcNow,
            }.Save(paths.MarkerPath);

            await backend.ReportUpdateResultAsync(
                identity,
                new UpdateResultRequest { JobId = job.JobId, State = "installing" },
                ct).ConfigureAwait(false);

            logger.LogInformation(
                "Neue Fassung liegt bereit. Der Updater-Task tauscht sie beim naechsten Lauf ein.");
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException or BackendException
                                      or HttpRequestException && !ct.IsCancellationRequested)
        {
            TryDeleteFile(temporary);
            TryDeleteFile(paths.StagedExe);

            logger.LogError("Selbst-Update konnte nicht vorbereitet werden: {Fehler}", ex.Message);

            // Als gescheitert melden, damit der Auftrag nicht offen bleibt und
            // das Geraet bei jedem Check-in erneut denselben Anlauf nimmt.
            try
            {
                await backend.ReportUpdateResultAsync(
                    identity,
                    new UpdateResultRequest
                    {
                        JobId = job.JobId,
                        State = "failed",
                        AgentVersion = AgentVersion.Current,
                        Error = ex.Message,
                    },
                    ct).ConfigureAwait(false);
            }
            catch (Exception report) when (report is BackendException or HttpRequestException)
            {
                logger.LogWarning("Der Fehlschlag liess sich nicht melden: {Fehler}", report.Message);
            }
        }
    }

    private static async Task<string> ComputeSha256Async(string path, CancellationToken ct)
    {
        await using FileStream stream = File.OpenRead(path);
        byte[] hash = await SHA256.HashDataAsync(stream, ct).ConfigureAwait(false);
        return Convert.ToHexString(hash).ToLower(CultureInfo.InvariantCulture);
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (IOException)
        {
            // Beim naechsten Anlauf.
        }
    }
}
