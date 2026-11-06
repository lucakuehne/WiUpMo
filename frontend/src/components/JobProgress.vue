<script setup lang="ts">
import { computed } from 'vue';

/**
 * Wie weit ein Sammelauftrag ist: ein Balken aus den Aufträgen je Zustand,
 * darunter dieselben Zahlen als Text. Die Farben sind die der
 * Zustandsabzeichen; gelesen wird der Text, der Punkt davor ordnet ihn dem
 * Balken zu.
 *
 * Für Installationen wie für das Ausrollen von Agent-Versionen — beide geben
 * ihre Zustände in der Reihenfolge, in der sie im Balken stehen sollen.
 */
interface ProgressSegment {
  key: string;
  count: number;
  label: string;
  /** Hintergrundklasse des Segments, etwa `bg-success`. */
  class: string;
}

const props = defineProps<{ segments: ProgressSegment[] }>();

const visible = computed(() => props.segments.filter((segment) => segment.count > 0));

const summary = computed(() =>
  visible.value.map((segment) => `${segment.count} ${segment.label}`).join(', '),
);
</script>

<template>
  <div v-if="visible.length > 0" class="min-w-40">
    <div class="flex h-1.5 w-full gap-0.5" role="img" :aria-label="summary">
      <span
        v-for="segment in visible"
        :key="segment.key"
        class="h-full basis-0 first:rounded-l-full last:rounded-r-full"
        :class="segment.class"
        :style="{ flexGrow: segment.count }"
      />
    </div>
    <div class="text-muted-foreground mt-1.5 flex flex-wrap gap-x-2.5 gap-y-0.5 text-xs">
      <span v-for="segment in visible" :key="segment.key" class="flex items-center gap-1">
        <span class="size-2 shrink-0 rounded-full" :class="segment.class" />
        <span class="tabular">{{ segment.count }} {{ segment.label }}</span>
      </span>
    </div>
  </div>
  <span v-else class="text-muted-foreground">—</span>
</template>
