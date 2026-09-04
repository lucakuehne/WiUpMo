using System.Diagnostics;
using System.ServiceProcess;
using WiUpMo.Agent.Install;

namespace WiUpMo.Agent.Update;

/// <summary>
/// Der Updater-Lauf. Wird vom geplanten Task alle paar Minuten als
/// <c>wiupmo-updater.exe --updater</c> gestartet, laeuft als SYSTEM und
/// beendet sich sofort, wenn nichts zu tun ist.
///
/// Der ganze Vorgang haengt an einer Datei — dem Marker. Der Updater trifft
/// keine eigenen Entscheidungen darueber, *ob* aktualisiert wird; das hat der
/// Dienst schon geklaert, samt Pruefsumme. Hier wird nur getauscht und, wenn
/// der Dienst danach nicht von sich hoeren laesst, zurueckgetauscht.
///
/// Auf Netzwerkzugriff wird bewusst verzichtet: Der Updater soll auch dann
/// zuverlaessig arbeiten, wenn das Backend gerade nicht erreichbar ist. Die
/// Rueckmeldung uebernimmt der Dienst, sobald er wieder laeuft.
/// </summary>
public static class Updater
{
    /// <summary>
    /// Frist, innerhalb der sich der neue Dienst gemeldet haben muss. Sie ist
    /// bewusst laenger als die Startverzoegerung des Dienstes plus ein
    /// Check-in — sonst nimmt der Updater einen Tausch zurueck, der nur noch
    /// keine Gelegenheit zur Bestaetigung hatte.
    /// </summary>
    private static readonly TimeSpan VerificationWindow = TimeSpan.FromMinutes(10);

    private static readonly TimeSpan ServiceWait = TimeSpan.FromSeconds(60);

    public static int Run(AgentPaths paths)
    {
        UpdateMarker? marker = UpdateMarker.TryLoad(paths.MarkerPath);

        if (marker is null)
        {
            return 0;
        }

        switch (marker.State)
        {
            case UpdateState.PendingSwap:
                return Swap(paths, marker);

            case UpdateState.Verifying:
                return Verify(paths, marker);

            case UpdateState.Verified:
            case UpdateState.RolledBack:
                // Beide warten nur noch auf die Meldung durch den Dienst.
                // Insbesondere `Verified` heisst: Finger weg, der neue Stand
                // laeuft — unabhaengig davon, ob das Backend davon schon weiss.
                return 0;

            default:
                return 0;
        }
    }

    private static int Swap(AgentPaths paths, UpdateMarker marker)
    {
        if (!File.Exists(paths.StagedExe))
        {
            Console.Error.WriteLine("Die bereitgelegte Fassung fehlt. Marker wird verworfen.");
            UpdateMarker.TryDelete(paths.MarkerPath);
            return 1;
        }

        Console.WriteLine($"Tausche {marker.FromVersion} gegen {marker.TargetVersion}.");

        if (!StopService())
        {
            // Nicht tauschen, solange der Dienst laeuft: Die Datei ist gesperrt,
            // und ein halber Tausch waere schlimmer als kein Tausch. Der naechste
            // Task-Lauf versucht es erneut.
            Console.Error.WriteLine("Der Dienst liess sich nicht anhalten. Neuer Versuch beim naechsten Lauf.");
            return 1;
        }

        try
        {
            TryDelete(paths.BackupExe);
            File.Move(paths.ServiceExe, paths.BackupExe);
            File.Move(paths.StagedExe, paths.ServiceExe);
        }
        catch (IOException ex)
        {
            Console.Error.WriteLine($"Der Tausch ist gescheitert: {ex.Message}");

            // Zurueck auf den alten Stand, falls die erste Verschiebung schon
            // durch war und die zweite nicht.
            if (!File.Exists(paths.ServiceExe) && File.Exists(paths.BackupExe))
            {
                File.Move(paths.BackupExe, paths.ServiceExe);
            }

            marker.State = UpdateState.RolledBack;
            marker.Error = $"Tausch gescheitert: {ex.Message}";
            marker.Save(paths.MarkerPath);

            StartService();
            return 1;
        }

        marker.State = UpdateState.Verifying;
        marker.VerifyDeadline = DateTimeOffset.UtcNow + VerificationWindow;
        marker.Save(paths.MarkerPath);

        StartService();
        Console.WriteLine("Getauscht und gestartet. Warte auf die Bestaetigung des Dienstes.");
        return 0;
    }

