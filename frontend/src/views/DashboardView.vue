<script setup lang="ts">
import type { ActiveElement, ChartEvent } from 'chart.js/auto';
import { computed, onMounted, ref } from 'vue';
import { useRouter, type RouteLocationRaw } from 'vue-router';
import { get, put } from '@/api/client';
import type {
  AgentTrendPoint,
  AgentVersionCount,
  AgentVersionTrendPoint,
  Summary,
  TrendPoint,
  UpdateSource,
  UpdateSourcesReport,
  UpdateSourceTrendPoint,
  UserPreferences,
} from '@/api/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import ChartCanvas from '@/components/ChartCanvas.vue';
import SourceLegend from '@/components/SourceLegend.vue';
import { baseOptions, palette } from '@/chart';
import { UPDATE_SOURCE_LABELS } from '@/format';
import {
  INTERVAL_LABELS,
  PER_INTERVAL,
  bucketCount,
  defaultInterval,
  formatTick,
  formatTitle,
  intervalsFor,
  spanText,
  type TrendInterval,
} from '@/trend-time';

const router = useRouter();

const summary = ref<Summary | null>(null);
const trend = ref<TrendPoint[]>([]);
const agentTrend = ref<AgentTrendPoint[]>([]);
const agentVersions = ref<AgentVersionCount[]>([]);
const agentVersionTrend = ref<AgentVersionTrendPoint[]>([]);
const sources = ref<UpdateSourcesReport | null>(null);
const sourceTrend = ref<UpdateSourceTrendPoint[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

/**
 * Zeitraum und Intervall gelten für alle Verläufe; die übrigen Karten zeigen
 * den aktuellen Stand und sind davon unberührt.
 *
 * Ein Verlauf kann weniger zurückliefern als angefragt: Was sich mangels
 * aufbewahrter Check-ins nicht mehr belegen lässt, zeigt er erst gar nicht.
 * Deshalb steht die tatsächliche Spanne an der Karte.
 */
const rangeDays = ref(90);
const interval = ref<TrendInterval>('day');

/**
 * Womit die angezeigten Verläufe geladen wurden. Die Beschriftung richtet sich
 * danach, nicht nach der Auswahl: Zwischen Umschalten und Eintreffen der Daten
 * stünden sonst Tage mit Stunden beschriftet.
 */
const loaded = ref<{ days: number; interval: TrendInterval }>({ days: 90, interval: 'day' });

const rangeOptions = [
  { value: '1', label: '24 Stunden' },
  { value: '7', label: '7 Tage' },
  { value: '30', label: '30 Tage' },
  { value: '90', label: '90 Tage' },
  { value: '180', label: '180 Tage' },
  { value: '365', label: '1 Jahr' },
];

interface Tile {
  label: string;
  value: number;
  hint: string;
  tone: 'neutral' | 'ok' | 'warn' | 'danger';
  to: RouteLocationRaw;
}

const tiles = computed<Tile[]>(() => {
  const s = summary.value;
  if (!s) {
    return [];
  }

  return [
    {
      label: 'Geräte',
      value: s.devicesActive,
      hint: `${s.devicesEnrolled} mit Agent`,
      tone: 'neutral',
      to: { name: 'devices' },
    },
    {
      label: `Kritisch offen (> ${s.criticalOpenDays} T)`,
      value: s.devicesCritical,
      hint: `${s.devicesWithOpenSecurity} mit offenen Sicherheitsupdates`,
      tone: s.devicesCritical > 0 ? 'danger' : 'ok',
      to: { name: 'devices', query: { hasOpenSecurity: '1' } },
    },
    {
      label: `Melden sich nicht (> ${s.staleAgentDays} T)`,
      value: s.staleAgents,
      hint: 'unterscheidet gepatcht von stumm',
      tone: s.staleAgents > 0 ? 'warn' : 'ok',
      // Dieselben Parameternamen wie die API, damit die Geräteliste sie ohne
      // Umrechnung übernehmen kann.
      to: { name: 'devices', query: { staleDays: String(s.staleAgentDays) } },
    },
    {
      label: 'Ohne Agent',
      value: s.devicesWithoutAgent,
      hint: 'im AD bekannt, nicht installiert',
      tone: s.devicesWithoutAgent > 0 ? 'warn' : 'ok',
      to: { name: 'devices', query: { hasAgent: '0' } },
    },
    {
      label: 'Neustart ausstehend',
      value: s.devicesPendingReboot,
      hint: 'Updates greifen erst danach',
      tone: s.devicesPendingReboot > 0 ? 'warn' : 'ok',
      to: { name: 'devices', query: { pendingReboot: '1' } },
    },
    {
      label: 'Patch-Alter (Median)',
      value: s.medianPatchAgeDays ?? 0,
      hint: s.medianPatchAgeDays === null ? 'nichts offen' : 'Tage bis zum ältesten offenen Update',
      tone: 'neutral',
      to: { name: 'reports' },
    },
  ];
});

/**
 * Farbe nur als Rahmen links, nicht als Fläche: Sechs bunte Kacheln
 * nebeneinander tragen keine Information mehr — auffällig soll sein, was
 * Aufmerksamkeit braucht.
 */
const TONE_BORDERS: Record<Tile['tone'], string> = {
  neutral: 'border-l-border',
  ok: 'border-l-success/60',
  warn: 'border-l-warning',
  danger: 'border-l-destructive',
};

/**
 * Die Beschriftung der Zeitachse. Die Diagramme bekommen den Beginn jedes
 * Abschnitts unverändert; kurz gefasst wird erst hier, und der Tooltip zeigt
 * den vollen Abschnitt.
 */
const timeTicks = computed(() => ({
  color: palette.value.muted,
  maxTicksLimit: 12,
  callback(this: { getLabelForValue(value: number): string }, value: number | string): string {
    return formatTick(this.getLabelForValue(Number(value)), loaded.value.interval, loaded.value.days);
  },
}));

const timeTooltip = computed(() => ({
  callbacks: {
    title: (items: Array<{ label: string }>) =>
      items.length > 0 ? formatTitle(items[0].label, loaded.value.interval) : '',
  },
}));

/** Wie viele Abschnitte ein Verlauf trägt, und ob das weniger sind als angefragt. */
function shortfall(points: Array<{ date: string }>): { shown: string; requested: string } | null {
  const shown = new Set(points.map((point) => point.date)).size;
  const requested = bucketCount(loaded.value.days, loaded.value.interval);
  return shown > 0 && shown < requested
    ? { shown: spanText(shown, loaded.value.interval), requested: spanText(requested, loaded.value.interval) }
    : null;
}

const trendData = computed(() => ({
  labels: trend.value.map((point) => point.date),
  datasets: [
    {
      label: 'Offene Updates (Flotte)',
      data: trend.value.map((point) => point.openUpdates),
      borderColor: palette.value.series[0],
      backgroundColor: 'transparent',
      tension: 0.3,
      pointRadius: 0,
      yAxisID: 'y',
    },
    {
      label: `Installiert ${PER_INTERVAL[loaded.value.interval]}`,
      data: trend.value.map((point) => point.installed),
      borderColor: palette.value.series[1],
      backgroundColor: palette.value.series[1],
      type: 'bar' as const,
      yAxisID: 'y2',
    },
    /**
     * Auch das Auftauchen gehört ins Bild.
     *
     * Ohne diesen Balken bewegt sich die Kurve scheinbar grundlos: Sie steigt
     * mit neu angebotenen Updates und fällt nicht nur durch Installationen,
     * sondern auch, wenn Updates abgelöst werden oder verschwinden. Wer nur die
     * Installationen sieht, rechnet zwangsläufig falsch nach.
     */
    {
      label: 'Neu aufgetaucht',
      data: trend.value.map((point) => point.appeared),
      borderColor: palette.value.series[2],
      backgroundColor: palette.value.series[2],
      type: 'bar' as const,
      yAxisID: 'y2',
    },
  ],
}));

const trendOptions = computed(() => ({
  ...baseOptions.value,
  interaction: { mode: 'index' as const, intersect: false },
  plugins: { ...baseOptions.value.plugins, tooltip: timeTooltip.value },
  scales: {
    x: {
      ticks: timeTicks.value,
      grid: { display: false },
    },
    y: {
      position: 'left' as const,
      beginAtZero: true,
      title: { display: true, text: 'offen', color: palette.value.muted },
      ticks: { color: palette.value.muted },
      grid: { color: palette.value.grid },
    },
    y2: {
      position: 'right' as const,
      beginAtZero: true,
      title: { display: true, text: 'installiert', color: palette.value.muted },
      ticks: { color: palette.value.muted },
      grid: { display: false },
    },
  },
}));

/**
 * Fugen in Kartenfarbe zwischen gestapelten Segmenten und Ringstücken. Sie
 * trennen benachbarte Flächen auch dort, wo die Farben allein bei einer
 * Farbfehlsichtigkeit nah beieinander liegen.
 */
const segmentGap = computed(() => ({ borderColor: palette.value.surface, borderWidth: { top: 1 } }));
const ringGap = computed(() => ({ borderColor: palette.value.surface, borderWidth: 2 }));

/**
 * Alle Verläufe sind gestapelt: Die Teile ergeben zusammen den Bestand eines
 * Abschnitts. Die Legende steht umgekehrt, damit sie sich von oben nach unten so
 * liest wie der Stapel.
 */
const stackedOptions = computed(() => ({
  ...baseOptions.value,
  interaction: { mode: 'index' as const, intersect: false },
  plugins: {
    legend: { ...baseOptions.value.plugins.legend, reverse: true },
    tooltip: timeTooltip.value,
  },
  scales: {
    x: {
      stacked: true,
      ticks: timeTicks.value,
      grid: { display: false },
    },
    y: {
      stacked: true,
      beginAtZero: true,
      title: { display: true, text: 'Geräte', color: palette.value.muted },
      ticks: { color: palette.value.muted, precision: 0 },
      grid: { color: palette.value.grid },
    },
  },
}));

/** Ein Ring mit Legende darunter; ein Klick auf ein Stück führt in die Geräteliste. */
function ringOptions(target: (index: number) => RouteLocationRaw | null) {
  return {
    ...baseOptions.value,
    plugins: {
      legend: { position: 'bottom' as const, labels: { color: palette.value.text, boxWidth: 12 } },
    },
    // Die Frage nach einem Anteil ist fast immer die Frage danach, welche
    // Geräte darin stecken.
    onClick: (_event: ChartEvent, elemente: ActiveElement[]) => {
      const ziel = target(elemente[0]?.index ?? -1);
      if (ziel) {
        void router.push(ziel);
      }
    },
    onHover: (event: ChartEvent, elemente: ActiveElement[]) => {
      const element = event.native?.target as HTMLElement | null;
      if (element) {
        element.style.cursor = elemente.length > 0 ? 'pointer' : 'default';
      }
    },
  };
}

/**
 * Die drei Zustände der Agent-Abdeckung, im Ring wie im Verlauf.
 *
 * Reihenfolge von unten: aktiv, stumm, ohne Agent — das Erfreuliche als
 * Sockel, das zu Erledigende obenauf. Stumm ist grau, nicht gelb: Grün neben
 * Gelb ist bei einer Rot-Grün-Schwäche kaum zu unterscheiden (geprüft), und
 * ein Gerät, das schweigt, ist eher ausgegraut als ein Alarm — der steht bei
 * „ohne Agent".
 */
const coverage = computed(() => [
  { label: 'Mit Agent, meldet sich', color: palette.value.series[1] },
  {
    label: `Mit Agent, stumm (> ${summary.value?.staleAgentDays ?? 14} T)`,
    color: palette.value.series[4],
  },
  { label: 'Ohne Agent', color: palette.value.series[5] },
]);

const agentTrendData = computed(() => {
  const values = [
    agentTrend.value.map((point) => point.activeAgents),
    agentTrend.value.map((point) => point.silentAgents),
    agentTrend.value.map((point) => point.withoutAgent),
  ];

  return {
    labels: agentTrend.value.map((point) => point.date),
    datasets: coverage.value.map((state, index) => ({
      label: state.label,
      data: values[index],
      backgroundColor: state.color,
      ...segmentGap.value,
    })),
  };
});

/** Der heutige Stand aus denselben Zahlen wie die Kacheln. */
const coverageData = computed(() => {
  const s = summary.value;
  const values = s ? [s.devicesEnrolled - s.staleAgents, s.staleAgents, s.devicesWithoutAgent] : [];

  return {
    labels: coverage.value.map((state) => state.label),
    datasets: [
      {
        data: values,
        backgroundColor: coverage.value.map((state) => state.color),
        ...ringGap.value,
      },
    ],
  };
});

const coverageOptions = computed(() =>
  ringOptions((index) => {
    const s = summary.value;
    if (!s) return null;
    return [
      { name: 'devices', query: { hasAgent: '1' } },
      { name: 'devices', query: { staleDays: String(s.staleAgentDays) } },
      { name: 'devices', query: { hasAgent: '0' } },
    ][index] ?? null;
  }),
);

/** Versionsnummern der Reihe nach, `1.10.0` nach `1.9.0`; Zusätze wie `-beta` als Text. */
function compareVersions(a: string, b: string): number {
  const left = a.split(/[.-]/);
  const right = b.split(/[.-]/);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? '';
    const y = right[i] ?? '';
    const byNumber = /^\d+$/.test(x) && /^\d+$/.test(y) ? Number(x) - Number(y) : x.localeCompare(y);
    if (byNumber !== 0) {
      return byNumber;
    }
  }
  return 0;
}

