/**
 * Gegenstuecke zu den Backend-DTOs. Sie werden von Hand gepflegt statt aus
 * `shared/openapi.json` erzeugt — bei diesem Umfang ist ein Generator mehr
 * Werkzeugkette als Nutzen. Aendert sich der Vertrag, faellt es hier beim
 * Uebersetzen auf.
 */

export type DeviceStatus = 'active' | 'archived';

export type UpdateSource = 'wsus' | 'microsoft_update' | 'intune' | 'dual_scan' | 'unknown';

export type UpdateState = 'available' | 'installed' | 'failed' | 'hidden' | 'superseded';

export type UpdateEventType = 'appeared' | 'installed' | 'failed' | 'disappeared' | 'hidden';

export interface AuthStatus {
  setupRequired: boolean;
  authenticated: boolean;
  username: string | null;
  provider: string;
}

export interface SessionUser {
  id: string;
  username: string;
}

export interface DeviceListItem {
  id: string;
  hostname: string;
  adOu: string | null;
  osName: string | null;
  osVersion: string | null;
  osBuild: string | null;
  status: DeviceStatus;
  agentVersion: string | null;
  enrolledAt: string | null;
  lastSeenAt: string | null;
  /** Zuletzt angemeldetes Konto, etwa DOMAENE\benutzer — nur von Agents ab 0.7.1. */
  lastLogonUser: string | null;
  lastLogonDisplayName: string | null;
  /** Letzter Neustart — nur von Agents ab 0.8.0. */
  lastBootAt: string | null;
  updateSource: UpdateSource | null;
  pendingReboot: boolean;
  openUpdates: number;
  openSecurityUpdates: number;

  /** Offener Update-Auftrag, sonst null. */
  updateJobVersion: string | null;
  updateJobState: AgentUpdateJobState | null;
  patchAgeDays: number | null;
}

/** Ein Knoten der OU-Navigation. Der Baum entsteht im Browser aus den DNs. */
export interface DeviceOu {
  dn: string;
  devices: number;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export interface DeviceUpdate {
  updateId: string;
  wuUpdateId: string;
  kbArticle: string | null;
  title: string;
  severity: string | null;
  categories: string[];
  isSecurity: boolean;
  sizeBytes: string | null;
  supportUrl: string | null;
  state: UpdateState;
  firstAvailableAt: string | null;
  installedAt: string | null;
  resultCode: number | null;
  hresult: number | null;
  rebootRequired: boolean;
  lastReportedAt: string;
  /** Eingespielt, wartet auf den Neustart (`0x80242014`). Wird angeboten, ist aber nicht installierbar. */
  awaitingReboot: boolean;
  /** Bisherige Installationsversuche, neueste zuerst — nur bei offenen Updates. */
  attempts: InstallAttempt[];
}

export interface InstallAttempt {
  occurredAt: string;
  succeeded: boolean;
  resultCode: number | null;
  hresult: number | null;
}

export interface DeviceCheckin {
  id: string;
  collectedAt: string;
  reportedAt: string;
  agentVersion: string | null;
  updateSource: UpdateSource;
  wsusServerUrl: string | null;
  pendingReboot: boolean;
}

export interface AgentLogEntry {
  at: string;
  level: string;
  message: string;
}

/** Selbstauskunft des Agents aus dem letzten Check-in. */
export interface AgentDiagnostics {
  queuedSnapshots: number;
  selfUpdateState: string | null;
  selfUpdateTarget: string | null;
  selfUpdateStartedAt: string | null;
  updaterTaskRegistered: boolean;
  /** Ab Agent 0.8.0. */
  updaterTaskEnabled?: boolean | null;
  updaterLastRunAt?: string | null;
  updaterLastResult?: number | null;
  lastError: string | null;
  lastErrorAt: string | null;