    /// <summary>
    /// Der Dienst bestaetigt einen erfolgreichen Start, indem er den Marker
    /// selbst wegraeumt. Ist er nach Ablauf der Frist noch da, hat der neue
    /// Stand es nicht geschafft — dann zurueck auf den alten.
    /// </summary>
    private static int Verify(AgentPaths paths, UpdateMarker marker)
    {
        if (marker.VerifyDeadline is null || DateTimeOffset.UtcNow < marker.VerifyDeadline)
        {
            return 0;
        }

        Console.Error.WriteLine(
            $"Version {marker.TargetVersion} hat sich nicht innerhalb der Frist bestaetigt. Ruecktausch.");

        if (!File.Exists(paths.BackupExe))
        {
            // Ohne Sicherung gibt es keinen Rueckweg. Den Marker stehen zu
            // lassen wuerde bei jedem Lauf dieselbe Meldung erzeugen; das
            // Geraet braucht dann eine Neuinstallation von Hand.
            Console.Error.WriteLine("Es liegt keine Sicherung vor. Ruecktausch nicht moeglich.");
            marker.State = UpdateState.RolledBack;
            marker.Error = "Der Dienst bestaetigte sich nicht, und es lag keine Sicherung fuer den Ruecktausch vor.";
            marker.Save(paths.MarkerPath);
            return 1;
        }

        StopService();

        try
        {
            TryDelete(paths.ServiceExe);
            File.Move(paths.BackupExe, paths.ServiceExe);
        }
        catch (IOException ex)
        {
            Console.Error.WriteLine($"Der Ruecktausch ist gescheitert: {ex.Message}");
            StartService();
            return 1;
        }

        marker.State = UpdateState.RolledBack;
        marker.Error =
            $"Version {marker.TargetVersion} bestaetigte sich nicht innerhalb von " +
            $"{VerificationWindow.TotalMinutes:F0} Minuten. Zurueck auf {marker.FromVersion}.";
        marker.Save(paths.MarkerPath);

        StartService();
        Console.WriteLine($"Zurueck auf {marker.FromVersion}.");
        return 0;
    }

    private static bool StopService()
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
            return KillService();
        }
        catch (InvalidOperationException ex)
        {
            Console.Error.WriteLine($"Der Dienst ist nicht ansprechbar: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// Letztes Mittel, wenn der Dienst nicht auf das Stoppsignal reagiert —
    /// etwa weil er in einem haengenden WUApi-Aufruf feststeckt. Das ist genau
    /// der Fall, den es geben wird: Eine beschaedigte Update-Datenbank kann
    /// eine Suche praktisch unbegrenzt blockieren.
    /// </summary>
    private static bool KillService()
    {
        Console.Error.WriteLine("Der Dienst reagiert nicht auf das Stoppsignal, wird beendet.");

        bool killed = false;

        foreach (Process process in Process.GetProcessesByName("wiupmo-agent"))
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
                    Console.Error.WriteLine($"Prozess {process.Id} liess sich nicht beenden: {ex.Message}");
                }
            }
        }

        return killed;
    }

    private static void StartService()
    {
        try
        {
            using var controller = new ServiceController(ServiceInstaller.ServiceName);
            if (controller.Status != ServiceControllerStatus.Running)
            {
                controller.Start();
                controller.WaitForStatus(ServiceControllerStatus.Running, ServiceWait);
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ServiceProcess.TimeoutException)
        {
            // Der Dienst hat Wiederherstellungsoptionen: Windows startet ihn
            // nach einer Minute selbst erneut. Hier abzubrechen wuerde nur die
            // Rueckmeldung verhindern.
            Console.Error.WriteLine($"Der Dienst liess sich nicht starten: {ex.Message}");
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (IOException)
        {
            // Der folgende File.Move scheitert dann mit klarer Meldung.
        }
    }
}
