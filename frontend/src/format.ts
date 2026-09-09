import type {
  AgentUpdateJobState,
  UpdateSource,
  UpdateState,
  UpdateEventType,
} from '@/api/types';

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

export const JOB_STATE_LABELS: Record<AgentUpdateJobState, string> = {
  pending: 'offen',
  delivered: 'zugestellt',
  installing: 'wird installiert',
  done: 'erledigt',
  failed: 'gescheitert',
};

/**
 * Jeder Status mit eigener Farbe, keiner grau.
 *
 * Der Fortschritt eines Auftrags läuft von blau über violett und gelb nach
 * grün — beim Überfliegen erkennt man den Stand an der Farbe, nicht erst am
 * Wort. Fielen „offen" und „zugestellt" wie früher auf denselben neutralen Ton,
 * sähe die Liste farblos aus; es sind die beiden häufigsten.
 */
export function jobBadgeClass(state: AgentUpdateJobState): string {
  switch (state) {
    case 'pending':
      return 'bg-chart-1/15 text-chart-1 border-chart-1/30';
    case 'delivered':
      return 'bg-chart-4/15 text-chart-4 border-chart-4/30';
    case 'installing':
      return 'bg-warning/15 text-warning-foreground border-warning/40 dark:text-warning';
    case 'done':
      return 'bg-success/15 text-success border-success/30';
    case 'failed':
      return 'bg-destructive/15 text-destructive border-destructive/30';
    default:
      return 'bg-muted text-muted-foreground border-transparent';
  }
}

/** Farbklassen der Abzeichen. */
export function sourceBadgeClass(source: UpdateSource | null): string {
  switch (source) {
    case 'wsus':
      return 'bg-chart-1/15 text-chart-1 border-chart-1/30';
    case 'microsoft_update':
    case 'intune':
      return 'bg-success/15 text-success border-success/30';
    // Dual Scan ist als Warnung eingefärbt: Das Gerät holt sich trotz
    // WSUS-Richtlinie Teile aus dem Internet — in einer Migrationsauswertung
    // ist das der Zustand, den man sehen will.
    case 'dual_scan':
      return 'bg-warning/15 text-warning-foreground border-warning/40 dark:text-warning';
    default:
      return 'bg-muted text-muted-foreground border-transparent';
  }
}

export function stateBadgeClass(state: UpdateState): string {
  switch (state) {
    case 'available':
      return 'bg-warning/15 text-warning-foreground border-warning/40 dark:text-warning';
    case 'failed':
      return 'bg-destructive/15 text-destructive border-destructive/30';
    case 'installed':
      return 'bg-success/15 text-success border-success/30';
    default:
      return 'bg-muted text-muted-foreground border-transparent';
  }
}

export function eventBadgeClass(type: UpdateEventType): string {
  switch (type) {
    case 'installed':
      return 'bg-success/15 text-success border-success/30';
    case 'failed':
      return 'bg-destructive/15 text-destructive border-destructive/30';
    case 'appeared':
      return 'bg-warning/15 text-warning-foreground border-warning/40 dark:text-warning';
    default:
      return 'bg-muted text-muted-foreground border-transparent';
  }
}

