<script setup lang="ts">
import { computed } from 'vue';
import type { InstallJobState } from '@/api/types';
import JobProgress from '@/components/JobProgress.vue';
import { INSTALL_JOB_STATE_LABELS } from '@/format';

/** Der Fortschritt einer Installation, in den Farben der Zustandsabzeichen. */
const props = defineProps<{ states: Record<InstallJobState, number> }>();

/** Abgeschlossenes zuerst, dann was läuft, dann was noch wartet; Verfallenes und Abgebrochenes zuletzt. */
const ORDER: InstallJobState[] = ['done', 'failed', 'running', 'delivered', 'pending', 'expired', 'cancelled'];

const SEGMENT_CLASS: Record<InstallJobState, string> = {
  done: 'bg-success',
  failed: 'bg-destructive',
  running: 'bg-warning',
  delivered: 'bg-chart-4',
  pending: 'bg-chart-1',
  expired: 'bg-muted-foreground/40',
  cancelled: 'bg-muted-foreground/25',
};

const segments = computed(() =>
  ORDER.map((state) => ({
    key: state,
    count: props.states[state],
    label: INSTALL_JOB_STATE_LABELS[state],
    class: SEGMENT_CLASS[state],
  })),
);
</script>

<template>
  <JobProgress :segments="segments" />
</template>
