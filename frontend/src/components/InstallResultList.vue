<script setup lang="ts">
import type { InstallJobUpdateResult } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import HresultCell from '@/components/HresultCell.vue';

/** Was ein Agent je Update zurückgemeldet hat — aufgeklappt unter einem Auftrag. */
defineProps<{ results: InstallJobUpdateResult[] }>();

/** Ergebniscodes von Windows Update: 2 erfolgreich, 3 mit Fehlern, 4 gescheitert, 5 abgebrochen. */
function badge(result: InstallJobUpdateResult): { label: string; class: string } {
  if (!result.offered) return { label: 'nicht angeboten', class: 'text-muted-foreground' };
  if (result.resultCode === 2 || result.resultCode === 3) {
    return { label: 'installiert', class: 'bg-success/15 text-success border-success/30' };
  }
  if (result.resultCode === 5) return { label: 'abgebrochen', class: 'text-muted-foreground' };
  return { label: 'gescheitert', class: 'bg-destructive/15 text-destructive border-destructive/30' };
}
</script>

<template>
  <ul class="space-y-1.5 pl-6 text-sm">
    <li
      v-for="result in results"
      :key="result.updateId"
      class="flex flex-wrap items-center gap-x-3 gap-y-1"
    >
      <Badge variant="outline" :class="badge(result).class">
        {{ badge(result).label }}
      </Badge>
      <span class="tabular w-24 shrink-0">
        {{ result.kbArticle ? `KB${result.kbArticle}` : '—' }}
      </span>
      <span>{{ result.title ?? result.updateId }}</span>
      <span v-if="result.rebootRequired" class="text-warning-foreground dark:text-warning text-xs">
        Neustart nötig
      </span>
      <HresultCell v-if="result.hresult" :value="result.hresult" />
    </li>
  </ul>
</template>
