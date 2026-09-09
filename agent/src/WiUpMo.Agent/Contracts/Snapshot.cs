using System.Text.Json;
using System.Text.Json.Serialization;

namespace WiUpMo.Agent.Contracts;

/// <summary>
/// Gegenstuecke zu den DTOs des Backends. Die Feldnamen muessen zum
/// OpenAPI-Vertrag unter <c>shared/openapi.json</c> passen; die Serialisierung
/// laeuft mit camelCase-Benennung.
/// </summary>
public sealed class HostInfo
{
    public required string Hostname { get; init; }
    public string? OsName { get; init; }
    public string? OsVersion { get; init; }
    public string? OsBuild { get; init; }

    /// <summary>
    /// Bleibt in Phase 1 leer. Die Zuordnung zum AD-Computerkonto stellt der
    /// AD-Abgleich des Backends her (Phase 3); der Agent muesste dafuer sonst
    /// selbst gegen einen Domaenencontroller sprechen, was den Offline-Fall
    /// unnoetig verkompliziert.
    /// </summary>
    public string? AdObjectGuid { get; init; }
}

/// <summary>
/// Entspricht dem PostgreSQL-Enumtyp <c>update_source</c>. Die Werte gehen in
/// snake_case ueber die Leitung — deshalb der eigene Konverter.
/// </summary>
[JsonConverter(typeof(UpdateSourceKindConverter))]
public enum UpdateSourceKind
{
    Wsus,
    MicrosoftUpdate,
    Intune,

    /// <summary>WSUS konfiguriert, Windows greift trotzdem aufs Internet zu.</summary>
    DualScan,

    /// <summary>
    /// Nicht bestimmbar. Eigener Zustand, weil ein Geraet waehrend einer
    /// WSUS-Migration zeitweise gar keine Quelle hat — ohne diesen Wert saehe
    /// das in der Auswertung wie perfekte Compliance aus.
    /// </summary>
    Unknown,
}

public sealed class UpdateSourceKindConverter()
    : JsonStringEnumConverter<UpdateSourceKind>(JsonNamingPolicy.SnakeCaseLower, allowIntegerValues: false);

public sealed class UpdateSourceInfo
{
    public required UpdateSourceKind Source { get; init; }
    public string? WsusServerUrl { get; init; }
    public bool? UseWuServer { get; init; }
    public string[]? RegisteredServices { get; init; }
    public bool? MdmEnrolled { get; init; }
}

public sealed class AvailableUpdate
{
    public required string UpdateId { get; init; }
    public int? RevisionNumber { get; init; }
    public string? KbArticle { get; init; }
    public required string Title { get; init; }
    public string? Severity { get; init; }
    public string[]? Categories { get; init; }
    public bool? IsSecurity { get; init; }
    public string? MsrcNumber { get; init; }

    /// <summary>Als Zeichenkette, weil die Spalte im Backend <c>bigint</c> ist.</summary>
    public string? SizeBytes { get; init; }

    public string? SupportUrl { get; init; }
    public bool? RebootRequired { get; init; }
}

/// <summary>
/// <c>IUpdateHistoryEntry.Operation</c>. Das Backend erwartet die Werte in
/// Kleinschreibung, deshalb der Konverter mit camelCase-Benennung.
/// </summary>
[JsonConverter(typeof(HistoryOperationConverter))]
public enum HistoryOperation
{
    Installation,
    Uninstallation,
    Other,
}

public sealed class HistoryOperationConverter()
    : JsonStringEnumConverter<HistoryOperation>(JsonNamingPolicy.CamelCase, allowIntegerValues: false);

public sealed class HistoryEntry
{
    public string? UpdateId { get; init; }
    public int? RevisionNumber { get; init; }
    public string? KbArticle { get; init; }
    public required string Title { get; init; }
    public required HistoryOperation Operation { get; init; }
    public required int ResultCode { get; init; }

    /// <summary>
    /// Der Name steht ausgeschrieben da, weil die camelCase-Regel aus
    /// <c>HResult</c> sonst <c>hResult</c> macht — das Backend erwartet
    /// <c>hresult</c> und wuerde mit <c>forbidNonWhitelisted</c> den ganzen
    /// Snapshot ablehnen.
    /// </summary>
    [JsonPropertyName("hresult")]
    public required int HResult { get; init; }
    public required DateTimeOffset OccurredAt { get; init; }
    public string? SupportUrl { get; init; }
}

/// <summary>
/// Zustand des Agents selbst, nicht des Windows-Updates.
///
/// Damit laesst sich vom Backend aus beantworten, warum ein Geraet nicht
/// vorankommt — bisher stand die Antwort ausschliesslich in einer Protokolldatei
/// auf dem Rechner. Bewusst wenige, strukturierte Felder statt Freitext: Sie
/// beantworten die Fragen, die tatsaechlich gestellt werden.
/// </summary>
public sealed class AgentDiagnostics
{
    /// <summary>Wartende Snapshots. Wachsend heisst: kommt nicht durch.</summary>
    public required int QueuedSnapshots { get; init; }

