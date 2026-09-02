using System.Diagnostics;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

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
        string target = Path.Combine(InstallDirectory, Path.GetFileName(source));

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

    public static int Uninstall(AgentOptions options)
    {
        if (!IsElevated())
        {
            Console.Error.WriteLine("--uninstall muss mit erhoehten Rechten laufen.");
            return 2;
        }

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

        // Programmverzeichnis raeumen, Datenverzeichnis nicht: dort liegen
        // Identitaet und Protokolle. Wer sie loeschen will, tut das bewusst.
        Console.WriteLine(
            $"Das Datenverzeichnis {options.DataDirectory} bleibt bestehen " +
            "(Geraeteidentitaet und Protokolle).");
        return 0;
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
