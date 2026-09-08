<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter, type RouteLocationRaw } from 'vue-router';
import { get } from '@/api/client';
import type {
  AgentTrendPoint,
  AgentVersionCount,
  Summary,
  TrendPoint,
  UpdateSourcesReport,
} from '@/api/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import ChartCanvas from '@/components/ChartCanvas.vue';
import SourceLegend from '@/components/SourceLegend.vue';
import { baseOptions, palette } from '@/chart';
import { UPDATE_SOURCE_LABELS } from '@/format';

const router = useRouter();

const summary = ref<Summary | null>(null);
const trend = ref<TrendPoint[]>([]);
const agentTrend = ref<AgentTrendPoint[]>([]);
const agentVersions = ref<AgentVersionCount[]>([]);
const sources = ref<UpdateSourcesReport | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

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

const trendData = computed(() => ({
  labels: trend.value.map((point) => point.date.slice(5)),
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
      label: 'Installiert pro Tag',
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
  scales: {
    x: {
      ticks: { color: palette.value.muted, maxTicksLimit: 12 },
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
 * Gestapelt, nicht nebeneinander: Die drei Werte sind Teile desselben
 * Bestandes. Die Gesamthöhe zeigt die Flotte, und wie sich die Fläche von rot
 * über gelb nach grün verschiebt, ist genau der Fortschritt des Rollouts.
 *
 * Reihenfolge von unten: aktiv, stumm, ohne Agent — das Erfreuliche als
 * Sockel, das zu Erledigende obenauf.
 */
const agentTrendData = computed(() => ({
  labels: agentTrend.value.map((point) => point.date.slice(5)),
  datasets: [
    {
      label: 'Mit Agent, meldet sich',
      data: agentTrend.value.map((point) => point.activeAgents),
      backgroundColor: palette.value.series[1],
    },
    {
      label: `Mit Agent, stumm (> ${summary.value?.staleAgentDays ?? 14} T)`,
      data: agentTrend.value.map((point) => point.silentAgents),
      backgroundColor: palette.value.series[2],
    },
    {
      label: 'Ohne Agent',
      data: agentTrend.value.map((point) => point.withoutAgent),
      backgroundColor: palette.value.series[5],
    },
  ],
}));

const agentTrendOptions = computed(() => ({
  ...baseOptions.value,
  interaction: { mode: 'index' as const, intersect: false },
  scales: {
    x: {
      stacked: true,
      ticks: { color: palette.value.muted, maxTicksLimit: 12 },
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

/**
 * Die aktuelle Version bekommt Grün, die übrigen die Reihenfolge der Palette.
 *
 * Das ist die einzige Aussage, die im Kreis überhaupt zu treffen ist: Wie gross
 * ist der Anteil, der schon dort ist, wo er hin soll. Welche Nummer welcher
 * Rest trägt, sagt die Liste darunter.
 */
const agentVersionData = computed(() => ({
  labels: agentVersions.value.map((entry) => entry.version ?? 'unbekannt'),
  datasets: [
    {
      data: agentVersions.value.map((entry) => entry.devices),
      backgroundColor: agentVersions.value.map((entry, index) =>
        entry.isCurrent ? palette.value.series[1] : palette.value.series[(index % 4) + 2],
      ),
      borderWidth: 0,
    },
  ],
}));

const agentVersionOptions = computed(() => ({
  ...baseOptions.value,
  plugins: {
    legend: { position: 'bottom' as const, labels: { color: palette.value.text, boxWidth: 12 } },
  },
}));

const sourceData = computed(() => {
  const distribution = sources.value?.distribution ?? [];

  return {
    labels: distribution.map((entry) => UPDATE_SOURCE_LABELS[entry.source]),
    datasets: [
      {
        data: distribution.map((entry) => entry.devices),
        backgroundColor: palette.value.series,
        borderWidth: 0,
      },
    ],
  };
});

const sourceOptions = computed(() => ({
  ...baseOptions.value,
  plugins: {
    legend: { position: 'right' as const, labels: { color: palette.value.text } },
  },
}));

async function load(): Promise<void> {
  try {
    const [s, t, a, v, src] = await Promise.all([
      get<Summary>('/api/reports/summary'),
      get<TrendPoint[]>('/api/reports/trend', { days: 90 }),
      // 30 Tage, nicht 90: Die Einstufung „stumm" hängt an der
      // Check-in-Historie, und die unterliegt der Aufbewahrungsfrist. Innerhalb
      // eines Monats ist der Verlauf belastbar.
      get<AgentTrendPoint[]>('/api/reports/agent-trend', { days: 30 }),
      get<AgentVersionCount[]>('/api/reports/agent-versions'),
      get<UpdateSourcesReport>('/api/reports/update-sources'),
    ]);

    summary.value = s;
    trend.value = t;
    agentTrend.value = a;
    agentVersions.value = v;
    sources.value = src;
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
    <h1 class="mb-4 text-xl font-semibold">Dashboard</h1>

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

    <div class="grid gap-3 xl:grid-cols-3">
      <Card class="xl:col-span-2">
        <CardHeader>
          <CardTitle>Offene Updates über die Zeit</CardTitle>
          <CardDescription>
            Aus dem heutigen Stand rückwärts aus der Zeitreihe rekonstruiert. Die Kurve fällt nicht
            nur durch Installationen — ein Update verschwindet auch, wenn es abgelöst oder
            ausgeblendet wird. Reicht die Kurve weiter zurück als die Aufbewahrungsfrist, wird sie
            flach; dann fehlen die Ereignisse, nicht die Updates.
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
          <CardDescription>Geräte je Quelle — der Stand der WSUS-Ablösung.</CardDescription>
        </CardHeader>
        <CardContent>
          <ChartCanvas type="doughnut" :data="sourceData" :options="sourceOptions" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Agent-Versionen</CardTitle>
          <CardDescription>
            Was auf den aktiven Geräten läuft. Ausrollen unter Einstellungen → Agent-Versionen.
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
          <CardTitle>Agent-Abdeckung über die Zeit</CardTitle>
          <CardDescription>
            Der Bestand an jedem Tag, aufgeteilt nach Zustand — aus den Zeitpunkten am Gerät und
            der Check-in-Historie gemessen, nicht geschätzt. Gezeigt werden 30 Tage: Weiter zurück
            liesse sich „stumm" nicht mehr belegen, weil die Check-ins der Aufbewahrungsfrist
            unterliegen.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChartCanvas type="bar" :data="agentTrendData" :options="agentTrendOptions" height="18rem" />
        </CardContent>
      </Card>
    </div>
  </div>
</template>
