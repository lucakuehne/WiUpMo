<script setup lang="ts">
import { ArrowDown, ArrowUp, ChevronsUpDown } from '@lucide/vue';
import { computed } from 'vue';
import { TableHead } from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * Sortierbare Kopfzelle.
 *
 * Sortiert wird serverseitig — die Komponente hält deshalb keinen eigenen
 * Zustand, sondern meldet nur, welches Feld angeklickt wurde. Ein Klick auf
 * das bereits sortierte Feld dreht die Richtung um.
 */
const props = defineProps<{
  field: string;
  sortBy: string;
  sortDir: 'asc' | 'desc';
  /** Zahlenspalten stehen rechts, damit Grössenordnungen vergleichbar bleiben. */
  numeric?: boolean;
  class?: string;
}>();

const emit = defineEmits<{ sort: [field: string, dir: 'asc' | 'desc'] }>();

const isActive = computed(() => props.sortBy === props.field);

function onClick(): void {
  emit('sort', props.field, isActive.value && props.sortDir === 'asc' ? 'desc' : 'asc');
}
</script>

<template>
  <TableHead :class="cn(numeric ? 'text-right' : '', props.class)">
    <button
      type="button"
      class="hover:text-foreground inline-flex items-center gap-1 transition-colors"
      :class="[isActive ? 'text-foreground font-medium' : 'text-muted-foreground', numeric ? 'flex-row-reverse' : '']"
      @click="onClick"
    >
      <slot />
      <ArrowUp v-if="isActive && sortDir === 'asc'" class="size-3.5" />
      <ArrowDown v-else-if="isActive" class="size-3.5" />
      <ChevronsUpDown v-else class="size-3.5 opacity-40" />
    </button>

    <!-- Ausserhalb des Knopfes: Was hier steht, soll anklickbar sein, ohne
         dabei die Sortierung umzustellen. -->
    <span v-if="$slots.after" class="ml-1 inline-flex align-middle"><slot name="after" /></span>
  </TableHead>
</template>
