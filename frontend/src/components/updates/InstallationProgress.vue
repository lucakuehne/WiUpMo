<script setup lang="ts">
import { computed } from 'vue';
import type { InstallJobState } from '@/api/types';
import { INSTALL_JOB_STATE_LABELS } from '@/format';

/**
 * Wie weit eine Installation ist: ein Balken aus den Aufträgen je Zustand,
 * darunter dieselben Zahlen als Text. Die Farben sind die der Zustandsabzeichen;
 * gelesen wird der Text, der Punkt davor ordnet ihn dem Balken zu.
 */
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
  ORDER.filter((state) => props.states[state] > 0).map((state) => ({
    state,
    count: props.states[state],
    label: `${props.states[state]} ${INSTALL_JOB_STATE_LABELS[state]}`,
  })),
);

const summary = computed(() => segments.value.map((segment) => segment.label).join(', '));
</script>

<template>
  <div v-if="segments.length > 0" class="min-w-40">
    <div class="flex h-1.5 w-full gap-0.5" role="img" :aria-label="summary">
      <span
        v-for="segment in segments"
        :key="segment.state"
        class="h-full basis-0 first:rounded-l-full last:rounded-r-full"
        :class="SEGMENT_CLASS[segment.state]"
        :style="{ flexGrow: segment.count }"
      />
    </div>
    <div class="text-muted-foreground mt-1.5 flex flex-wrap gap-x-2.5 gap-y-0.5 text-xs">
      <span v-for="segment in segments" :key="segment.state" class="flex items-center gap-1">
        <span class="size-2 shrink-0 rounded-full" :class="SEGMENT_CLASS[segment.state]" />
        <span class="tabular">{{ segment.label }}</span>
      </span>
    </div>
  </div>
  <span v-else class="text-muted-foreground">—</span>
</template>
