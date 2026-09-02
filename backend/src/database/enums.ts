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
