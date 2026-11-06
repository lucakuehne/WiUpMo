<script setup lang="ts">
import type { RestartEvent } from '@/api/types';
import { formatDateTime } from '@/format';

/** Der Verlauf eines Neustart-Auftrags: was der Agent wann gemeldet hat. */
defineProps<{ events: RestartEvent[] }>();

function describe(event: RestartEvent): string {
  switch (event.state) {
    case 'delivered':
      return 'Vom Gerät abgeholt';
    case 'notified':
      return event.note ? `Gemeldet (${event.note})` : 'Meldung gezeigt';
    case 'deferred':
      return `Verschoben bis ${formatDateTime(event.until ?? null)}`;
    case 'restarting':
      return event.note ? `Neustart eingeleitet (${event.note})` : 'Neustart eingeleitet';
    case 'done':
      return 'Neu gestartet';
    case 'failed':
      return `Gescheitert${event.note ? `: ${event.note}` : ''}`;
    case 'expired':
      return 'Verfallen, nicht abgeholt';
    case 'cancelled':
      return 'Abgebrochen';
    default:
      return event.state;
  }
}
</script>

<template>
  <ol class="space-y-1 pl-6 text-sm">
    <li v-for="(event, index) in events" :key="index" class="flex flex-wrap gap-x-3">
      <span class="text-muted-foreground tabular w-36 shrink-0">{{ formatDateTime(event.at) }}</span>
      <span>{{ describe(event) }}</span>
      <span v-if="event.user" class="text-muted-foreground">{{ event.user }}</span>
    </li>
  </ol>
</template>