const currentVersion = computed(
  () => agentVersions.value.find((entry) => entry.isCurrent)?.version ?? null,
);

/**
 * Die aktuelle Version ist grün, wie ihr Abzeichen; ohne markierte Version
 * übernimmt die neueste das Grün. Die fünf neuesten übrigen tragen Blau in
 * Helligkeitsstufen — Versionen haben eine Reihenfolge, und die zeigt sich so
 * in der Farbe: je neuer, desto kräftiger. Alles davor teilt sich Grau, im
 * Kreis wie im Verlauf.
 *
 * Früher waren es drei eigene Farben. Mehr verschiedene Farben lassen sich im
 * Stapel nicht sicher auseinanderhalten; Stufen eines Farbtons schon, solange
 * ihre Helligkeit weit genug auseinanderliegt. Rampe und Übergänge zu Grau
 * und Grün sind gegen Farbfehlsichtigkeit geprüft, hell wie dunkel.
 */
const versionColors = computed(() => {
  const versions = new Set<string>();
  for (const entry of agentVersions.value) {
    if (entry.version) versions.add(entry.version);
  }
  for (const point of agentVersionTrend.value) {
    versions.add(point.version);
  }

  const newestFirst = [...versions].sort((a, b) => compareVersions(b, a));
  const lead =
    currentVersion.value && versions.has(currentVersion.value) ? currentVersion.value : newestFirst[0];
  const ramp = palette.value.versionRamp;
  const others = newestFirst.filter((version) => version !== lead).slice(0, ramp.length);

  const colors = new Map<string, string>();
  if (lead) colors.set(lead, palette.value.series[1]);
  // Die neueste übrige bekommt die kräftigste Stufe, auch wenn es weniger
  // Versionen als Stufen gibt.
  others.forEach((version, index) => colors.set(version, ramp[ramp.length - 1 - index]));
  return colors;
});

