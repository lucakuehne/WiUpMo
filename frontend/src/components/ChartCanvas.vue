<script setup lang="ts">
import { Chart, type ChartData, type ChartOptions, type ChartType } from 'chart.js/auto';
import { onBeforeUnmount, onMounted, shallowRef, useTemplateRef, watch } from 'vue';

/**
 * Dünne Hülle um Chart.js.
 *
 * Ersetzt die Diagrammkomponente von PrimeVue. Sie tat nicht mehr als das hier
 * — und band dafür die gesamte Bibliothek ein.
 *
 * `chart.js/auto` meldet alle Diagrammarten und Steuerelemente an. Das ist der
 * grössere Import, aber der einzige, bei dem eine neue Diagrammart nicht
 * stillschweigend als leere Fläche erscheint.
 */
const props = defineProps<{
  type: ChartType;
  data: ChartData;
  options?: ChartOptions;
  height?: string;
}>();

const canvas = useTemplateRef<HTMLCanvasElement>('canvas');

// `shallowRef`: Vue soll die Chart.js-Instanz nicht durchdringen und in ein
// reaktives Proxy verwandeln — die Bibliothek verwaltet ihren Zustand selbst.
const chart = shallowRef<Chart | null>(null);

function create(): void {
  if (!canvas.value) {
    return;
  }

  chart.value = new Chart(canvas.value, {
    type: props.type,
    data: props.data,
    options: props.options,
  });
}

function destroy(): void {
  chart.value?.destroy();
  chart.value = null;
}

onMounted(create);
onBeforeUnmount(destroy);

// Daten lassen sich nachreichen; Art und Einstellungen nicht — dafür baut
// Chart.js das Diagramm neu auf.
watch(
  () => props.data,
  (data) => {
    if (chart.value) {
      chart.value.data = data;
      chart.value.update();
    }
  },
);

watch([() => props.type, () => props.options], () => {
  destroy();
  create();
});
</script>

<template>
  <div :style="{ height: height ?? '20rem' }">
    <canvas ref="canvas" />
  </div>
</template>