  /** Die jüngsten Warnungen und Fehler, älteste zuerst. */
  recentLogs: AgentLogEntry[] | null;
}

export interface DeviceDetail {
  id: string;
  hostname: string;
  adDn: string | null;
  adOu: string | null;
  adObjectGuid: string | null;
  osName: string | null;
  osVersion: string | null;
  osBuild: string | null;
  status: DeviceStatus;
  agentVersion: string | null;
  enrolledAt: string | null;
  lastSeenAt: string | null;
  archivedAt: string | null;
  archivedReason: string | null;
  lastLogonUser: string | null;
  lastLogonDisplayName: string | null;
  lastBootAt: string | null;
  agentDiagnostics: AgentDiagnostics | null;
  updates: DeviceUpdate[];
  checkins: DeviceCheckin[];
}

export interface TimelineEntry {
  id: string;
  eventType: UpdateEventType;
  occurredAt: string;
  reportedAt: string;
  kbArticle: string | null;
  title: string;
  isSecurity: boolean;
  details: Record<string, unknown> | null;
}

export interface Timeline {
  items: TimelineEntry[];
  total: number;
}

export interface UpdateListItem {
  id: string;
  wuUpdateId: string;
  kbArticle: string | null;
  title: string;
  severity: string | null;
  categories: string[];
  classification: UpdateClassification;
  isSecurity: boolean;
  msrcNumber: string | null;
  sizeBytes: string | null;
  supportUrl: string | null;
  firstSeenAt: string | null;
  affectedDevices: number;
  installedDevices: number;
  failedDevices: number;
}

export interface UpdateDevice {
  deviceId: string;
  hostname: string;
  adOu: string | null;
  state: UpdateState;
  firstAvailableAt: string | null;
  installedAt: string | null;
  hresult: number | null;
  /** Eingespielt, wartet aber auf den Neustart. */
  awaitingReboot: boolean;
  lastSeenAt: string | null;
}

export interface UpdateDevices {
  items: UpdateDevice[];
  unaffected: number;
}

export type AgentUpdateJobState = 'pending' | 'delivered' | 'installing' | 'done' | 'failed';

export interface AgentRelease {
  id: string;
  version: string;
  sha256: string;
  sizeBytes: string;
  releasedAt: string;
  isCurrent: boolean;
  notes: string | null;
  devices: number;
}

export interface AgentUpdateJobView {
  id: string;
  /** Das Ausrollen, mit dem der Auftrag angelegt wurde. */
  rolloutId: string;
  deviceId: string;
  hostname: string;
  targetVersion: string;
  state: AgentUpdateJobState;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface CreateUpdateJobsResult {
  /** Null, wenn kein Gerät einen Auftrag bekam. */
  rolloutId: string | null;
  created: number;
  skipped: number;
  targetVersion: string;
}

export interface AgentVersionCount {
  version: string | null;
  devices: number;
  isCurrent: boolean;
}

/** Ein Tag der Agent-Abdeckung; die drei Zahlen ergeben zusammen den Bestand. */
export interface AgentTrendPoint {
  date: string;
  withoutAgent: number;
  activeAgents: number;
  silentAgents: number;
}

/** Ein Tag und eine Version; ein Tag hat so viele Einträge, wie Versionen liefen. */
export interface AgentVersionTrendPoint {
  date: string;
  version: string;
  devices: number;
}

/** Ein Tag und eine Quelle, aufgebaut wie der Versionsverlauf. */
export interface UpdateSourceTrendPoint {
  date: string;
  source: UpdateSource;
  devices: number;
}

export interface Summary {
  devicesTotal: number;
  devicesActive: number;
  devicesArchived: number;
  devicesEnrolled: number;
  devicesWithoutAgent: number;
  staleAgents: number;
  devicesWithOpenSecurity: number;
  devicesCritical: number;
  devicesPendingReboot: number;
  openUpdatesTotal: number;
  openSecurityUpdatesTotal: number;
  medianPatchAgeDays: number | null;
  staleAgentDays: number;
  criticalOpenDays: number;
}

export interface TrendPoint {
  date: string;
  openUpdates: number;
  appeared: number;
  installed: number;
}

export interface UpdateSourceCount {
  source: UpdateSource;
  devices: number;
  medianPatchAgeDays: number | null;
}

export interface SourceChange {
  deviceId: string;
  hostname: string;
  previousSource: UpdateSource;
  currentSource: UpdateSource;
  changedAt: string;
}

export interface UpdateSourcesReport {
  distribution: UpdateSourceCount[];
  changes: SourceChange[];
}

export interface PatchAgeBucket {
  fromDays: number | null;
  toDays: number | null;
  label: string;
  devices: number;
}

export interface PatchAgeReport {
  buckets: PatchAgeBucket[];
  osBuilds: Array<{ osName: string | null; osBuild: string | null; devices: number }>;
}

export interface ComplianceDevice {
  deviceId: string;
  hostname: string;
  adOu: string | null;
  openSecurityUpdates: number;
  oldestOpenDays: number | null;
  lastSeenAt: string | null;
  pendingReboot: boolean;
}

export interface StaleAgent {
  deviceId: string;
  hostname: string;
  adOu: string | null;
  lastSeenAt: string | null;
  daysSilent: number | null;
  agentVersion: string | null;
}

export interface MissingAgent {
  deviceId: string;
  hostname: string;
  adOu: string | null;
  osName: string | null;
  adDn: string | null;
}

export interface TimeToPatch {
  severity: string;
  updates: number;
  medianDays: number | null;
  p90Days: number | null;
}

export interface FailureGroup {
  updateId: string;
  kbArticle: string | null;
  title: string;
  hresult: number | null;
  devices: number;
  attempts: number;
}

export type AdSyncTrigger = 'scheduled' | 'manual';

export type AdSyncStatus = 'running' | 'success' | 'failed';

export interface AdSyncRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  trigger: AdSyncTrigger;
  devicesFound: number;
  devicesCreated: number;
  devicesArchived: number;
  status: AdSyncStatus;
  error: string | null;
}

export interface AdSyncResult {
  id: string;
  status: AdSyncStatus;
  devicesFound: number;
  devicesCreated: number;
  devicesArchived: number;
  devicesReactivated: number;
  error: string | null;
}

export interface AdProbeResult {
  ok: boolean;
  message: string;
  dnsHostName: string | null;
  defaultNamingContext: string | null;
  namingContexts: string[];
  domainDnsName: string | null;
  domainNetbiosName: string | null;
  matchedComputers: number | null;
  effectiveFilter: string;
}

export interface OrganizationalUnit {
  dn: string;
  name: string;
  depth: number;
}

export interface AdSettingsView {
  url: string;
  baseDn: string;
  searchBases: string[];
  effectiveSearchBases: string[];
  caCertificate: string;
  bindDn: string;
  /** Das Passwort selbst wird nie ausgeliefert. */
  bindPasswordSet: boolean;
  filterMode: 'guided' | 'custom';
  excludeDisabled: boolean;
  excludeServers: boolean;
  filter: string;
  effectiveFilter: string;
  pageSize: number;
  intervalMinutes: number;
  startupDelaySeconds: number;
  tlsRejectUnauthorized: boolean;
  timeoutSeconds: number;
  configured: boolean;
}

export interface ThresholdSettings {
  staleAgentDays: number;
  criticalOpenDays: number;
  pendingRebootDays: number;
}

export interface RetentionSettings {
  eventDays: number;
  checkinDays: number;
}

export interface InstallSettings {
  /** Tage nach dem Zeitpunkt, bis ein nicht abgeholter Installationsauftrag verfällt. */
  expiryDays: number;
}

/** Klassifikation von Windows Update; das Backend leitet sie aus den Kategorien ab. */
export type UpdateClassification =
  | 'security'
  | 'critical'
  | 'definition'
  | 'rollups'
  | 'updates'
  | 'drivers'
  | 'feature-packs'
  | 'service-packs'
  | 'upgrades'
  | 'tools'
  | 'other';

export type InstallJobScope = 'types' | 'selected';

export type InstallJobState =
  | 'pending'
  | 'delivered'
  | 'running'
  | 'done'
  | 'failed'
  | 'expired'
  | 'cancelled';

export interface InstallJobUpdateResult {
  updateId: string;
  kbArticle: string | null;
  title: string | null;
  offered: boolean;
  resultCode: number | null;
  hresult: number | null;
  rebootRequired: boolean;
}

export interface InstallJob {
  id: string;
  installationId: string;
  deviceId: string;
  hostname: string;
  scope: InstallJobScope;
  selectedCount: number;
  classifications: UpdateClassification[];
  state: InstallJobState;
  notBefore: string;
  expiresAt: string;
  createdBy: string;
  createdAt: string;
  deliveredAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  results: InstallJobUpdateResult[] | null;
}

export interface InstallPreview {
  /** Alle Typen in fester Reihenfolge, auch die ohne offenes Update. */
  classifications: { classification: UpdateClassification; updates: number; devices: number }[];
}

export interface InstallJobsSkipped {
  openJob: number;
  agentTooOld: number;
  notEligible: number;
  nothingOpen: number;
}

export interface CreateInstallJobsResult {
  /** Null, wenn kein Gerät einen Auftrag bekam. */
  installationId: string | null;
  created: number;
  skipped: InstallJobsSkipped;
  expiryDays: number;
  minimumAgentVersion: string;
}

/** Was in einem Zug für mehrere Geräte angelegt wurde. */
export interface Installation {
  id: string;
  scope: InstallJobScope;
  selectedCount: number;
  classifications: UpdateClassification[];
  notBefore: string;
  spreadMinutes: number;
  requestedDevices: number;
  /** Null bei Installationen, die vor der Gruppierung entstanden. */
  skipped: InstallJobsSkipped | null;
  createdBy: string;
  createdAt: string;
  devices: number;
  states: Record<InstallJobState, number>;
  installedUpdates: number;
  failedUpdates: number;
  rebootDevices: number;
  lastCompletedAt: string | null;
}

/** Einstufung durch Microsoft als Filter; `none` für Updates ohne. */
export type UpdateSeverityFilter = 'critical' | 'important' | 'moderate' | 'low' | 'none';

/** Zustand über alle aktiven Geräte. */
export type UpdateStateFilter = 'open' | 'failed' | 'closed';

/** Was sich der angemeldete Benutzer gemerkt hat; im Backend je Benutzername. */
/** Was in einem Zug beauftragt wurde: ein Update-Auftrag je Gerät. */
export interface AgentRollout {
  id: string;
  targetVersion: string;
  /** `outdated`: alle mit abweichender Version, `selected`: eine Auswahl, `unknown`: nachgetragen. */
  scope: 'outdated' | 'selected' | 'unknown';
  requestedDevices: number | null;
  skipped: number;
  createdBy: string | null;
  createdAt: string;
  devices: number;
  states: Record<AgentUpdateJobState | 'cancelled', number>;
  lastCompletedAt: string | null;
}

/** Gleichartige Warnungen und Fehler der Agents über alle Geräte. */
export interface AgentProblem {
  key: string;
  message: string;
  level: 'error' | 'warning';
  devices: number;
  occurrences: number;
  lastAt: string;
  entries: { deviceId: string; hostname: string; lastAt: string; occurrences: number; message: string }[];
}

export interface UserPreferences {
  dashboard: { rangeDays: number; interval: 'hour' | 'day' | 'week' } | null;
}

export interface UpdateClassificationCount {
  classification: UpdateClassification;
  updates: number;
}

export interface AgentSettingsView {
  /** Wird bewusst ausgeliefert — man braucht es bei jeder Agent-Installation. */
  enrollmentToken: string;

  /** Abstand zwischen zwei regulären Meldungen, in Minuten. */
  checkIntervalMinutes: number;
}

export interface AdGroup {
  dn: string;
  name: string;
  accountName: string | null;
}

export interface AuthSettings {
  /** Die beiden Wege sind unabhängig; mindestens einer muss offen bleiben. */
  localEnabled: boolean;
  ldapEnabled: boolean;
  userDnTemplate: string;
  /** Leer bedeutet: keine Einschränkung. */
  allowedGroups: string[];
}

export interface RetentionResult {
  eventsDeleted: number;
  checkinsDeleted: number;
  eventDays: number;
  checkinDays: number;
}

export interface SettingsView {
  agent: AgentSettingsView;
  ad: AdSettingsView;
  auth: AuthSettings;
  thresholds: ThresholdSettings;
  retention: RetentionSettings;
  install: InstallSettings;
}

export interface AdStatus {
  enabled: boolean;
  url: string;
  baseDn: string;
  bindDn: string;
  bindPasswordSet: boolean;
  filter: string;
  intervalMinutes: number;
  running: boolean;
  lastRun: AdSyncRun | null;
}