function versionColor(version: string | null): string {
  return (version && versionColors.value.get(version)) || palette.value.olderVersions;
}

/**
 * Im Kreis ist die einzige Aussage, wie gross der Anteil ist, der schon dort
 * ist, wo er hin soll. Welche Nummer welcher Rest trägt, sagt die Liste
 * darunter.
 */
const agentVersionData = computed(() => ({
  labels: agentVersions.value.map((entry) => entry.version ?? 'unbekannt'),
  datasets: [
    {
      data: agentVersions.value.map((entry) => entry.devices),
      backgroundColor: agentVersions.value.map((entry) => versionColor(entry.version)),
      ...ringGap.value,
    },
  ],
}));

/**
 * Die Gesamthöhe ist die Flotte, und ein Rollout ist die grüne Fläche der
 * aktuellen Version, die wächst.
 *
 * Von unten nach oben: Ältere, dann die benannten Versionen aufsteigend — die
 * neueste liegt obenauf.
 */
const agentVersionTrendData = computed(() => {
  const dates = [...new Set(agentVersionTrend.value.map((point) => point.date))].sort();
  const named = [...versionColors.value.keys()].sort(compareVersions);

  const count = (date: string, match: (version: string) => boolean): number =>
    agentVersionTrend.value
      .filter((point) => point.date === date && match(point.version))
      .reduce((sum, point) => sum + point.devices, 0);

  const older = agentVersionTrend.value.some((point) => !versionColors.value.has(point.version));

  return {
    labels: dates,
    datasets: [
      ...(older
        ? [
            {
              label: 'Ältere',
              data: dates.map((date) => count(date, (version) => !versionColors.value.has(version))),
              backgroundColor: palette.value.olderVersions,
              ...segmentGap.value,
            },
          ]
        : []),
      ...named.map((version) => ({
        label: version === currentVersion.value ? `${version} (aktuell)` : version,
        data: dates.map((date) => count(date, (v) => v === version)),
        backgroundColor: versionColor(version),
        ...segmentGap.value,
      })),
    ],
  };
});

