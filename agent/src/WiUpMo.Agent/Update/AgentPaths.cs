namespace WiUpMo.Agent.Update;

/// <summary>
/// Die Dateien und Verzeichnisse des Selbst-Updates.
///
/// Ab 0.8.0 liegt jede Version in einem eigenen Verzeichnis unter
/// <c>versions\</c>, und der Dienst zeigt per <c>binPath</c> auf eine davon. Ein
/// Update tauscht damit keine Dateien mehr, sondern stellt den Dienst um; die
/// vorige Version bleibt unangetastet daneben liegen, und der Ruecktausch ist
/// nur der Pfad zurueck.
///
/// Davor lag die EXE direkt im Programmverzeichnis und wurde ersetzt. Geraete
/// mit diesem Stand gibt es weiterhin, und der Updater beherrscht deshalb
/// beides: Die Pfade fuer den alten Weg stehen unten.
///
/// Der Updater ist eine Kopie neben den Versionen. Er kann nicht die laufende
/// Dienst-EXE sein, weil Windows die Datei eines laufenden Prozesses sperrt.
/// Ab 0.8.0 zieht eine bestaetigte neue Version die Kopie nach — bis dahin blieb
/// sie auf dem Stand der Installation.
/// </summary>
public sealed class AgentPaths
{
    public AgentPaths(string dataDirectory)
    {
        string processPath = Environment.ProcessPath
            ?? throw new InvalidOperationException("Das eigene Programmverzeichnis ist nicht ermittelbar.");

        ProcessPath = processPath;
        RootDirectory = ResolveRoot(Path.GetDirectoryName(processPath)!);
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

    private const string VersionsFolder = "versions";

    /// <summary>Die laufende EXE.</summary>
    public string ProcessPath { get; }

    /// <summary>Das Programmverzeichnis ueber allen Versionen, etwa <c>C:\Program Files\WiUpMo</c>.</summary>
    public string RootDirectory { get; }

    public string DataDirectory { get; }

    public string VersionsDirectory => Path.Combine(RootDirectory, VersionsFolder);

    public string VersionDirectory(string version) => Path.Combine(VersionsDirectory, version);

    public string VersionExe(string version) => Path.Combine(VersionDirectory(version), ServiceFileName);

    /// <summary>Die Kopie, die der Updater-Task und der Dienst nach dem Bereitlegen ausfuehren.</summary>
    public string UpdaterExe => Path.Combine(RootDirectory, UpdaterFileName);

    /// <summary>Gemeinsame Einstellungen aller Versionen.</summary>
    public string ConfigurationFile => Path.Combine(RootDirectory, "appsettings.json");

    public string MarkerPath => Path.Combine(DataDirectory, "update.json");

    /// <summary>Stand eines Installationsauftrags; siehe <c>Installation/InstallMarker.cs</c>.</summary>
    public string InstallMarkerPath => Path.Combine(DataDirectory, "install.json");

    public string LogDirectory => Path.Combine(DataDirectory, "logs");

    // --- Alter Weg (vor 0.8.0): EXE im Programmverzeichnis, Tausch per Datei ---

    /// <summary>Die Dienst-EXE am alten Ort.</summary>
    public string LegacyServiceExe => Path.Combine(RootDirectory, ServiceFileName);

    /// <summary>Die bereitgelegte neue Fassung auf dem alten Weg.</summary>
    public string StagedExe => Path.Combine(RootDirectory, "wiupmo-agent.new.exe");

    /// <summary>Der vorherige Stand auf dem alten Weg, fuer den Ruecktausch.</summary>
    public string BackupExe => Path.Combine(RootDirectory, "wiupmo-agent.bak.exe");

    /// <summary>
    /// Liegt die EXE in <c>versions\&lt;Version&gt;\</c>, ist das Programmverzeichnis
    /// zwei Ebenen hoeher; sonst ist es ihr eigenes Verzeichnis.
    /// </summary>
    public static string ResolveRoot(string exeDirectory)
    {
        string trimmed = Path.TrimEndingDirectorySeparator(exeDirectory);
        string? parent = Path.GetDirectoryName(trimmed);

        return parent is not null
               && string.Equals(Path.GetFileName(parent), VersionsFolder, StringComparison.OrdinalIgnoreCase)
            ? Path.GetDirectoryName(parent)!
            : trimmed;
    }
}
