/**
 * Diese Aufzaehlungen existieren doppelt: hier als TypeScript-Enum und in der
 * Datenbank als PostgreSQL-Enumtyp (siehe die Initialmigration). Die Namen der
 * PG-Typen stehen als Konstanten daneben, damit Entity und Migration sich nicht
 * auseinanderentwickeln.
 */

export const PG_ENUM = {
  deviceStatus: 'device_status',
  updateState: 'update_state',
  updateEventType: 'update_event_type',
  updateSource: 'update_source',
  adSyncTrigger: 'ad_sync_trigger',
  adSyncStatus: 'ad_sync_status',
  agentUpdateJobState: 'agent_update_job_state',
  installJobState: 'install_job_state',
  installJobScope: 'install_job_scope',
} as const;

export enum DeviceStatus {
  Active = 'active',
  /** Im AD verschwunden. Wird nie geloescht, damit die Historie erhalten bleibt. */
  Archived = 'archived',
}

export enum UpdateState {
  Available = 'available',
  Installed = 'installed',
  Failed = 'failed',
  Hidden = 'hidden',
  /**
   * Aus der Verfuegbar-Liste verschwunden, ohne installiert worden zu sein —
   * typischerweise durch ein Nachfolge-Update abgeloest.
   */
  Superseded = 'superseded',
}

export enum UpdateEventType {
  Appeared = 'appeared',
  Installed = 'installed',
  Failed = 'failed',
  Disappeared = 'disappeared',
  Hidden = 'hidden',
}

export enum UpdateSource {
  Wsus = 'wsus',
  MicrosoftUpdate = 'microsoft_update',
  Intune = 'intune',
  /** WSUS konfiguriert, Windows zieht Feature-Updates trotzdem aus dem Internet. */
  DualScan = 'dual_scan',
  /**
   * Nicht bestimmbar. Wichtig als eigener Zustand: waehrend einer
   * WSUS-Migration sieht ein Geraet zeitweise gar keine Quelle. Ohne diesen
   * Wert saehe das in der Auswertung wie perfekte Compliance aus.
   */
  Unknown = 'unknown',
}

export enum AdSyncTrigger {
  Scheduled = 'scheduled',
  Manual = 'manual',
}

export enum AdSyncStatus {
  Running = 'running',
  Success = 'success',
  Failed = 'failed',
}

export enum AgentUpdateJobState {
  Pending = 'pending',
  Delivered = 'delivered',
  Installing = 'installing',
  Done = 'done',
  Failed = 'failed',
}

/**
 * Weg eines Neustart-Auftrags: abgeholt, dem Benutzer gezeigt, verschoben,
 * eingeleitet. `done` setzt erst der naechste gemeldete Neustart.
 */
export enum RestartJobState {
  Pending = 'pending',
  Delivered = 'delivered',
  Notified = 'notified',
  Deferred = 'deferred',
  Restarting = 'restarting',
  Done = 'done',
  Failed = 'failed',
  Expired = 'expired',
  Cancelled = 'cancelled',
}

export enum InstallJobState {
  /** Angelegt, wartet auf den Zeitpunkt bzw. den naechsten Check-in. */
  Pending = 'pending',
  /** Mit einer Check-in-Antwort hinausgegangen. */
  Delivered = 'delivered',
  /** Der Agent installiert. */
  Running = 'running',
  Done = 'done',
  Failed = 'failed',
  /** Innerhalb der Frist nicht abgeholt. */
  Expired = 'expired',
  Cancelled = 'cancelled',
}

export enum InstallJobScope {
  /** Alles Offene der gewaehlten Update-Typen. */
  Types = 'types',
  /** Einzeln ausgewaehlte Updates. */
  Selected = 'selected',
}