const agentVersionShortfall = computed(() => shortfall(agentVersionTrend.value));

const agentVersionOptions = computed(() =>
  ringOptions((index) => {
    const version = agentVersions.value[index]?.version;
    return version ? { name: 'devices', query: { agentVersion: version } } : null;
  }),
);

/**
 * Jede Quelle hat ihre feste Farbe, im Ring wie im Verlauf, passend zu den
 * Abzeichen: WSUS blau, Dual Scan gelb, Microsoft Update grün. Intune trägt
 * im Abzeichen ebenfalls Grün; im Diagramm bekommt es Violett, weil zwei
 * Quellen nicht dieselbe Farbe tragen dürfen.
 *
 * Die Reihenfolge ist zugleich die des Stapels von unten nach oben — die
 * Ablösung wandert nach oben, Unklares liegt unten. So liegen nur Farben
 * nebeneinander, die auch bei Farbfehlsichtigkeit unterscheidbar bleiben
 * (geprüft, hell wie dunkel).
 */
const SOURCE_ORDER: UpdateSource[] = ['unknown', 'dual_scan', 'wsus', 'microsoft_update', 'intune'];

const SOURCE_SERIES: Record<UpdateSource, number> = {
  unknown: 4,
  dual_scan: 2,
  wsus: 0,
  microsoft_update: 1,
  intune: 3,
};

