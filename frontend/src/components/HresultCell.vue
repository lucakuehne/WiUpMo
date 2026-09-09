<script setup lang="ts">
import { computed } from 'vue';
import { describeHresult, formatHresultCode } from '@/hresult';

/**
 * Ein Fehlercode mit seiner Bedeutung darunter.
 *
 * Als eigene Komponente, weil derselbe Code an drei Stellen steht — in der
 * Gerätedetailansicht, im Update-Katalog und in der Fehlschläge-Auswertung. Als
 * dreifach kopierte Markierung liefen die Darstellungen mit der Zeit
 * auseinander.
 */
const props = defineProps<{ value: number | null }>();

const code = computed(() => (props.value ? formatHresultCode(props.value) : null));
const text = computed(() => (props.value ? describeHresult(props.value) : null));
</script>

<template>
  <span v-if="!code" class="text-muted-foreground">—</span>

  <span v-else>
    <code class="text-xs">{{ code }}</code>
    <span v-if="text" class="text-muted-foreground block text-xs">{{ text }}</span>
  </span>
</template>
