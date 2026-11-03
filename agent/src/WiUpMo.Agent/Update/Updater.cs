using System.Diagnostics;
using System.Globalization;
using System.ServiceProcess;
using WiUpMo.Agent.Install;

namespace WiUpMo.Agent.Update;

/// <summary>
/// Der Updater-Lauf. Gestartet als <c>wiupmo-updater.exe --updater</c> — vom
/// Dienst gleich nach dem Bereitlegen und vom geplanten Task alle 5 Minuten als
/// Rueckfall und Waechter. Laeuft als SYSTEM und beendet sich sofort, wenn
/// nichts zu tun ist.
///
/// Der ganze Vorgang haengt an einer Datei — dem Marker. Der Updater trifft
/// keine eigenen Entscheidungen darueber, *ob* aktualisiert wird; das hat der
/// Dienst schon geklaert, samt Pruefsumme. Hier wird nur umgestellt und, wenn
/// der Dienst danach nicht von sich hoeren laesst, zurueckgestellt.
///
/// Drei Regeln, die aus Fehlern im Feld kommen:
/// <list type="bullet">
///   <item>Der Dienst wird nie angehalten zurueckgelassen. Ein Fehler zwischen
///   Anhalten und Starten liess ein Geraet frueher verstummen, bis jemand von
///   Hand eingriff.</item>
///   <item>Kurze Sperren werden ausgesessen: Nach dem Anhalten haelt der
///   beendete Prozess die Datei oft noch einen Moment, und der Virenscanner
///   liest die neue gerade. Ein einziger Fehlversuch wurde sonst zum
///   Ruecktausch.</item>
///   <item>Alles landet in einem eigenen Protokoll. Die Aufgabenplanung
///   zeichnet die Konsole nicht auf; ein gescheiterter Tausch hinterliess
///   frueher keine Spur.</item>
/// </list>
///
/// Netzwerkzugriff gibt es keinen: Der Updater soll auch arbeiten, wenn das
/// Backend nicht erreichbar ist. Die Rueckmeldung uebernimmt der Dienst.
/// </summary>
public static class Updater
{
    /// <summary>
    /// Nur ein Updater zur Zeit. Dienst und Task starten ihn unabhaengig
    /// voneinander; zwei Laeufe auf demselben Marker stellten sich gegenseitig
    /// den Dienst um. Auch das Nachziehen der Updater-Kopie nimmt ihn.
    /// </summary>
    public const string MutexName = @"Global\WiUpMoAgentUpdater";

    private static readonly TimeSpan ServiceWait = TimeSpan.FromSeconds(60);

    private static TimeSpan VerificationWindow = TimeSpan.FromMinutes(20);

    /// <summary>
    /// Anlaeufe, bevor ein Schritt aufgegeben wird. Der Task laeuft alle 5
    /// Minuten; sechs Anlaeufe sind eine halbe Stunde.
    /// </summary>
    private const int MaxAttempts = 6;

    /// <param name="verificationWindow">
    /// Frist, innerhalb der sich der neue Dienst bestaetigt haben muss
    /// (<see cref="AgentOptions.UpdateVerificationMinutes"/>). Er tut es nach
    /// seinem ersten vollstaendigen Durchlauf; der kann mit einer langsamen
    /// Update-Suche einige Minuten dauern.
    /// </param>
    public static int Run(AgentPaths paths, TimeSpan verificationWindow)
    {
        VerificationWindow = verificationWindow;

        using var log = new UpdaterLog(paths.LogDirectory);
        using var mutex = new Mutex(initiallyOwned: false, MutexName);

        if (!TryAcquire(mutex))
        {
            // Ein anderer Lauf ist dabei. Der naechste Task-Lauf schaut wieder.
            return 0;
        }

        try
        {
            UpdateMarker? marker = UpdateMarker.TryLoad(paths.MarkerPath);

            return marker?.State switch
            {
                UpdateState.PendingSwap => Swap(paths, marker, log),
                UpdateState.Verifying => Verify(paths, marker, log),

                // Verified und RolledBack warten nur noch auf die Meldung durch
                // den Dienst. Verified heisst: Finger weg, der neue Stand laeuft
                // — unabhaengig davon, ob das Backend davon schon weiss.
                _ => 0,
            };
        }
        catch (Exception ex)
        {
            // Darf nicht vorkommen — und wenn doch, nicht mit angehaltenem Dienst.
            log.Error($"Unerwarteter Fehler: {ex}");
            EnsureServiceRunning(log);
            return 1;
        }
        finally
        {
            mutex.ReleaseMutex();
        }
    }