function sourceColor(source: UpdateSource): string {
  return palette.value.series[SOURCE_SERIES[source]];
}

const sourceDistribution = computed(() =>
  [...(sources.value?.distribution ?? [])].sort(
    (a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source),
  ),
);

const sourceData = computed(() => ({
  labels: sourceDistribution.value.map((entry) => UPDATE_SOURCE_LABELS[entry.source]),
  datasets: [
    {
      data: sourceDistribution.value.map((entry) => entry.devices),
      backgroundColor: sourceDistribution.value.map((entry) => sourceColor(entry.source)),
      ...ringGap.value,
    },
  ],
}));

const sourceOptions = computed(() =>
  ringOptions((index) => {
    const source = sourceDistribution.value[index]?.source;
    return source ? { name: 'devices', query: { updateSource: source } } : null;
  }),
);

const sourceTrendData = computed(() => {
  const dates = [...new Set(sourceTrend.value.map((point) => point.date))].sort();
  const present = SOURCE_ORDER.filter((source) => sourceTrend.value.some((point) => point.source === source));

  return {
    labels: dates,
    datasets: present.map((source) => ({
      label: UPDATE_SOURCE_LABELS[source],
      data: dates.map(
        (date) => sourceTrend.value.find((point) => point.date === date && point.source === source)?.devices ?? 0,
      ),
      backgroundColor: sourceColor(source),
      ...segmentGap.value,
    })),
  };
});

