<script setup lang="ts">
import Card from 'primevue/card';
import Chart from 'primevue/chart';
import Message from 'primevue/message';
import Skeleton from 'primevue/skeleton';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { get } from '@/api/client';
import type { Summary, TrendPoint, UpdateSourcesReport } from '@/api/types';
import { UPDATE_SOURCE_LABELS } from '@/format';

const router = useRouter();

const summary = ref<Summary | null>(null);
const trend = ref<TrendPoint[]>([]);
const sources = ref<UpdateSourcesReport | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

/**
 * Farben aus den PrimeVue-Variablen statt fest verdrahtet — so stimmen sie in
 * beiden Erscheinungsbildern, hell und dunkel.
 */
function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

const tiles = computed(() => {
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
      to: { name: 'devices', query: { withoutAgent: '1' } },
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

const trendData = computed(() => ({
  labels: trend.value.map((point) => point.date.slice(5)),
  datasets: [
    {
      label: 'Offene Updates (Flotte)',
      data: trend.value.map((point) => point.openUpdates),
      borderColor: cssVar('--p-primary-500', '#3b82f6'),
      backgroundColor: 'transparent',
      tension: 0.3,
      pointRadius: 0,
      yAxisID: 'y',
    },
    {
      label: 'Installiert pro Tag',
      data: trend.value.map((point) => point.installed),
      borderColor: cssVar('--p-green-500', '#22c55e'),
      backgroundColor: cssVar('--p-green-500', '#22c55e'),
      type: 'bar',
      yAxisID: 'y2',
    },
  ],
}));

const trendOptions = computed(() => ({
  maintainAspectRatio: false,
  interaction: { mode: 'index' as const, intersect: false },
  plugins: { legend: { labels: { color: cssVar('--p-text-color', '#333') } } },
  scales: {
    x: {
      ticks: { color: cssVar('--p-text-muted-color', '#888'), maxTicksLimit: 12 },
      grid: { display: false },
    },
    y: {
      position: 'left' as const,
      beginAtZero: true,
      title: { display: true, text: 'offen', color: cssVar('--p-text-muted-color', '#888') },
      ticks: { color: cssVar('--p-text-muted-color', '#888') },
    },
    y2: {
      position: 'right' as const,
      beginAtZero: true,
      title: { display: true, text: 'installiert', color: cssVar('--p-text-muted-color', '#888') },
      ticks: { color: cssVar('--p-text-muted-color', '#888') },
      grid: { display: false },
    },
  },
}));

const sourceData = computed(() => {
  const distribution = sources.value?.distribution ?? [];
  return {
    labels: distribution.map((entry) => UPDATE_SOURCE_LABELS[entry.source]),
    datasets: [
      {
        data: distribution.map((entry) => entry.devices),
        backgroundColor: [
          cssVar('--p-blue-500', '#3b82f6'),
          cssVar('--p-green-500', '#22c55e'),
          cssVar('--p-orange-500', '#f97316'),
          cssVar('--p-purple-500', '#a855f7'),
          cssVar('--p-surface-400', '#9ca3af'),
        ],
      },
    ],
  };
});

const sourceOptions = computed(() => ({
  maintainAspectRatio: false,
  plugins: {
    legend: { position: 'right' as const, labels: { color: cssVar('--p-text-color', '#333') } },
  },
}));

async function load(): Promise<void> {
  try {
    const [s, t, src] = await Promise.all([
      get<Summary>('/api/reports/summary'),
      get<TrendPoint[]>('/api/reports/trend', { days: 90 }),
      get<UpdateSourcesReport>('/api/reports/update-sources'),
    ]);
    summary.value = s;
    trend.value = t;
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
  <div class="page">
    <div class="page-header">
      <h1>Dashboard</h1>
    </div>

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <div class="tiles">
      <template v-if="loading">
        <Skeleton v-for="n in 6" :key="n" height="6rem" />
      </template>

      <Card
        v-for="tile in tiles"
        :key="tile.label"
        :class="['tile', `tone-${tile.tone}`]"
        @click="router.push(tile.to)"
      >
        <template #content>
          <div class="tile-value">{{ tile.value }}</div>
          <div class="tile-label">{{ tile.label }}</div>
          <div class="tile-hint muted">{{ tile.hint }}</div>
        </template>
      </Card>
    </div>

    <div class="charts">
      <Card>
        <template #title>Offene Updates über die Zeit</template>
        <template #subtitle>
          Aus dem heutigen Stand rückwärts aus der Zeitreihe rekonstruiert. Reicht die Kurve
          weiter zurück als die Aufbewahrungsfrist, wird sie flach — dann fehlen die Ereignisse,
          nicht die Updates.
        </template>
        <template #content>
          <Chart type="line" :data="trendData" :options="trendOptions" style="height: 20rem" />
        </template>
      </Card>

      <Card>
        <template #title>Update-Quellen</template>
        <template #subtitle>Geräte je Quelle — der Stand der WSUS-Ablösung.</template>
        <template #content>
          <Chart type="doughnut" :data="sourceData" :options="sourceOptions" style="height: 20rem" />
        </template>
      </Card>
    </div>
  </div>
</template>

<style scoped>
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
  gap: 0.75rem;
  margin-bottom: 1.25rem;
}

.tile {
  cursor: pointer;
  border-left: 4px solid var(--p-surface-300);
}

.tile:hover {
  border-left-color: var(--p-primary-500);
}

.tile-value {
  font-size: 2rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}

.tile-label {
  font-size: 0.9rem;
  margin-top: 0.25rem;
}

.tile-hint {
  font-size: 0.75rem;
  margin-top: 0.15rem;
}

/* Farbe nur als Rahmen links, nicht als Flaeche: Sechs bunte Kacheln
   nebeneinander tragen keine Information mehr — auffaellig soll nur sein, was
   Aufmerksamkeit braucht. */
.tone-danger {
  border-left-color: var(--p-red-500);
}

.tone-warn {
  border-left-color: var(--p-orange-500);
}

.tone-ok {
  border-left-color: var(--p-green-500);
}

.charts {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 0.75rem;
}

@media (max-width: 60rem) {
  .charts {
    grid-template-columns: 1fr;
  }
}
</style>
