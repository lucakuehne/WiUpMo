<script setup lang="ts">
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from '@lucide/vue';
import { computed } from 'vue';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * Seitenwechsel für serverseitig geblätterte Tabellen.
 *
 * Die Anzeige „21–40 von 137" statt nur „Seite 2 von 7": Sie beantwortet die
 * Frage, wie viele Einträge es überhaupt gibt, und die stellt man häufiger als
 * die nach der Seitenzahl.
 */
const props = defineProps<{
  page: number;
  limit: number;
  total: number;
  pageSizes?: number[];
}>();

const emit = defineEmits<{ 'update:page': [number]; 'update:limit': [number] }>();

const pageCount = computed(() => Math.max(1, Math.ceil(props.total / props.limit)));
const first = computed(() => (props.total === 0 ? 0 : (props.page - 1) * props.limit + 1));
const last = computed(() => Math.min(props.page * props.limit, props.total));

function goTo(page: number): void {
  emit('update:page', Math.min(Math.max(1, page), pageCount.value));
}
</script>

<template>
  <div class="flex flex-wrap items-center justify-between gap-3 px-1 py-2 text-sm">
    <span class="text-muted-foreground tabular">
      <template v-if="total === 0">Keine Einträge</template>
      <template v-else>{{ first }}–{{ last }} von {{ total }}</template>
    </span>

    <div class="flex items-center gap-3">
      <div class="flex items-center gap-2">
        <span class="text-muted-foreground">Pro Seite</span>
        <Select
          :model-value="String(limit)"
          @update:model-value="emit('update:limit', Number($event))"
        >
          <SelectTrigger class="h-8 w-[4.5rem]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="size in pageSizes ?? [25, 50, 100]" :key="size" :value="String(size)">
              {{ size }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="flex items-center gap-1">
        <Button variant="outline" size="icon" class="size-8" :disabled="page <= 1" @click="goTo(1)">
          <ChevronsLeft class="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          class="size-8"
          :disabled="page <= 1"
          @click="goTo(page - 1)"
        >
          <ChevronLeft class="size-4" />
        </Button>

        <span class="text-muted-foreground tabular px-2">{{ page }} / {{ pageCount }}</span>

        <Button
          variant="outline"
          size="icon"
          class="size-8"
          :disabled="page >= pageCount"
          @click="goTo(page + 1)"
        >
          <ChevronRight class="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          class="size-8"
          :disabled="page >= pageCount"
          @click="goTo(pageCount)"
        >
          <ChevronsRight class="size-4" />
        </Button>
      </div>
    </div>
  </div>
</template>