    /// <summary>
    /// Fuehrt <paramref name="work"/> aus, waehrend kein Updater laeuft. Fuer den
    /// Dienst, wenn er die Updater-Kopie ersetzt. Liefert <c>false</c>, wenn
    /// gerade einer laeuft.
    /// </summary>
    public static bool RunExclusive(Action work)
    {
        using var mutex = new Mutex(initiallyOwned: false, MutexName);
        if (!TryAcquire(mutex))
        {
            return false;
        }

        try
        {
            work();
            return true;
        }
        finally
        {
            mutex.ReleaseMutex();
        }
    }

    private static bool TryAcquire(Mutex mutex)
    {
        try
        {
            return mutex.WaitOne(TimeSpan.Zero);
        }
        catch (AbandonedMutexException)
        {
            // Der vorige Halter ist abgestuerzt. Der Mutex gehoert jetzt uns.
            return true;
        }
    }

    // --- Umstellen --------------------------------------------------------------

    private static int Swap(AgentPaths paths, UpdateMarker marker, UpdaterLog log)
    {
        if (!BeginAttempt(paths, marker, log))
        {
            return 1;
        }

        log.Info($"Umstellung von {marker.FromVersion} auf {marker.TargetVersion}, Anlauf {marker.Attempts}.");

        if (!StopService(log))
        {
            // Nicht umstellen, solange der Dienst laeuft. Der Anlauf zaehlt, der
            // naechste Task-Lauf versucht es erneut.
            RecordAttemptError(paths, marker, "Der Dienst liess sich nicht anhalten.", log);
            EnsureServiceRunning(log);
            return 1;
        }

        try
        {
            return marker.IsVersioned
                ? SwitchVersion(paths, marker, log)
                : LegacySwap(paths, marker, log);
        }
        finally
        {
            // Was auch immer oben geschah: Der Dienst laeuft danach — in der
            // neuen Fassung, oder in der alten.
            EnsureServiceRunning(log);
        }
    }

    /// <summary>Neuer Weg: Der Dienst zeigt kuenftig auf die EXE im Versionsverzeichnis.</summary>
    private static int SwitchVersion(AgentPaths paths, UpdateMarker marker, UpdaterLog log)
    {
        if (!File.Exists(marker.TargetPath))
        {
            return RollBack(paths, marker, "Die bereitgelegte Fassung fehlt.", log);
        }

        // Vor dem Start festhalten: Der neue Dienst prueft beim ersten Durchlauf
        // genau diesen Zustand.
        marker.State = UpdateState.Verifying;
        marker.VerifyDeadline = DateTimeOffset.UtcNow + VerificationWindow;
        marker.Save(paths.MarkerPath);

        if (!SetBinPath(marker.TargetPath!, log) || !StartService(log))
        {
            StopService(log);
            SetBinPath(marker.FromPath!, log);
            return RollBack(paths, marker, $"Version {marker.TargetVersion} liess sich nicht starten.", log);
        }

        log.Info($"Umgestellt auf {marker.TargetPath} und gestartet. Warte auf die Bestaetigung.");
        return 0;
    }

