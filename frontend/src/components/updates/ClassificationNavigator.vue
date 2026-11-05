<script setup lang="ts">
import { Layers } from '@lucide/vue';
import { computed } from 'vue';
import type { UpdateClassification, UpdateClassificationCount } from '@/api/types';
import { UPDATE_CLASSIFICATION_LABELS } from '@/format';

/**
 * Die Update-Typen neben dem Katalog, wie die Organisationseinheiten neben
 * den Geräten. Gezählt wird unter den übrigen Filtern; Typen ohne Treffer
 * fallen weg, außer dem gewählten — sonst verschwände die Auswahl, die man
 * gerade getroffen hat.
 */
const props = defineProps<{
  modelValue: UpdateClassification | null;
  counts: UpdateClassificationCount[];
}>();

const emit = defineEmits<{ 'update:modelValue': [UpdateClassification | null] }>();

const total = computed(() => props.counts.reduce((sum, entry) => sum + entry.updates, 0));

const visible = computed(() =>
  props.counts.filter((entry) => entry.updates > 0 || entry.classification === props.modelValue),
);
</script>

<template>
  <div class="rounded-md border">
    <div class="text-muted-foreground flex items-center gap-2 border-b px-3 py-2 text-xs font-medium">
      <Layers class="size-3.5" />
      Update-Typen
    </div>

    <div class="p-1">
      <button
        type="button"
        class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm"
        :class="modelValue === null ? 'bg-accent text-accent-foreground font-medium' : 'hover:bg-accent/50'"
        @click="emit('update:modelValue', null)"
      >
        <span class="flex-1 truncate">Alle Typen</span>
        <span class="text-muted-foreground tabular text-xs">{{ total }}</span>
      </button>

      <button
        v-for="entry in visible"
        :key="entry.classification"
        type="button"
        class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm"
        :class="
          modelValue === entry.classification
            ? 'bg-accent text-accent-foreground font-medium'
            : 'hover:bg-accent/50'
        "
        @click="emit('update:modelValue', entry.classification)"
      >
        <span class="flex-1 truncate">{{ UPDATE_CLASSIFICATION_LABELS[entry.classification] }}</span>
        <span class="text-muted-foreground tabular text-xs">{{ entry.updates }}</span>
      </button>

      <div v-if="counts.length > 0 && total === 0" class="text-muted-foreground px-2 py-3 text-xs">
        Kein Update passt zu den Filtern.
      </div>
    </div>
  </div>
</template>
