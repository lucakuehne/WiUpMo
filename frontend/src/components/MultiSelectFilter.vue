<script setup lang="ts">
import { ChevronDown } from '@lucide/vue';
import { computed } from 'vue';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * Filter mit Mehrfachauswahl. Nichts gewählt heisst: keine Einschränkung.
 *
 * Das Menü bleibt beim Ankreuzen offen — wer drei Werte will, soll es nicht
 * dreimal öffnen müssen. Die Auswahl kommt in der Reihenfolge der Optionen
 * zurück, nicht in der des Anklickens: So bleibt die Adresse der Liste
 * dieselbe, egal wie man dahin kam.
 */
const props = defineProps<{
  /** Steht im Knopf, solange nichts gewählt ist, und davor, wenn mehreres gewählt ist. */
  placeholder: string;
  options: Array<{ value: string; label: string }>;
  modelValue: string[];
  class?: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [string[]] }>();

const label = computed(() => {
  const chosen = props.options.filter((option) => props.modelValue.includes(option.value));
  if (chosen.length === 0) return props.placeholder;
  if (chosen.length === 1) return chosen[0].label;
  return `${props.placeholder}: ${chosen.length}`;
});

function toggle(value: string, checked: boolean): void {
  const next = new Set(props.modelValue);
  if (checked) next.add(value);
  else next.delete(value);
  emit(
    'update:modelValue',
    props.options.map((option) => option.value).filter((option) => next.has(option)),
  );
}
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button
        variant="outline"
        :class="
          cn(
            'w-48 justify-between font-normal',
            modelValue.length === 0 ? 'text-muted-foreground' : '',
            props.class,
          )
        "
        :aria-label="placeholder"
      >
        <span class="truncate">{{ label }}</span>
        <ChevronDown class="size-4 opacity-50" />
      </Button>
    </DropdownMenuTrigger>

    <DropdownMenuContent align="start" class="max-h-80 w-56 overflow-auto">
      <DropdownMenuCheckboxItem
        v-for="option in options"
        :key="option.value"
        :model-value="modelValue.includes(option.value)"
        @update:model-value="toggle(option.value, $event === true)"
        @select.prevent
      >
        {{ option.label }}
      </DropdownMenuCheckboxItem>

      <template v-if="modelValue.length > 0">
        <DropdownMenuSeparator />
        <DropdownMenuItem @select="emit('update:modelValue', [])">Auswahl aufheben</DropdownMenuItem>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
