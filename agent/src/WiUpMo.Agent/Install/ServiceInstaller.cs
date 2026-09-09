using System.Diagnostics;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using WiUpMo.Agent.Update;

namespace WiUpMo.Agent.Install;

/// <summary>
/// Richtet den Agent als Windows-Dienst ein — ein einzelner Aufruf, unabhaengig
/// von jeder Verteilungsloesung. Damit laesst er sich per GPO-Startskript, von
/// Hand oder aus einem beliebigen Werkzeug heraus ausbringen.
/// </summary>
public static class ServiceInstaller
{
    public const string ServiceName = "WiUpMoAgent";
    public const string EventSourceName = "WiUpMo Agent";
    public const string UpdaterTaskName = "WiUpMo Agent Updater";

    private const string DisplayName = "WiUpMo Windows-Update-Monitoring";
    private const string Description =
        "Liest den lokalen Windows-Update-Status und meldet ihn an das WiUpMo-Backend.";

    private static string InstallDirectory =>
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "WiUpMo");

    public static int Install(AgentOptions options)
    {
        if (!IsElevated())
        {
            Console.Error.WriteLine(
                "--install muss mit erhoehten Rechten laufen (Dienstregistrierung und ProgramFiles).");
            return 2;
        }

        if (string.IsNullOrWhiteSpace(options.BackendUrl))
        {
            Console.Error.WriteLine("--install braucht --backend-url.");
            return 2;
        }

        string source = Environment.ProcessPath
            ?? throw new InvalidOperationException("Der eigene Programmpfad ist nicht ermittelbar.");

        // Fester Zielname, nicht der der Quelldatei: Die heruntergeladene Datei
        // heisst `wiupmo-agent-0.5.0.exe`, Selbst-Update und Updater arbeiten
        // aber mit festen Namen. Uebernaehme man den Namen der Quelle, liefe der
        // Dienst zwar, koennte sich aber nie selbst aktualisieren.
        string target = Path.Combine(InstallDirectory, AgentPaths.ServiceFileName);

        bool exists = ServiceExists();
        if (exists)
        {
            // Ein laufender Dienst haelt seine eigene EXE offen; sie liesse sich
            // sonst nicht ersetzen.
            Console.WriteLine("Dienst ist bereits vorhanden, wird fuer die Aktualisierung angehalten.");
            RunSc("stop", ServiceName);
            WaitForStopped(TimeSpan.FromSeconds(30));
        }

        Directory.CreateDirectory(InstallDirectory);
        if (!string.Equals(source, target, StringComparison.OrdinalIgnoreCase))
        {
            File.Copy(source, target, overwrite: true);
        }

        WriteConfiguration(target, options);
        PrepareDataDirectory(options.DataDirectory);
        EnsureEventSource();
        InstallUpdater(target);

        if (!exists)
        {
            // "start= delayed-auto": der Dienst startet nach dem Hochlauf des
            // Systems, nicht mittendrin — sonst konkurriert die Update-Suche mit
            // dem Anmeldevorgang um Platte und Netz.
            RunSc(
                "create", ServiceName,
                "binPath=", $"\"{target}\" --service",
                "start=", "delayed-auto",
                "obj=", "LocalSystem",
                "DisplayName=", DisplayName);

            RunSc("description", ServiceName, Description);

            // Neustart nach 1 min, 2 min, danach alle 10 min; Zaehler nach einem
            // Tag zuruecksetzen. Ein abgestuerzter Agent soll sich selbst
            // wieder einfangen, ohne dass jemand eingreift.
            RunSc(
                "failure", ServiceName,
                "reset=", "86400",
                "actions=", "restart/60000/restart/120000/restart/600000");
        }

        int startResult = RunSc("start", ServiceName);

        Console.WriteLine($"Dienst '{ServiceName}' eingerichtet.");
        Console.WriteLine($"  Programm:      {target}");
        Console.WriteLine($"  Daten:         {options.DataDirectory}");
        Console.WriteLine($"  Protokolle:    {Path.Combine(options.DataDirectory, "logs")}");

        if (startResult != 0)
        {
            // Nicht als Erfolg ausgeben: ein registrierter, aber nicht
            // gestarteter Dienst meldet nie etwas, und das faellt sonst erst
            // auf, wenn das Geraet im Bericht "seit Tagen kein Check-in" steht.
            Console.Error.WriteLine();
            Console.Error.WriteLine($"Der Dienst liess sich nicht starten (sc.exe-Code {startResult}).");
            PrintRecentLog(options.DataDirectory);
            return 1;
        }

        Console.WriteLine("Dienst gestartet.");
        return 0;
    }

    /// <summary>
    /// Entfernt Task, Dienst und Programmverzeichnis. Mit <paramref name="purge"/>
    /// zusaetzlich das Datenverzeichnis samt Identitaet und Protokollen.
    ///
    /// Die Trennung ist Absicht: Nach einer gewoehnlichen Deinstallation soll
    /// eine erneute Installation dasselbe Geraet bleiben — die Identitaet liegt
    /// im Datenverzeichnis. Wer wirklich alles los sein will, sagt es
    /// ausdruecklich.
    /// </summary>
    public static int Uninstall(AgentOptions options, bool purge)
    {
        if (!IsElevated())
        {
            Console.Error.WriteLine("--uninstall muss mit erhoehten Rechten laufen.");
            return 2;
        }

        // Zuerst der Task: Liefe er noch, koennte er einen Dienst starten, den
        // wir gerade entfernen.
        Run("schtasks.exe", "/Delete", "/TN", UpdaterTaskName, "/F");

        if (ServiceExists())
        {
            RunSc("stop", ServiceName);
            WaitForStopped(TimeSpan.FromSeconds(30));
            RunSc("delete", ServiceName);
            Console.WriteLine($"Dienst '{ServiceName}' entfernt.");
        }
        else
        {
            Console.WriteLine($"Dienst '{ServiceName}' war nicht vorhanden.");
        }

        RemoveEventSource();
        RemoveInstallDirectory();

        if (purge)
        {
            RemoveDirectory(options.DataDirectory, "Datenverzeichnis");
        }
        else
        {
            Console.WriteLine(
                $"Das Datenverzeichnis {options.DataDirectory} bleibt bestehen " +
                "(Geraeteidentitaet und Protokolle). Mit --purge wird es mitentfernt.");
        }

        return 0;
    }

    /// <summary>
    /// Raeumt das Programmverzeichnis.
    ///
    /// Die gerade laufende Datei bleibt zwangslaeufig liegen — Windows haelt sie
    /// offen. Das ist der Normalfall, weil man die Deinstallation ueblicherweise
    /// mit der installierten EXE aufruft; die Meldung sagt dann, was noch zu tun
    /// ist, statt einen Fehler zu werfen.
    /// </summary>
    private static void RemoveInstallDirectory()
    {
        string? laufende = Environment.ProcessPath;

        if (!Directory.Exists(InstallDirectory))
        {
            return;
        }

        bool rest = false;

        foreach (string datei in Directory.GetFiles(InstallDirectory))
        {
            if (string.Equals(datei, laufende, StringComparison.OrdinalIgnoreCase))
            {
                rest = true;
                continue;
            }

            try
            {
                File.Delete(datei);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Console.Error.WriteLine($"  {datei} liess sich nicht entfernen: {ex.Message}");
                rest = true;
            }
        }

        if (rest)
        {
            Console.WriteLine(
                $"Das Programmverzeichnis {InstallDirectory} enthaelt noch die gerade laufende " +
                "Datei. Sie laesst sich nach dem Beenden loeschen:");
            Console.WriteLine($"  Remove-Item -Recurse -Force '{InstallDirectory}'");
            return;
        }

        RemoveDirectory(InstallDirectory, "Programmverzeichnis");
    }

    private static void RemoveDirectory(string path, string was)
    {
        if (!Directory.Exists(path))
        {
            return;
        }

        try
        {
            Directory.Delete(path, recursive: true);
            Console.WriteLine($"{was} {path} entfernt.");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine($"{was} {path} liess sich nicht entfernen: {ex.Message}");
        }
    }

    /// <summary>
    /// Ohne das bleibt die Quelle in der Registrierung stehen. Sie stoert nicht,
    /// aber "komplett entfernt" heisst komplett.
    /// </summary>
    private static void RemoveEventSource()
    {
        try
        {
            if (EventLog.SourceExists(EventSourceName))
            {
                EventLog.DeleteEventSource(EventSourceName);
            }
        }
        catch (Exception ex) when (ex is System.Security.SecurityException
                                      or InvalidOperationException
                                      or ArgumentException)
        {
            Console.Error.WriteLine($"Die Ereignisquelle blieb bestehen: {ex.Message}");
        }
    }

    /// <summary>
    /// Schreibt die Betriebsparameter neben die EXE. ProgramFiles ist fuer
    /// normale Benutzer nur lesbar — das Enrollment-Token liegt damit nicht
    /// offen, und zum Aendern braucht es ohnehin erhoehte Rechte.
    /// </summary>
    private static void WriteConfiguration(string exePath, AgentOptions options)
    {
        string path = Path.Combine(Path.GetDirectoryName(exePath)!, "appsettings.json");

        JsonObject root = File.Exists(path)
            ? JsonNode.Parse(File.ReadAllText(path)) as JsonObject ?? []
            : [];

        if (root["Agent"] is not JsonObject agent)
        {
            agent = [];
            root["Agent"] = agent;
        }

        agent["BackendUrl"] = options.BackendUrl;
        if (!string.IsNullOrWhiteSpace(options.EnrollmentToken))
        {
            agent["EnrollmentToken"] = options.EnrollmentToken;
        }

        File.WriteAllText(
            path,
            root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }),
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
    }

    /// <summary>
    /// Legt das Datenverzeichnis an. Die Rechte bleiben die von
    /// <c>%ProgramData%</c> geerbten.
    ///
    /// Hier stand eine Einschraenkung auf SYSTEM und Administratoren per
    /// <c>icacls /inheritance:r</c>. Sie ist bewusst wieder heraus:
    ///
    /// Der Gewinn war gering — DPAPI laeuft im Maschinenkontext, jeder Prozess
    /// auf diesem Rechner kann die Identitaet ohnehin entschluesseln; die
    /// Dateirechte haetten nur den bequemen Zugriff erschwert. Der Schaden war
    /// dagegen konkret: Ein mit <c>/C</c> stillschweigend uebergangener Fehler
    /// hinterliess Dateien, an die weder Dienst noch Administrator herankamen,
    /// und machte damit jede Fehlersuche am Protokoll unmoeglich — ausgerechnet
    /// dann, wenn sie gebraucht wurde.
    ///
    /// Die Haertung gehoert in Phase 7, dort aber mit Auswertung des
    /// Rueckgabewerts und einer anschliessenden Probe, dass SYSTEM tatsaechlich
    /// noch schreiben kann. Der eigentliche Notausgang bei einem
    /// kompromittierten Geraet bleibt das Sperren im Frontend.
    /// </summary>
    private static void PrepareDataDirectory(string path)
    {
        Directory.CreateDirectory(path);
        Directory.CreateDirectory(Path.Combine(path, "logs"));
    }

    /// <summary>
    /// Legt die Updater-Kopie an und meldet den geplanten Task an.
    ///
    /// Die Kopie ist der Kern des Verfahrens: Windows sperrt die Datei eines
    /// laufenden Prozesses, ein Updater in derselben EXE koennte sich beim
    /// Tausch nicht selbst ersetzen. Die Kopie wird daher nie aktualisiert —
    /// sie bleibt auf dem Stand der Installation und ist damit auch nie das
    /// Ziel eines Selbst-Updates.
    ///
    /// Der Task laeuft als SYSTEM, weil er den Dienst anhalten und Dateien in
    /// ProgramFiles verschieben muss. Alle 5 Minuten: Er beendet sich sofort,
    /// wenn kein Marker vorliegt, kostet also praktisch nichts.
    /// </summary>
    private static void InstallUpdater(string serviceExe)
    {
        string updater = Path.Combine(Path.GetDirectoryName(serviceExe)!, AgentPaths.UpdaterFileName);
        File.Copy(serviceExe, updater, overwrite: true);

        int result = Run(
            "schtasks.exe",
            "/Create",
            "/TN", UpdaterTaskName,
            "/TR", $"\"{updater}\" --updater",
            "/SC", "MINUTE",
            "/MO", "5",
            "/RU", "SYSTEM",
            "/RL", "HIGHEST",
            "/F");

        if (result != 0)
        {
            Console.Error.WriteLine(
                "Der Updater-Task liess sich nicht anlegen. Der Agent laeuft, kann sich aber nicht " +
                "selbst aktualisieren — Updates muessen dann per --install verteilt werden.");
        }
    }

    /// <summary>
    /// Die Ereignisquelle muss einmalig mit erhoehten Rechten angelegt werden.
    /// Geschieht das nicht hier, schlaegt spaeter jeder Schreibversuch des
    /// Dienstes fehl.
    /// </summary>
    private static void EnsureEventSource()
    {
        try
        {
            if (!EventLog.SourceExists(EventSourceName))
            {
                EventLog.CreateEventSource(EventSourceName, "Application");
            }
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or InvalidOperationException)
        {
            Console.Error.WriteLine(
                $"Ereignisquelle konnte nicht angelegt werden: {ex.Message}. " +
                "Der Agent protokolliert dann nur in die Datei.");
        }
    }

    /// <summary>
    /// Gibt die letzten Protokollzeilen direkt aus.
    ///
    /// Die Einrichtung laeuft erhoeht, das Datenverzeichnis ist danach aber auf
    /// SYSTEM und Administratoren beschraenkt — ein blosser Verweis auf den
    /// Pfad hilft demjenigen wenig, dessen Konsole dort nicht hineinsieht.
    /// </summary>
    private static void PrintRecentLog(string dataDirectory)
    {
        string logDirectory = Path.Combine(dataDirectory, "logs");

        try
        {
            FileInfo? latest = new DirectoryInfo(logDirectory)
                .GetFiles("agent-*.log")
                .OrderByDescending(f => f.LastWriteTimeUtc)
                .FirstOrDefault();

            if (latest is null)
            {
                Console.Error.WriteLine(
                    $"Unter {logDirectory} liegt kein Protokoll — der Prozess kam nicht bis zur " +
                    "Protokollierung. Das Systemprotokoll (Quelle 'Service Control Manager') hilft weiter.");
                return;
            }

            // FileShare.ReadWrite, weil Serilog die Datei offen haelt.
            using var stream = new FileStream(
                latest.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var reader = new StreamReader(stream);

            string[] lines = reader.ReadToEnd()
                .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

            Console.Error.WriteLine();
            Console.Error.WriteLine($"Letzte Zeilen aus {latest.Name}:");
            foreach (string line in lines.TakeLast(25))
            {
                Console.Error.WriteLine("  " + line);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine($"Protokoll unter {logDirectory} nicht lesbar: {ex.Message}");
        }
    }

    private static bool ServiceExists() =>
        ServiceController.GetServices().Any(s =>
            string.Equals(s.ServiceName, ServiceName, StringComparison.OrdinalIgnoreCase));

    private static void WaitForStopped(TimeSpan timeout)
    {
        try
        {
            using var controller = new ServiceController(ServiceName);
            controller.WaitForStatus(ServiceControllerStatus.Stopped, timeout);
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ServiceProcess.TimeoutException)
        {
            // Nicht vorhanden oder nicht rechtzeitig gestoppt — der folgende
            // Kopiervorgang scheitert dann mit einer klaren Meldung.
        }
    }

    private static bool IsElevated()
    {
        using WindowsIdentity identity = WindowsIdentity.GetCurrent();
        return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
    }

    private static int RunSc(params string[] arguments) => Run("sc.exe", arguments);

    /// <summary>
    /// <c>sc.exe</c> erwartet seine Optionen als <c>key=</c> und Wert in zwei
    /// getrennten Argumenten — deshalb die Uebergabe ueber
    /// <see cref="ProcessStartInfo.ArgumentList"/> statt als Zeichenkette.
    /// </summary>
    private static int Run(string fileName, params string[] arguments)
    {
        var startInfo = new ProcessStartInfo(fileName)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        foreach (string argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using Process process = Process.Start(startInfo)
            ?? throw new InvalidOperationException($"{fileName} liess sich nicht starten.");

        string output = process.StandardOutput.ReadToEnd();
        string error = process.StandardError.ReadToEnd();
        process.WaitForExit();

        if (process.ExitCode != 0)
        {
            string detail = string.IsNullOrWhiteSpace(error) ? output : error;
            Console.Error.WriteLine(
                $"{fileName} {string.Join(' ', arguments)} endete mit {process.ExitCode}: {detail.Trim()}");
        }

        return process.ExitCode;
    }
}