const sourceShortfall = computed(() => shortfall(sourceTrend.value));
const agentShortfall = computed(() => shortfall(agentTrend.value));

const intervalOptions = computed(() =>
  intervalsFor(rangeDays.value).map((value) => ({ value, label: INTERVAL_LABELS[value] })),
);

/** Nur die Verläufe — sie allein hängen an Zeitraum und Intervall. */
async function loadTrends(): Promise<void> {
  const request = { days: rangeDays.value, interval: interval.value };

  try {
    const [t, a, v, s] = await Promise.all([
      get<TrendPoint[]>('/api/reports/trend', request),
      get<AgentTrendPoint[]>('/api/reports/agent-trend', request),
      get<AgentVersionTrendPoint[]>('/api/reports/agent-version-trend', request),
      get<UpdateSourceTrendPoint[]>('/api/reports/update-source-trend', request),
    ]);

    // Eine spätere Auswahl ist schon unterwegs: deren Ergebnis zählt.
    if (request.days !== rangeDays.value || request.interval !== interval.value) {
      return;
    }

    loaded.value = request;
    trend.value = t;
    agentTrend.value = a;
    agentVersionTrend.value = v;
    sourceTrend.value = s;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Die Verläufe konnten nicht geladen werden.';
  }
}

/**
 * Der zuletzt gewählte Zeitraum samt Intervall, je Benutzer im Backend — auf
 * jedem Rechner derselbe. Was nicht (mehr) angeboten wird, bleibt bei der
 * Vorgabe; ein unpassendes Intervall weicht dem des Zeitraums.
 */
async function loadPreference(): Promise<void> {
  try {
    const { dashboard } = await get<UserPreferences>('/api/preferences');
    if (!dashboard || !rangeOptions.some((option) => Number(option.value) === dashboard.rangeDays)) return;

    rangeDays.value = dashboard.rangeDays;
    interval.value = intervalsFor(dashboard.rangeDays).includes(dashboard.interval)
      ? dashboard.interval
      : defaultInterval(dashboard.rangeDays);
  } catch {
    // Ohne gespeicherte Auswahl gilt die Vorgabe; das Dashboard selbst bleibt brauchbar.
  }
}

function savePreference(): void {
  put('/api/preferences', {
    dashboard: { rangeDays: rangeDays.value, interval: interval.value },
  }).catch(() => undefined);
}

/** Ein neuer Zeitraum bringt sein passendes Intervall mit; ändern lässt es sich danach. */
function onRangeChange(value: unknown): void {
  rangeDays.value = Number(value) || 90;
  interval.value = defaultInterval(rangeDays.value);
  savePreference();
  void loadTrends();
}

function onIntervalChange(value: unknown): void {
  interval.value = value as TrendInterval;
  savePreference();
  void loadTrends();
}

