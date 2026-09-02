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
