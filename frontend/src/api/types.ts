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
  updateSource: UpdateSource | null;
  pendingReboot: boolean;
  openUpdates: number;
  openSecurityUpdates: number;
  patchAgeDays: number | null;
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
  deviceId: string;
  hostname: string;
  targetVersion: string;
  state: AgentUpdateJobState;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface CreateUpdateJobsResult {
  created: number;
  skipped: number;
  targetVersion: string;
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

export interface AgentSettingsView {
  /** Wird bewusst ausgeliefert — man braucht es bei jeder Agent-Installation. */
  enrollmentToken: string;
}

export interface AdGroup {
  dn: string;
  name: string;
  accountName: string | null;
}

export interface AuthSettings {
  provider: 'local' | 'ldap';
  userDnTemplate: string;
  /** Leer bedeutet: keine Einschränkung. */
  allowedGroups: string[];
  allowLocalFallback: boolean;
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
