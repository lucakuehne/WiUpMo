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

public sealed class CheckinResponse
{
    public List<SnapshotResult> Results { get; init; } = [];
}