    /// <summary>Alter Weg (Marker eines Dienstes vor 0.8.0): Dateien tauschen.</summary>
    private static int LegacySwap(AgentPaths paths, UpdateMarker marker, UpdaterLog log)
    {
        if (!File.Exists(paths.StagedExe))
        {
            return RollBack(paths, marker, "Die bereitgelegte Fassung fehlt.", log);
        }

        try
        {
            Retry(() => DeleteIfExists(paths.BackupExe));
            Retry(() => File.Move(paths.LegacyServiceExe, paths.BackupExe));
            Retry(() => File.Move(paths.StagedExe, paths.LegacyServiceExe));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Zurueck auf den alten Stand, falls die erste Verschiebung schon
            // durch war und die zweite nicht.
            if (!File.Exists(paths.LegacyServiceExe) && File.Exists(paths.BackupExe))
            {
                TryRetry(() => File.Move(paths.BackupExe, paths.LegacyServiceExe), log);
            }

            return RollBack(paths, marker, $"Tausch gescheitert: {ex.Message}", log);
        }

        marker.State = UpdateState.Verifying;
        marker.VerifyDeadline = DateTimeOffset.UtcNow + VerificationWindow;
        marker.Save(paths.MarkerPath);

        if (!StartService(log))
        {
            // Die neue EXE startet nicht: sofort zurueck, nicht erst nach der Frist.
            StopService(log);
            TryRetry(() => File.Copy(paths.BackupExe, paths.LegacyServiceExe, overwrite: true), log);
            return RollBack(paths, marker, $"Version {marker.TargetVersion} liess sich nicht starten.", log);
        }

        log.Info("Getauscht und gestartet. Warte auf die Bestaetigung.");
        return 0;
    }

    // --- Zuruecknehmen ----------------------------------------------------------

    /// <summary>
    /// Bestaetigt sich der neue Dienst nicht bis zur Frist, hat er es nicht
    /// geschafft — dann zurueck auf den alten Stand.
    /// </summary>
    private static int Verify(AgentPaths paths, UpdateMarker marker, UpdaterLog log)
    {
        if (marker.VerifyDeadline is null || DateTimeOffset.UtcNow < marker.VerifyDeadline)
        {
            return 0;
        }

        log.Warn($"Version {marker.TargetVersion} hat sich nicht innerhalb der Frist bestaetigt. Zuruecknehmen.");

        if (!BeginAttempt(paths, marker, log))
        {
            return 1;
        }

        string reason =
            $"Version {marker.TargetVersion} bestaetigte sich nicht innerhalb von " +
            $"{VerificationWindow.TotalMinutes:F0} Minuten. Zurueck auf {marker.FromVersion}.";

        StopService(log);

        try
        {
            if (marker.IsVersioned)
            {
                if (!SetBinPath(marker.FromPath!, log))
                {
                    RecordAttemptError(paths, marker, "Der Dienst liess sich nicht zurueckstellen.", log);
                    return 1;
                }
            }
            else
            {
                if (!File.Exists(paths.BackupExe))
                {
                    // Ohne Sicherung gibt es keinen Rueckweg; das Geraet braucht
                    // dann eine Neuinstallation von Hand.
                    return RollBack(
                        paths, marker,
                        "Der Dienst bestaetigte sich nicht, und es lag keine Sicherung fuer den Ruecktausch vor.",
                        log);
                }

                Retry(() => DeleteIfExists(paths.LegacyServiceExe));
                Retry(() => File.Move(paths.BackupExe, paths.LegacyServiceExe));
            }

            return RollBack(paths, marker, reason, log);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            RecordAttemptError(paths, marker, $"Der Ruecktausch ist gescheitert: {ex.Message}", log);
            return 1;
        }
        finally
        {
            EnsureServiceRunning(log);
        }
    }

    private static int RollBack(AgentPaths paths, UpdateMarker marker, string reason, UpdaterLog log)
    {
        marker.State = UpdateState.RolledBack;
        marker.Error = reason;
        marker.Save(paths.MarkerPath);
        log.Error($"Zurueckgenommen: {reason}");
        return 1;
    }

    /// <summary>
    /// Zaehlt einen Anlauf. Nach <see cref="MaxAttempts"/> wird aufgegeben — mit
    /// dem letzten Fehler als Grund, damit er im Backend ankommt.
    /// </summary>
    private static bool BeginAttempt(AgentPaths paths, UpdateMarker marker, UpdaterLog log)
    {
        if (marker.Attempts >= MaxAttempts)
        {
            RollBack(
                paths, marker,
                $"Nach {MaxAttempts} Anlaeufen aufgegeben: {marker.LastAttemptError ?? "ohne Angabe"}",
                log);
            EnsureServiceRunning(log);
            return false;
        }

        marker.Attempts++;
        marker.LastAttemptAt = DateTimeOffset.UtcNow;
        marker.Save(paths.MarkerPath);
        return true;
    }

    private static void RecordAttemptError(AgentPaths paths, UpdateMarker marker, string error, UpdaterLog log)
    {
        marker.LastAttemptError = error;
        marker.Save(paths.MarkerPath);
        log.Warn(error);
    }

