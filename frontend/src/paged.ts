import { computed, reactive, ref, watch, type Ref } from 'vue';

/**
 * Blättern über eine Liste, die bereits vollständig im Browser liegt.
 *
 * Für die Auswertungen richtig: Sie sind klein genug, um sie am Stück zu
 * holen, und ein Reiterwechsel soll nicht jedes Mal nachladen. Für die grossen
 * Listen — Geräte, Updates — gilt weiterhin das Gegenteil; die blättern
 * serverseitig.
 *
 * Das Ergebnis ist `reactive`, damit in der Vorlage `liste.items` genügt: Refs
 * in einem gewöhnlichen Objekt würden dort nicht entpackt.
 */
export function usePagedList<T>(source: Ref<T[]>, size = 25) {
  const page = ref(1);
  const limit = ref(size);

  // Nach einem Neuladen zeigt Seite 7 womöglich ins Leere.
  watch(source, () => {
    page.value = 1;
  });

  return reactive({
    page,
    limit,
    total: computed(() => source.value.length),
    items: computed(() => source.value.slice((page.value - 1) * limit.value, page.value * limit.value)),
  });
}
