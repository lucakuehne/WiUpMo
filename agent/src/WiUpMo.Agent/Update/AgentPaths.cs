namespace WiUpMo.Agent.Update;

/// <summary>
/// Die Dateien, zwischen denen das Selbst-Update hin- und herschiebt.
///
/// Der Updater liegt als eigene Kopie neben dem Dienst und ist selbst **nie**
/// Update-Ziel. Der Grund ist handfest: Windows sperrt die Datei eines
/// laufenden Prozesses. Wuerde der Updater dieselbe EXE benutzen, muesste er
/// sich beim Tausch selbst ersetzen — das geht nicht.
///
/// Daraus folgt zugleich, dass der Updater nie eine neuere Fassung bekommt.
/// Seine Logik muss also von Anfang an stimmen und darf nichts brauchen, was
/// sich spaeter aendert; deshalb ist sie auf Dateioperationen und
/// <c>sc.exe</c>-Aufrufe beschraenkt und faellt bei jedem Zweifel auf den
/// vorherigen Stand zurueck.
/// </summary>
public sealed class AgentPaths
{
    public AgentPaths(string dataDirectory)
    {
        InstallDirectory = Path.GetDirectoryName(Environment.ProcessPath)
            ?? throw new InvalidOperationException("Das eigene Programmverzeichnis ist nicht ermittelbar.");

        DataDirectory = dataDirectory;
    }

    /// <summary>
    /// Der Name, unter dem der Dienst installiert wird — unabhaengig davon, wie
    /// die aufgerufene Datei heisst.
    ///
    /// Das ist keine Kosmetik: Selbst-Update und Updater arbeiten mit festen
    /// Dateinamen. Kopierte <c>--install</c> die Quelle unter ihrem eigenen
    /// Namen — etwa <c>wiupmo-agent-0.5.0.exe</c>, wie die Datei aus dem
    /// Download heisst —, liefe der Dienst zwar, aber der Tausch griffe ins
    /// Leere, und der Notfall-Abbruch faende den Prozess nicht mehr. Beides
    /// faellt erst beim ersten Selbst-Update auf, also spaet.
    /// </summary>
    public const string ServiceFileName = "wiupmo-agent.exe";

    /// <summary>Der Prozessname ohne Endung, fuer <c>Process.GetProcessesByName</c>.</summary>
    public const string ServiceProcessName = "wiupmo-agent";

    public const string UpdaterFileName = "wiupmo-updater.exe";

    public string InstallDirectory { get; }

    public string DataDirectory { get; }

    /// <summary>Das Dienst-Binary — das einzige, was getauscht wird.</summary>
    public string ServiceExe => Path.Combine(InstallDirectory, ServiceFileName);

    /// <summary>Die heruntergeladene, gepruefte neue Fassung.</summary>
    public string StagedExe => Path.Combine(InstallDirectory, "wiupmo-agent.new.exe");

    /// <summary>Der vorherige Stand, fuer den Rueckweg.</summary>
    public string BackupExe => Path.Combine(InstallDirectory, "wiupmo-agent.bak.exe");

    /// <summary>Die Kopie, die der Updater-Task ausfuehrt.</summary>
    public string UpdaterExe => Path.Combine(InstallDirectory, UpdaterFileName);

    public string MarkerPath => Path.Combine(DataDirectory, "update.json");
}