    // --- Dienst -----------------------------------------------------------------

    private static bool SetBinPath(string exe, UpdaterLog log)
    {
        var startInfo = new ProcessStartInfo("sc.exe")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        // sc.exe erwartet "binPath=" und den Wert als getrennte Argumente.
        foreach (string argument in new[] { "config", ServiceInstaller.ServiceName, "binPath=", $"\"{exe}\" --service" })
        {
            startInfo.ArgumentList.Add(argument);
        }

        using Process? process = Process.Start(startInfo);
        if (process is null)
        {
            log.Error("sc.exe liess sich nicht starten.");
            return false;
        }

        string output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
        process.WaitForExit(30_000);

        if (process.ExitCode != 0)
        {
            log.Error($"sc config binPath auf {exe} scheiterte ({process.ExitCode}): {output.Trim()}");
            return false;
        }

        log.Info($"Dienst zeigt jetzt auf {exe}.");
        return true;
    }

    private static bool StopService(UpdaterLog log)
    {
        try
        {
            using var controller = new ServiceController(ServiceInstaller.ServiceName);

            if (controller.Status == ServiceControllerStatus.Stopped)
            {
                return true;
            }

            if (controller.CanStop)
            {
                controller.Stop();
            }

            controller.WaitForStatus(ServiceControllerStatus.Stopped, ServiceWait);
            return true;
        }
        catch (System.ServiceProcess.TimeoutException)
        {
            return KillService(log);
        }
        catch (InvalidOperationException ex)
        {
            log.Error($"Der Dienst ist nicht ansprechbar: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// Letztes Mittel, wenn der Dienst nicht auf das Stoppsignal reagiert —
    /// etwa weil er in einem haengenden WUApi-Aufruf feststeckt.
    /// </summary>
    private static bool KillService(UpdaterLog log)
    {
        log.Warn("Der Dienst reagiert nicht auf das Stoppsignal, wird beendet.");

        bool killed = false;

        foreach (Process process in Process.GetProcessesByName(AgentPaths.ServiceProcessName))
        {
            using (process)
            {
                try
                {
                    process.Kill(entireProcessTree: true);
                    process.WaitForExit(10_000);
                    killed = true;
                }
                catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
                {
                    log.Error($"Prozess {process.Id} liess sich nicht beenden: {ex.Message}");
                }
            }
        }

        return killed;
    }

    private static bool StartService(UpdaterLog log)
    {
        try
        {
            using var controller = new ServiceController(ServiceInstaller.ServiceName);
            if (controller.Status != ServiceControllerStatus.Running)
            {
                if (controller.Status != ServiceControllerStatus.StartPending)
                {
                    controller.Start();
                }

                controller.WaitForStatus(ServiceControllerStatus.Running, ServiceWait);
            }

            return true;
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ServiceProcess.TimeoutException)
        {
            log.Error($"Der Dienst liess sich nicht starten: {ex.Message}");
            return false;
        }
    }

    /// <summary>Der Dienst soll laufen, egal wie dieser Lauf ausgeht.</summary>
    private static void EnsureServiceRunning(UpdaterLog log)
    {
        try
        {
            StartService(log);
        }
        catch (Exception ex)
        {
            // Bleibt auch das ohne Erfolg, startet Windows ihn ueber die
            // Wiederherstellungsoptionen spaetestens beim naechsten Systemstart.
            log.Error($"Der Dienst liess sich nicht wieder starten: {ex.Message}");
        }
    }

    // --- Dateien ----------------------------------------------------------------

    /// <summary>
    /// Wiederholt eine Dateioperation bis zu 30 Sekunden lang. Gesperrt ist die
    /// Datei meist nur kurz: vom gerade beendeten Prozess oder vom Virenscanner.
    /// </summary>
    private static void Retry(Action action)
    {
        for (int attempt = 1; ; attempt++)
        {
            try
            {
                action();
                return;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException && attempt < 10)
            {
                Thread.Sleep(TimeSpan.FromSeconds(3));
            }
        }
    }

    private static void TryRetry(Action action, UpdaterLog log)
    {
        try
        {
            Retry(action);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log.Error(ex.Message);
        }
    }

    private static void DeleteIfExists(string path)
    {
        if (File.Exists(path))
        {
            File.Delete(path);
        }
    }
}

/// <summary>
/// Das Protokoll des Updaters: <c>logs\updater-JJJJMMTT.log</c> neben dem des
/// Dienstes, eine Zeile je Ereignis. Der Dienst liest daraus Warnungen und
/// Fehler und schickt sie mit der Selbstauskunft ans Backend.
///
/// Bewusst ohne Serilog: Der Updater soll nichts brauchen, was sich spaeter
/// aendern koennte.
/// </summary>
public sealed class UpdaterLog : IDisposable
{
    public const string FilePrefix = "updater-";

    private const int RetentionDays = 14;

    private readonly string _directory;
    private StreamWriter? _writer;
    private bool _unavailable;

    /// <summary>
    /// Die Datei entsteht erst beim ersten Eintrag: Der Task laeuft alle 5
    /// Minuten und hat meist nichts zu tun — dafuer braucht es keine Datei.
    /// </summary>
    public UpdaterLog(string directory) => _directory = directory;

    public void Info(string message) => Write("INF", message);

    public void Warn(string message) => Write("WRN", message);

    public void Error(string message) => Write("ERR", message);

    private void Write(string level, string message)
    {
        string line = $"{DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture)} [{level}] {message}";
        Console.WriteLine(line);

        try
        {
            Open()?.WriteLine(line);
        }
        catch (IOException)
        {
            // Ohne Datei weiter: Der Tausch ist wichtiger als sein Protokoll.
        }
    }

    private StreamWriter? Open()
    {
        if (_writer is not null || _unavailable)
        {
            return _writer;
        }

        try
        {
            Directory.CreateDirectory(_directory);
            Prune(_directory);

            string file = Path.Combine(
                _directory, $"{FilePrefix}{DateTime.UtcNow.ToString("yyyyMMdd", CultureInfo.InvariantCulture)}.log");
            _writer = new StreamWriter(new FileStream(file, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
            {
                AutoFlush = true,
            };
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _unavailable = true;
            Console.Error.WriteLine($"Updater-Protokoll nicht verfuegbar: {ex.Message}");
        }

        return _writer;
    }

    /// <summary>
    /// Warnungen und Fehler der letzten Tage, fuer die Selbstauskunft des
    /// Dienstes. Aelteste zuerst, hoechstens <paramref name="max"/>.
    /// </summary>
    public static IReadOnlyList<(DateTimeOffset At, string Level, string Message)> ReadProblems(
        string directory, TimeSpan window, int max)
    {
        var problems = new List<(DateTimeOffset, string, string)>();
        DateTime since = DateTime.UtcNow - window;

        try
        {
            foreach (string file in Directory.GetFiles(directory, $"{FilePrefix}*.log").Order())
            {
                if (File.GetLastWriteTimeUtc(file) < since)
                {
                    continue;
                }

                using var reader = new StreamReader(
                    new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite));

                while (reader.ReadLine() is { } line)
                {
                    // "2026-11-03T08:19:05.1234567+00:00 [ERR] Text"
                    int open = line.IndexOf(" [", StringComparison.Ordinal);
                    if (open < 0 || line.Length < open + 7
                        || !DateTimeOffset.TryParse(line[..open], CultureInfo.InvariantCulture, DateTimeStyles.None, out DateTimeOffset at)
                        || at.UtcDateTime < since)
                    {
                        continue;
                    }

                    string level = line.Substring(open + 2, 3);
                    if (level is "WRN" or "ERR")
                    {
                        problems.Add((at, level == "ERR" ? "error" : "warning", line[(open + 7)..].Trim()));
                    }
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Dann eben ohne. Die Selbstauskunft darf daran nicht scheitern.
        }

        return problems.Count > max ? problems[^max..] : problems;
    }

    private static void Prune(string directory)
    {
        foreach (string file in Directory.GetFiles(directory, $"{FilePrefix}*.log"))
        {
            try
            {
                if (File.GetLastWriteTimeUtc(file) < DateTime.UtcNow.AddDays(-RetentionDays))
                {
                    File.Delete(file);
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Beim naechsten Lauf. Am Protokoll selbst darf es nicht scheitern.
            }
        }
    }

    public void Dispose() => _writer?.Dispose();
}
