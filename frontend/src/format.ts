import type {
  AgentUpdateJobState,
  InstallJob,
  InstallJobState,
  RestartJobState,
  UpdateClassification,
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

export const INSTALL_JOB_STATE_LABELS: Record<InstallJobState, string> = {
  pending: 'geplant',
  delivered: 'zugestellt',
  running: 'läuft',
  done: 'erledigt',
  failed: 'gescheitert',
  expired: 'verfallen',
  cancelled: 'abgebrochen',
};

/** In der Reihenfolge, in der das Backend die Typen liefert. */
export const UPDATE_CLASSIFICATION_LABELS: Record<UpdateClassification, string> = {
  security: 'Sicherheitsupdates',
  critical: 'Kritische Updates',
  definition: 'Definitionsupdates',
  rollups: 'Update-Rollups',
  updates: 'Updates',
  drivers: 'Treiber',
  'feature-packs': 'Feature Packs',
  'service-packs': 'Service Packs',
  upgrades: 'Upgrades (Feature-Updates)',
  tools: 'Tools',
  other: 'Ohne Typ',
};

/** Der Umfang eines Auftrags in einer Zeile: „ausgewählte (3)", „alle Typen" oder die Typen. */
export function installScopeLabel(job: Pick<InstallJob, 'scope' | 'selectedCount' | 'classifications'>): string {
  if (job.scope === 'selected') {
    return `ausgewählte (${job.selectedCount})`;
  }
  if (job.classifications.length === Object.keys(UPDATE_CLASSIFICATION_LABELS).length) {
    return 'alle Typen';
  }
  return job.classifications.map((type) => UPDATE_CLASSIFICATION_LABELS[type]).join(', ');
}

export const RESTART_JOB_STATE_LABELS: Record<RestartJobState, string> = {
  pending: 'geplant',
  delivered: 'zugestellt',
  notified: 'gemeldet',
  deferred: 'verschoben',
  restarting: 'startet neu',
  done: 'neu gestartet',
  failed: 'gescheitert',
  expired: 'verfallen',
  cancelled: 'abgebrochen',
};

/** Dieselben Töne wie bei Installationen; verschoben wartet wie zugestellt. */
export function restartJobBadgeClass(state: RestartJobState): string {
  switch (state) {
    case 'pending':
      return 'bg-chart-1/15 text-chart-1 border-chart-1/30';
    case 'delivered':
    case 'notified':
    case 'deferred':
      return 'bg-chart-4/15 text-chart-4 border-chart-4/30';
    case 'restarting':
      return 'bg-warning/15 text-warning-foreground border-warning/40 dark:text-warning';
    case 'done':
      return 'bg-success/15 text-success border-success/30';
    case 'failed':
      return 'bg-destructive/15 text-destructive border-destructive/30';
    default:
      return 'bg-muted text-muted-foreground border-transparent';
  }
}

/** „1 Stunde", „4 Stunden", „30 Minuten" — wie in der Meldung beim Benutzer. */
export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} Minuten`;
  if (minutes === 60) return '1 Stunde';
  if (minutes % 60 === 0) return `${minutes / 60} Stunden`;
  return `${Math.floor(minutes / 60)} Std. ${minutes % 60} Min.`;
}

/** Der Artikel zu einer KB-Nummer bei Microsoft. */
export function kbUrl(article: string): string {
  return `https://support.microsoft.com/help/${article}`;
}

/** Ein Auftrag in einer Zeile: wie viele installiert, wie viele gescheitert, wie viele nicht angeboten. */
export function installSummary(job: Pick<InstallJob, 'results' | 'error'>): string {
  if (!job.results) return '—';
  if (job.results.length === 0) return job.error ?? 'nichts installiert';
  const installed = job.results.filter((r) => r.offered && (r.resultCode === 2 || r.resultCode === 3)).length;
  const notOffered = job.results.filter((r) => !r.offered).length;
  const failed = job.results.length - installed - notOffered;
  return [
    installed > 0 ? `${installed} installiert` : '',
    failed > 0 ? `${failed} gescheitert` : '',
    notOffered > 0 ? `${notOffered} nicht angeboten` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** Dieselben Töne wie bei den Agent-Aufträgen; verfallen und abgebrochen sind neutral. */
export function installJobBadgeClass(state: InstallJobState): string {
  switch (state) {
    case 'pending':
      return 'bg-chart-1/15 text-chart-1 border-chart-1/30';
    case 'delivered':
      return 'bg-chart-4/15 text-chart-4 border-chart-4/30';
    case 'running':
      return 'bg-warning/15 text-warning-foreground border-warning/40 dark:text-warning';
    case 'done':
      return 'bg-success/15 text-success border-success/30';
    case 'failed':
      return 'bg-destructive/15 text-destructive border-destructive/30';
    default:
      return 'bg-muted text-muted-foreground border-transparent';
  }
}

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