async function load(): Promise<void> {
  try {
    const [s, v, src] = await Promise.all([
      get<Summary>('/api/reports/summary'),
      get<AgentVersionCount[]>('/api/reports/agent-versions'),
      get<UpdateSourcesReport>('/api/reports/update-sources'),
      loadPreference(),
    ]);

    summary.value = s;
    agentVersions.value = v;
    sources.value = src;

    await loadTrends();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Das Dashboard konnte nicht geladen werden.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="mx-auto max-w-[1600px] px-5 py-6">
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-xl font-semibold">Dashboard</h1>

      <div class="flex flex-wrap items-center gap-2">
        <span class="text-muted-foreground text-sm">Zeitraum</span>
        <Select :model-value="String(rangeDays)" @update:model-value="onRangeChange">
          <SelectTrigger class="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="option in rangeOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </SelectItem>
          </SelectContent>
        </Select>
        <span class="text-muted-foreground ml-2 text-sm">Intervall</span>
        <Select
          :model-value="interval"
          :disabled="intervalOptions.length < 2"
          @update:model-value="onIntervalChange"
        >
          <SelectTrigger class="w-36" aria-label="Intervall"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="option in intervalOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>

    <Alert v-if="error" variant="destructive" class="mb-4">
      <AlertDescription>{{ error }}</AlertDescription>
    </Alert>

    <div class="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <template v-if="loading">
        <Skeleton v-for="n in 6" :key="n" class="h-[6.5rem]" />
      </template>

      <Card
        v-for="tile in tiles"
        :key="tile.label"
        class="hover:bg-accent/40 cursor-pointer border-l-4 py-4 transition-colors"
        :class="TONE_BORDERS[tile.tone]"
        @click="router.push(tile.to)"
      >
        <CardContent class="px-4">
          <div class="tabular text-3xl leading-none font-semibold">{{ tile.value }}</div>
          <div class="mt-1.5 text-sm">{{ tile.label }}</div>
          <div class="text-muted-foreground mt-0.5 text-xs">{{ tile.hint }}</div>
        </CardContent>
      </Card>
    </div>

    <!-- Je Thema links der heutige Stand als Ring, rechts der Verlauf. -->
    <div class="grid gap-3 xl:grid-cols-3">
      <Card class="xl:col-span-3">
        <CardHeader>
          <CardTitle>Offene Updates über die Zeit</CardTitle>
          <CardDescription>
            Gezählt je Gerät: Ein Update, das auf fünf Geräten fehlt, zählt fünfmal. Die Kurve ist
            aus dem heutigen Stand rückwärts aus der Zeitreihe rekonstruiert und fällt nicht nur
            durch Installationen — ein Update verschwindet auch, wenn es abgelöst oder ausgeblendet
            wird. „Installiert" zählt jede Installation einmal, auch von Updates, die nie als offen
            erfasst waren, etwa Definitionsupdates, die Windows zwischen zwei Meldungen selbst
            einspielt. Reicht die Kurve weiter zurück als die Aufbewahrungsfrist, wird sie flach;
            dann fehlen die Ereignisse, nicht die Updates.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChartCanvas type="line" :data="trendData" :options="trendOptions" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-1.5">
            Update-Quellen
            <SourceLegend />
          </CardTitle>
          <CardDescription>
            Geräte je Quelle — der Stand der WSUS-Ablösung. Ein Klick auf ein Stück zeigt die
            zugehörigen Geräte.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChartCanvas type="doughnut" :data="sourceData" :options="sourceOptions" height="16rem" />
        </CardContent>
      </Card>

      <Card class="xl:col-span-2">
        <CardHeader>
          <CardTitle>Update-Quellen über die Zeit</CardTitle>
          <CardDescription>
            Die Quelle, die jedes registrierte Gerät bis zum Ende des Abschnitts zuletzt gemeldet
            hat. Eine Ablösung zeigt sich als Fläche, die von WSUS nach oben zu Microsoft Update
            oder Intune wandert.
            <template v-if="sourceShortfall">
              Gezeigt werden {{ sourceShortfall.shown }} statt {{ sourceShortfall.requested }}:
              Weiter zurück reichen die aufbewahrten Check-ins nicht.
            </template>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p v-if="sourceTrend.length === 0" class="text-muted-foreground text-sm">
            Noch keine Check-ins im gewählten Zeitraum.
          </p>
          <ChartCanvas v-else type="bar" :data="sourceTrendData" :options="stackedOptions" height="18rem" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Agent-Abdeckung</CardTitle>
          <CardDescription>
            Heute, aus denselben Zahlen wie die Kacheln oben. Ein Klick auf ein Stück zeigt die
            zugehörigen Geräte.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChartCanvas type="doughnut" :data="coverageData" :options="coverageOptions" height="16rem" />
        </CardContent>
      </Card>

      <Card class="xl:col-span-2">
        <CardHeader>
          <CardTitle>Agent-Abdeckung über die Zeit</CardTitle>
          <CardDescription>
            Der Bestand am Ende jedes Abschnitts, aufgeteilt nach Zustand — aus den Zeitpunkten
            am Gerät und der Check-in-Historie gemessen, nicht geschätzt.
            <template v-if="agentShortfall">
              Gezeigt werden {{ agentShortfall.shown }} statt {{ agentShortfall.requested }}: Weiter zurück
              liesse sich „stumm" nicht mehr belegen, weil die Check-ins der Aufbewahrungsfrist
              unterliegen.
            </template>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChartCanvas type="bar" :data="agentTrendData" :options="stackedOptions" height="18rem" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Agent-Versionen</CardTitle>
          <CardDescription>
            Was auf den aktiven Geräten läuft. Ein Klick auf ein Stück oder eine Zeile zeigt die
            zugehörigen Geräte; ausgerollt wird unter Einstellungen → Agent-Versionen.
          </CardDescription>
        </CardHeader>

        <CardContent class="space-y-3">
          <p v-if="agentVersions.length === 0" class="text-muted-foreground text-sm">
            Noch kein Gerät hat eine Version gemeldet.
          </p>

          <template v-else>
            <ChartCanvas
              type="doughnut"
              :data="agentVersionData"
              :options="agentVersionOptions"
              height="13rem"
            />

            <!-- Die Liste bleibt: Der Kreis zeigt den Anteil, die genaue Zahl
                 und welche Version die aktuelle ist steht hier. -->
            <div class="space-y-1">
              <div
                v-for="entry in agentVersions"
                :key="entry.version ?? 'unbekannt'"
                class="flex items-baseline justify-between gap-2 text-sm"
                :class="entry.version ? 'hover:text-foreground cursor-pointer' : ''"
                @click="
                  entry.version &&
                    router.push({ name: 'devices', query: { agentVersion: entry.version } })
                "
              >
                <span class="flex items-center gap-2">
                  <span class="tabular font-medium">{{ entry.version ?? 'unbekannt' }}</span>
                  <Badge
                    v-if="entry.isCurrent"
                    variant="outline"
                    class="bg-success/15 text-success border-success/30"
                  >
                    aktuell
                  </Badge>
                </span>
                <span class="text-muted-foreground tabular">{{ entry.devices }}</span>
              </div>
            </div>
          </template>
        </CardContent>
      </Card>

      <Card class="xl:col-span-2">
        <CardHeader>
          <CardTitle>Agent-Versionen über die Zeit</CardTitle>
          <CardDescription>
            Welche Version am Ende jedes Abschnitts lief — die zuletzt gemeldete jedes registrierten
            Geräts. Ein Rollout zeigt sich als grüne Fläche, die wächst. Die aktuelle und die fünf
            neuesten übrigen Versionen sind einzeln aufgeführt, je neuer, desto kräftiger; alles
            davor steht unter „Ältere".
            <template v-if="agentVersionShortfall">
              Gezeigt werden {{ agentVersionShortfall.shown }} statt
              {{ agentVersionShortfall.requested }}: Weiter zurück reichen die aufbewahrten Check-ins
              nicht.
            </template>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p v-if="agentVersionTrend.length === 0" class="text-muted-foreground text-sm">
            Noch keine Check-ins im gewählten Zeitraum.
          </p>
          <ChartCanvas
            v-else
            type="bar"
            :data="agentVersionTrendData"
            :options="stackedOptions"
            height="18rem"
          />
        </CardContent>
      </Card>
    </div>
  </div>
</template>