    /// <summary>Zustand eines laufenden Selbst-Updates, sonst <c>null</c>.</summary>
    public string? SelfUpdateState { get; init; }

    public string? SelfUpdateTarget { get; init; }
    public DateTimeOffset? SelfUpdateStartedAt { get; init; }

    /// <summary>
    /// Ob der geplante Task registriert ist. Fehlt er, kann sich der Agent nicht
    /// selbst aktualisieren — und das faellt sonst erst auf, wenn ein Auftrag
    /// ewig auf "zugestellt" steht.
    /// </summary>
    public required bool UpdaterTaskRegistered { get; init; }

    /// <summary>Die letzte Warnung oder Fehlermeldung des Agents, gekuerzt.</summary>
    public string? LastError { get; init; }

    public DateTimeOffset? LastErrorAt { get; init; }

    /// <summary>
    /// Die juengsten Protokolleintraege ab Stufe Warnung.
    ///
    /// Nicht das vollstaendige Protokoll: Das sind Megabyte je Geraet und Tag,
    /// und der Erkenntniswert steckt fast vollstaendig in den Warnungen und
    /// Fehlern. Es ist auch keine Zeitreihe — jeder Check-in liefert die
    /// aktuellen, aeltere werden ueberschrieben. Wer mehr braucht, findet es im
    /// Protokoll auf dem Geraet.
    /// </summary>
    public IReadOnlyList<AgentLogEntry>? RecentLogs { get; init; }
}

public sealed class AgentLogEntry
{
    public required DateTimeOffset At { get; init; }

    /// <summary><c>warning</c> oder <c>error</c>.</summary>
    public required string Level { get; init; }

    public required string Message { get; init; }
}

public sealed class Snapshot
{
    public required Guid SnapshotId { get; init; }
    public required DateTimeOffset CollectedAt { get; init; }
    public required string AgentVersion { get; init; }
    public required HostInfo Host { get; init; }
    public required UpdateSourceInfo UpdateSource { get; init; }
    public required bool PendingReboot { get; init; }
    public required IReadOnlyList<AvailableUpdate> AvailableUpdates { get; init; }
    public required IReadOnlyList<HistoryEntry> History { get; init; }

    /// <summary>
    /// Optional — ein aelteres Backend kennt das Feld nicht und wiese den
    /// gesamten Snapshot ab, wenn es immer mitginge. Der Agent laesst es
    /// deshalb weg, solange es leer ist.
    /// </summary>
    public AgentDiagnostics? Diagnostics { get; init; }
}

public sealed class BatchCheckinRequest
{
    public required IReadOnlyList<Snapshot> Snapshots { get; init; }
}

public sealed class EnrollRequest
{
    public required string EnrollmentToken { get; init; }
    public required HostInfo Host { get; init; }
    public required string AgentVersion { get; init; }
}

public sealed class EnrollResponse
{
    public string DeviceId { get; init; } = string.Empty;
    public string DeviceSecret { get; init; } = string.Empty;
    public string Token { get; init; } = string.Empty;
}

public sealed class SnapshotResult
{
    public string SnapshotId { get; init; } = string.Empty;
    public string Outcome { get; init; } = string.Empty;
    public string? Error { get; init; }
}

/// <summary>Auftrag zum Selbst-Update, den das Backend der Check-in-Antwort beilegt.</summary>
public sealed class AgentUpdateJob
{
    public string JobId { get; init; } = string.Empty;
    public string TargetVersion { get; init; } = string.Empty;

    /// <summary>SHA-256 der erwarteten Datei, hexadezimal.</summary>
    public string Sha256 { get; init; } = string.Empty;

    /// <summary>Relativ zur Basisadresse, z. B. <c>/api/agent/v1/binary/0.2.0</c>.</summary>
    public string DownloadPath { get; init; } = string.Empty;
}

public sealed class CheckinResponse
{
    public List<SnapshotResult> Results { get; init; } = [];

    /// <summary><c>null</c>, wenn kein Auftrag offen ist.</summary>
    public AgentUpdateJob? AgentUpdate { get; init; }

    /// <summary>
    /// Der zentral eingestellte Abstand bis zum naechsten Durchlauf, in
    /// Minuten. <c>null</c> bei einem Backend, das das Feld noch nicht kennt —
    /// dann gilt weiter die oertliche Einstellung.
    /// </summary>
    public int? CheckIntervalMinutes { get; init; }
}

public sealed class UpdateResultRequest
{
    public required string JobId { get; init; }

    /// <summary><c>installing</c>, <c>done</c> oder <c>failed</c>.</summary>
    public required string State { get; init; }

    public string? AgentVersion { get; init; }
    public string? Error { get; init; }
}
