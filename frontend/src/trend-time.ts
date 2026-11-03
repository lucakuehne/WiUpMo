/**
 * Zeitabschnitte der Verläufe im Dashboard: welche Intervalle zu welchem
 * Zeitraum passen, und wie ein Abschnitt an der Achse und im Tooltip heisst.
 *
 * Das Backend schneidet in UTC und liefert den Beginn jedes Abschnitts —
 * stündlich als Zeitpunkt, täglich und wöchentlich als Datum. Stunden werden
 * hier in Ortszeit umgerechnet; Tage und Wochen tragen ihr Datum, so wie es ist.
 */
export type TrendInterval = 'hour' | 'day' | 'week';

export const INTERVAL_LABELS: Record<TrendInterval, string> = {
  hour: 'Stündlich',
  day: 'Täglich',
  week: 'Wöchentlich',
};

/** „pro Stunde" usw., für Balken, die je Abschnitt zählen. */
export const PER_INTERVAL: Record<TrendInterval, string> = {
  hour: 'pro Stunde',
  day: 'pro Tag',
  week: 'pro Woche',
};

/**
 * Stündlich nur für kurze Zeiträume — mehr als eine Woche wären über 168
 * Balken, die niemand mehr auseinanderhält, und das Backend nimmt höchstens 14
 * Tage an. Wöchentlich erst ab einem Monat; bei einer Woche wäre es ein Balken.
 */
export function intervalsFor(days: number): TrendInterval[] {
  if (days <= 1) return ['hour'];
  if (days <= 7) return ['hour', 'day'];
  return ['day', 'week'];
}

/** Die Vorgabe beim Wechsel des Zeitraums: so fein wie sinnvoll, aber nicht unübersichtlich. */
export function defaultInterval(days: number): TrendInterval {
  if (days <= 1) return 'hour';
  return days >= 180 ? 'week' : 'day';
}

/** So viele Abschnitte fordert das Dashboard für einen Zeitraum an. */
export function bucketCount(days: number, interval: TrendInterval): number {
  if (interval === 'hour') return days * 24;
  if (interval === 'week') return Math.ceil(days / 7);
  return days;
}

/** „36 Stunden", „30 Tage", „13 Wochen" — für den Hinweis auf eine verkürzte Spanne. */
export function spanText(count: number, interval: TrendInterval): string {
  const units: Record<TrendInterval, [string, string]> = {
    hour: ['Stunde', 'Stunden'],
    day: ['Tag', 'Tage'],
    week: ['Woche', 'Wochen'],
  };
  const [one, many] = units[interval];
  return `${count} ${count === 1 ? one : many}`;
}

function start(key: string, interval: TrendInterval): Date {
  return interval === 'hour' ? new Date(key) : new Date(`${key}T00:00:00Z`);
}

/** Kalenderwoche nach ISO 8601, wie sie in Kalendern steht. */
function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** „03.11." aus einem UTC-Datum. */
function dayMonth(date: Date): string {
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.`;
}

/**
 * Die Beschriftung an der Achse: kurz, aber eindeutig. Stündlich über mehr als
 * einen Tag braucht es das Datum dazu, sonst stünde 14:00 siebenmal da.
 */
export function formatTick(key: string, interval: TrendInterval, days: number): string {
  const date = start(key, interval);

  if (interval === 'hour') {
    const time = `${pad(date.getHours())}:00`;
    return days <= 1 ? time : `${pad(date.getDate())}.${pad(date.getMonth() + 1)}. ${time}`;
  }

  return interval === 'week' ? `KW ${isoWeek(date)}` : dayMonth(date);
}

/** Der volle Abschnitt für den Tooltip: „Di, 03.11.2026, 14:00–15:00", „KW 45: 03.11.–09.11.2026". */
export function formatTitle(key: string, interval: TrendInterval): string {
  const date = start(key, interval);

  if (interval === 'hour') {
    const day = date.toLocaleDateString('de-CH', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
    return `${day}, ${pad(date.getHours())}:00–${pad((date.getHours() + 1) % 24)}:00`;
  }

  if (interval === 'week') {
    const end = new Date(date.getTime() + 6 * 86_400_000);
    return `KW ${isoWeek(date)}: ${dayMonth(date)}–${dayMonth(end)}${end.getUTCFullYear()}`;
  }

  return date.toLocaleDateString('de-CH', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
