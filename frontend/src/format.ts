import type { UpdateSource, UpdateState, UpdateEventType } from '@/api/types';

/**
 * Alle Zeitstempel kommen in UTC aus dem Backend und werden erst hier
 * lokalisiert — so, wie es der Entwicklungsplan als Risikopunkt festhaelt.
 * Laptops reisen; gespeichert wird deshalb ausschliesslich UTC.
 */
export function formatDateTime(value: string | null): string {
  if (!value) {
    return '—';
  }
  return new Date(value).toLocaleString('de-CH', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

export function formatDate(value: string | null): string {
  if (!value) {
    return '—';
  }
  return new Date(value).toLocaleDateString('de-CH', { dateStyle: 'medium' });
}

/** "vor 3 Tagen" ist bei einem Check-in aussagekraeftiger als ein Datum. */
export function formatRelative(value: string | null): string {
  if (!value) {
    return 'nie';
  }

  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.round(diffMs / 60_000);

  if (minutes < 1) return 'gerade eben';
  if (minutes < 60) return `vor ${minutes} min`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `vor ${hours} h`;

  const days = Math.round(hours / 24);
  return days === 1 ? 'vor 1 Tag' : `vor ${days} Tagen`;
}

export function formatBytes(value: string | null): string {
  if (!value) {
    return '—';
  }

  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '—';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }

  return `${size.toFixed(size < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

export const UPDATE_SOURCE_LABELS: Record<UpdateSource, string> = {
  wsus: 'WSUS',
  microsoft_update: 'Microsoft Update',
  intune: 'Intune',
  dual_scan: 'Dual Scan',
  unknown: 'unbekannt',
};

export const UPDATE_STATE_LABELS: Record<UpdateState, string> = {
  available: 'offen',
  installed: 'installiert',
  failed: 'fehlgeschlagen',
  hidden: 'ausgeblendet',
  superseded: 'abgelöst',
};

export const EVENT_TYPE_LABELS: Record<UpdateEventType, string> = {
  appeared: 'aufgetaucht',
  installed: 'installiert',
  failed: 'fehlgeschlagen',
  disappeared: 'verschwunden',
  hidden: 'ausgeblendet',
};

type Severity = 'success' | 'info' | 'warn' | 'danger' | 'secondary';

export function stateSeverity(state: UpdateState): Severity {
  switch (state) {
    case 'available':
      return 'warn';
    case 'failed':
      return 'danger';
    case 'installed':
      return 'success';
    default:
      return 'secondary';
  }
}

/**
 * Dual Scan wird als Warnung dargestellt, nicht als neutrale Angabe: Das Geraet
 * holt sich dann trotz WSUS-Richtlinie Teile aus dem Internet — in einer
 * Migrationsauswertung ist das der Zustand, den man sehen will.
 */
export function sourceSeverity(source: UpdateSource | null): Severity {
  switch (source) {
    case 'wsus':
      return 'info';
    case 'microsoft_update':
      return 'success';
    case 'intune':
      return 'success';
    case 'dual_scan':
      return 'warn';
    default:
      return 'secondary';
  }
}

export function eventSeverity(type: UpdateEventType): Severity {
  switch (type) {
    case 'installed':
      return 'success';
    case 'failed':
      return 'danger';
    case 'appeared':
      return 'warn';
    default:
      return 'secondary';
  }
}

/** Fehlercodes der Windows-Update-API sind in Hexadezimal auffindbar, dezimal nicht. */
export function formatHresult(value: number | null): string {
  if (value === null || value === 0) {
    return '—';
  }
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}
