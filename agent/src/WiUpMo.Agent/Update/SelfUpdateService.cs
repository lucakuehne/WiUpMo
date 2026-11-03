using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using Microsoft.Extensions.Logging;
using WiUpMo.Agent.Backend;
using WiUpMo.Agent.Contracts;
using WiUpMo.Agent.Install;
using WiUpMo.Agent.Storage;

namespace WiUpMo.Agent.Update;

/// <summary>
/// Die Dienst-Seite des Selbst-Updates: herunterladen, pruefen, bereitlegen,
/// den Updater anstossen — und nach der Umstellung das Ergebnis melden.
///
/// Umgestellt wird hier nichts. Das macht der Updater, weil er den Dienst
/// anhalten muss und dabei nicht selbst der Dienst sein kann.
/// </summary>
public sealed class SelfUpdateService(
    AgentPaths paths,
    BackendClient backend,
    ILogger<SelfUpdateService> logger)
{
    /// <summary>Ab dieser Version beherrscht der Updater das Umstellen per <c>binPath</c> und den Mutex.</summary>
    private const string VersionedUpdaterSince = "0.8.0";

    /// <summary>
    /// Frist, nach der ein begonnenes Selbst-Update als steckengeblieben gilt.
    ///
    /// Der regulaere Weg dauert Minuten. Wer nach zwei Stunden noch nicht durch
    /// ist, kommt auch nicht mehr durch — meist, weil der geplante Task fehlt
    /// oder abgeschaltet wurde.
    /// </summary>
    private static readonly TimeSpan StuckAfter = TimeSpan.FromHours(2);

    /// <summary>
    /// So viele Durchlaeufe muss dieser Prozess einen ueberfaelligen Marker
    /// gesehen haben, bevor er ihn aufgibt.
    ///
    /// Das Alter allein genuegt nicht: Klappt jemand das Notebook kurz nach dem
    /// Bereitlegen zu, laeuft auch der Task nicht. Beim Aufwachen meldete sich
    /// der Dienst sofort, sah einen Marker von gestern und gab auf, bevor der
    /// Task ueberhaupt eine Gelegenheit hatte. Die Durchlaeufe zaehlen nur, was
    /// der Dienst wach erlebt hat; der Task laeuft in der Zeit mehrmals.
    /// </summary>
    private const int StuckObservations = 6;

    private string? _overdueJob;
    private int _overdueSeen;

    /// <summary>
    /// Ob dieser Prozess die Zielversion eines laufenden Updates ist und sich
    /// noch bestaetigen muss. Der Dienst verzichtet dann auf die
    /// Startverzoegerung — die Frist des Updaters laeuft schon.
    /// </summary>
    public bool AwaitsConfirmation =>
        UpdateMarker.TryLoad(paths.MarkerPath) is { State: UpdateState.Verifying } marker
        && marker.TargetVersion == AgentVersion.Current;

    // --- Beim Start -------------------------------------------------------------

    /// <summary>
    /// Richtet den Updater-Task ein, wenn er fehlt oder noch die
    /// Voreinstellungen hat, mit denen er im Akkubetrieb nicht startet.
    ///
    /// Beim Dienststart, weil der Dienst als SYSTEM laeuft und den Task anlegen
    /// darf — so werden auch Geraete korrigiert, die vor 0.7.2 installiert
    /// wurden, ohne dass jemand <c>--install</c> erneut ausfuehrt.
    /// </summary>
    public void EnsureUpdaterTask()
    {
        // Ohne Updater-Kopie neben dem Dienst gibt es nichts einzurichten — etwa
        // bei einem Aufruf von Hand aus einem anderen Verzeichnis.
        if (!File.Exists(paths.UpdaterExe))
        {
            return;
        }

        try
        {
            if (UpdaterTask.IsCurrent() != false)
            {
                return;
            }

            string? error = UpdaterTask.Register(paths.UpdaterExe, paths.DataDirectory);
            if (error is null)
            {
                logger.LogInformation(
                    "Updater-Task neu eingerichtet: laeuft auch im Akkubetrieb und holt verpasste Laeufe nach.");
            }
            else
            {
                logger.LogWarning("Der Updater-Task liess sich nicht neu einrichten: {Fehler}", error);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
                                      or System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            logger.LogWarning("Der Updater-Task liess sich nicht pruefen: {Fehler}", ex.Message);
        }
    }

    /// <summary>
    /// Zieht die Updater-Kopie auf den eigenen Stand, wenn sie aelter ist.
    ///
    /// Bis 0.8.0 blieb sie auf dem Stand der Installation, und ihre Fehler waren
    /// nicht zu beheben. Nachgezogen wird nur, was sich bestaetigt hat — dieser
    /// Prozess laeuft, und es steht kein Update aus —, und nur aufwaerts: Nach
    /// einem Ruecktausch auf eine aeltere Fassung bleibt der neuere Updater.
    /// </summary>
    public void RefreshUpdater()
    {
        if (!File.Exists(paths.UpdaterExe)
            || UpdateMarker.TryLoad(paths.MarkerPath) is not null
            || AgentVersion.Compare(ReadFileVersion(paths.UpdaterExe), AgentVersion.Current) >= 0)
        {
            return;
        }

        string temporary = paths.UpdaterExe + ".new";

        try
        {
            File.Copy(paths.ProcessPath, temporary, overwrite: true);

            bool replaced = Updater.RunExclusive(
                () => File.Move(temporary, paths.UpdaterExe, overwrite: true));

            if (replaced)
            {
                logger.LogInformation("Updater-Kopie auf {Version} nachgezogen.", AgentVersion.Current);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Beim naechsten Start oder nach dem naechsten Update.
            logger.LogWarning("Die Updater-Kopie liess sich nicht nachziehen: {Fehler}", ex.Message);
        }
        finally
        {
            TryDeleteFile(temporary);
        }
    }

    // --- Bestaetigen und melden -------------------------------------------------

    /// <summary>
    /// Bestaetigt eine Umstellung — rein lokal, ohne jeden Netzwerkzugriff.
    ///
    /// Aufgerufen nach dem ersten Durchlauf, nicht beim Start: Eine Fassung,
    /// die zwar startet, aber im Durchlauf scheitert, soll der Updater
    /// zuruecknehmen. Der Durchlauf braucht kein Netz — ein Laptop ausserhalb des
    /// Firmennetzes bestaetigt sich genauso. Stand die Bestaetigung frueher im
    /// Check-in, drehte eine gescheiterte Uebermittlung nach Ablauf der Frist
    /// eine einwandfrei laufende Fassung zurueck.
    /// </summary>
    public void ConfirmSelf()
    {
        UpdateMarker? marker = UpdateMarker.TryLoad(paths.MarkerPath);

        if (marker is null
            || marker.State != UpdateState.Verifying
            || marker.TargetVersion != AgentVersion.Current)
        {
            return;
        }

        marker.State = UpdateState.Verified;
        marker.Save(paths.MarkerPath);
        logger.LogInformation("Selbst-Update auf {Version} bestaetigt.", marker.TargetVersion);
    }

    /// <summary>
    /// Meldet ein Ergebnis, das noch offen ist. Laeuft bei jedem Durchlauf, weil
    /// beim ersten Versuch das Backend unerreichbar sein kann.
    /// </summary>
    public async Task ReportPendingOutcomeAsync(DeviceIdentity identity, CancellationToken ct)
    {
        UpdateMarker? marker = UpdateMarker.TryLoad(paths.MarkerPath);
        if (marker is null)
        {
            // Bei jedem Durchlauf ohne laufendes Update: Scheiterte das Nachziehen
            // einmal — etwa weil ein alter Updater gerade lief —, kommt es so
            // ohne Neustart nach. Liegt die Kopie schon auf dem Stand, kostet das
            // nur das Lesen ihrer Version.
            RefreshUpdater();
            return;
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
                CleanUpAfterSuccess(marker);
                RefreshUpdater();
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
                DiscardTarget(marker);
                break;

            case UpdateState.PendingSwap:
            case UpdateState.Verifying:
                await AbandonIfStaleAsync(identity, marker, ct).ConfigureAwait(false);
                break;
        }
    }

    /// <summary>
    /// Raeumt einen liegengebliebenen Marker weg.
    ///
    /// Ohne das blockiert er jeden weiteren Auftrag dauerhaft und lautlos:
    /// <see cref="PrepareAsync"/> lehnt ab, solange ein Marker existiert, und
    /// meldet dem Backend nichts — der Auftrag bliebe fuer immer auf
    /// "zugestellt" stehen, und das Geraet faellt still aus dem Update-Betrieb.
    /// </summary>
    private async Task AbandonIfStaleAsync(
        DeviceIdentity identity,
        UpdateMarker marker,
        CancellationToken ct)
    {
        if (DateTimeOffset.UtcNow - marker.StartedAt < StuckAfter)
        {
            // Noch in der Frist: Der Updater ist zustaendig, hier ist nichts zu tun.
            return;
        }

        if (_overdueJob != marker.JobId)
        {
            _overdueJob = marker.JobId;
            _overdueSeen = 0;
        }

        if (++_overdueSeen < StuckObservations)
        {
            return;
        }

        logger.LogWarning(
            "Das Selbst-Update auf {Version} steht seit {Start:u} im Zustand {Zustand} und wird "
                + "aufgegeben. Laeuft der geplante Task '{Task}'?",
            marker.TargetVersion, marker.StartedAt, marker.State, ServiceInstaller.UpdaterTaskName);

        string detail = marker.LastAttemptError is null
            ? "Vermutlich laeuft der Updater-Task nicht."
            : $"Letzter Fehler des Updaters: {marker.LastAttemptError}";

        await backend.ReportUpdateResultAsync(
            identity,
            new UpdateResultRequest
            {
                JobId = marker.JobId,
                State = "failed",
                AgentVersion = AgentVersion.Current,
                Error = $"Der Tausch blieb im Zustand {marker.State} stecken ({marker.Attempts} Anlaeufe). {detail}",
            },
            ct).ConfigureAwait(false);

        // Erst nach der Meldung: Bleibt der Marker liegen, weil das Backend
        // gerade nicht erreichbar ist, wird beim naechsten Durchlauf erneut
        // gemeldet. Weggeraeumt und ungemeldet waere der schlechtere Ausgang.
        UpdateMarker.TryDelete(paths.MarkerPath);
        DiscardTarget(marker);
    }

    // --- Bereitlegen ------------------------------------------------------------

    /// <summary>
    /// Nimmt einen Auftrag an, sofern gerade keiner laeuft: herunterladen,
    /// pruefen, bereitlegen, und — wenn der Updater es beherrscht — ihn sofort
    /// anstossen, statt auf den naechsten Task-Lauf zu warten.
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

        // Der neue Weg nur mit einem Updater, der ihn kennt. Ein aelterer
        // verwuerfe den Marker, weil er die bereitgelegte Datei am alten Ort
        // sucht; er bekommt den alten Weg, bis eine bestaetigte neue Fassung ihn
        // nachgezogen hat.
        //
        // Die Zielversion wird Teil eines Verzeichnisnamens; sie darf deshalb
        // nichts enthalten, was aus dem Versionsverzeichnis hinausfuehrt.
        bool versioned = IsPlainVersion(job.TargetVersion)
            && AgentVersion.Compare(ReadFileVersion(paths.UpdaterExe), VersionedUpdaterSince) >= 0;
        string staged = versioned ? paths.VersionExe(job.TargetVersion) : paths.StagedExe;
        string temporary = staged + ".part";

        logger.LogInformation(
            "Selbst-Update von {Von} auf {Nach} vorbereiten ({Weg}).",
            AgentVersion.Current, job.TargetVersion, versioned ? "Umstellen" : "Dateitausch");

        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(staged)!);
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

            File.Move(temporary, staged, overwrite: true);

            new UpdateMarker
            {
                JobId = job.JobId,
                TargetVersion = job.TargetVersion,
                FromVersion = AgentVersion.Current,
                State = UpdateState.PendingSwap,
                StartedAt = DateTimeOffset.UtcNow,
                TargetPath = versioned ? staged : null,
                FromPath = versioned ? paths.ProcessPath : null,
            }.Save(paths.MarkerPath);

            await backend.ReportUpdateResultAsync(
                identity,
                new UpdateResultRequest { JobId = job.JobId, State = "installing" },
                ct).ConfigureAwait(false);

            if (versioned && StartUpdater())
            {
                logger.LogInformation("Neue Fassung liegt bereit, der Updater stellt jetzt um.");
            }
            else
            {
                logger.LogInformation(
                    "Neue Fassung liegt bereit. Der Updater-Task stellt sie beim naechsten Lauf ein.");
            }
        }
        // TaskCanceledException gehoert dazu: Sie ist die Zeitueberschreitung des
        // HttpClient. Fehlte sie hier, flog sie an dieser Stelle vorbei, das
        // Backend erfuhr nichts, und der Auftrag blieb auf "zugestellt" — bei
        // jedem Durchlauf aufs Neue. `ct.IsCancellationRequested` trennt das vom
        // regulaeren Beenden des Dienstes, bei dem nichts zu melden ist.
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException
                                      or BackendException or HttpRequestException or TaskCanceledException
                                      && !ct.IsCancellationRequested)
        {
            TryDeleteFile(temporary);
            TryDeleteFile(staged);

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

    /// <summary>
    /// Startet den Updater als eigenen Prozess. Er haelt den Dienst an — also
    /// auch diesen Prozess — und laeuft dabei weiter, weil er kein Kind in einem
    /// Job-Objekt ist. Scheitert der Start, bleibt der Task als Rueckfall.
    /// </summary>
    private bool StartUpdater()
    {
        try
        {
            using Process? process = Process.Start(new ProcessStartInfo(paths.UpdaterExe)
            {
                ArgumentList = { "--updater" },
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = paths.RootDirectory,
            });

            return process is not null;
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            logger.LogWarning("Der Updater liess sich nicht sofort starten: {Fehler}", ex.Message);
            return false;
        }
    }

    // --- Aufraeumen -------------------------------------------------------------

    /// <summary>
    /// Nach einer bestaetigten Umstellung: Es bleiben die laufende und die
    /// vorige Fassung — die vorige als Rueckweg, falls die naechste scheitert.
    /// Alles Aeltere geht, auch die EXE am alten Ort, sobald sie keine der beiden ist.
    /// </summary>
    private void CleanUpAfterSuccess(UpdateMarker marker)
    {
        TryDeleteFile(paths.BackupExe);

        if (!marker.IsVersioned)
        {
            return;
        }

        string current = Path.GetDirectoryName(paths.ProcessPath)!;
        string previous = Path.GetDirectoryName(marker.FromPath!)!;

        if (Directory.Exists(paths.VersionsDirectory))
        {
            foreach (string directory in Directory.GetDirectories(paths.VersionsDirectory))
            {
                if (!SamePath(directory, current) && !SamePath(directory, previous))
                {
                    TryDeleteDirectory(directory);
                }
            }
        }

        if (!SamePath(paths.LegacyServiceExe, marker.FromPath!) && !SamePath(paths.LegacyServiceExe, paths.ProcessPath))
        {
            TryDeleteFile(paths.LegacyServiceExe);
        }
    }

    /// <summary>Was fuer ein gescheitertes oder aufgegebenes Update bereitlag.</summary>
    private void DiscardTarget(UpdateMarker marker)
    {
        if (!marker.IsVersioned)
        {
            TryDeleteFile(paths.StagedExe);
            return;
        }

        string target = Path.GetDirectoryName(marker.TargetPath!)!;
        if (!SamePath(target, Path.GetDirectoryName(paths.ProcessPath)!))
        {
            TryDeleteDirectory(target);
        }
    }

    // --- Hilfen -----------------------------------------------------------------

    private static string? ReadFileVersion(string path)
    {
        try
        {
            return File.Exists(path) ? FileVersionInfo.GetVersionInfo(path).ProductVersion : null;
        }
        catch (FileNotFoundException)
        {
            return null;
        }
    }

    private static bool IsPlainVersion(string version) =>
        version.Length is > 0 and <= 32
        && version.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '-')
        && !version.Contains("..", StringComparison.Ordinal);

    private static bool SamePath(string a, string b) =>
        string.Equals(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(a)),
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(b)),
            StringComparison.OrdinalIgnoreCase);

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
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Beim naechsten Anlauf.
        }
    }

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path))
            {
                Directory.Delete(path, recursive: true);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Beim naechsten Aufraeumen.
        }
    }
}
