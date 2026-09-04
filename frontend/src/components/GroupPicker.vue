<script setup lang="ts">
import { ChevronDown, ChevronRight, Folder, Users } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import type { AdGroup } from '@/api/types';
import { Checkbox } from '@/components/ui/checkbox';

/**
 * Auswahl von Verzeichnisgruppen, nach ihrem Ablageort gegliedert.
 *
 * Die Struktur kommt aus den DNs selbst — der Pfad hinter dem ersten Komma ist
 * der übergeordnete Behälter. Das ist genauer als eine separate Abfrage der
 * Organisationseinheiten: Gezeigt wird genau der Baum, in dem die gefundenen
 * Gruppen tatsächlich liegen, ohne leere Äste.
 *
 * Behälter sind nicht auswählbar. Ein angekreuzter Ordner müsste beim
 * Speichern zu den enthaltenen Gruppen aufgelöst werden — und was dann
 * gespeichert wäre, entspräche nicht mehr dem, was jemand angekreuzt hat,
 * sobald später eine Gruppe dazukommt.
 */
const props = defineProps<{
  modelValue: string[];
  groups: AdGroup[];
  loading?: boolean;
  emptyHint?: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [string[]] }>();

interface Row {
  key: string;
  label: string;
  hint: string | null;
  depth: number;
  isGroup: boolean;
  hasChildren: boolean;
  selectedBelow: number;
}

const collapsed = ref<Set<string>>(new Set());

/** Der Behälterpfad einer Gruppe: alles nach dem ersten Komma. */
function containerOf(dn: string): string {
  const separator = dn.indexOf(',');
  return separator > 0 ? dn.slice(separator + 1) : '';
}

/** `OU=Gruppen,OU=Verwaltung,DC=…` wird zu `Gruppen` — nur der eigene Name. */
function rdnValue(dn: string): string {
  const first = dn.split(',')[0];
  const equals = first.indexOf('=');
  return equals > 0 ? first.slice(equals + 1) : first;
}

const rows = computed<Row[]>(() => {
  // Behälter samt ihrer Vorfahren einsammeln, damit kein Ast in der Luft hängt.
  const containers = new Set<string>();

  for (const group of props.groups) {
    let path = containerOf(group.dn);
    while (path.includes(',')) {
      containers.add(path);
      path = containerOf(path);
    }
    if (path) {
      containers.add(path);
    }
  }

  const byContainer = new Map<string, AdGroup[]>();
  for (const group of props.groups) {
    const container = containerOf(group.dn);
    byContainer.set(container, [...(byContainer.get(container) ?? []), group]);
  }

  const childContainers = new Map<string, string[]>();
  const roots: string[] = [];

  for (const container of containers) {
    const parent = containerOf(container);
    if (containers.has(parent)) {
      childContainers.set(parent, [...(childContainers.get(parent) ?? []), container]);
    } else {
      roots.push(container);
    }
  }

  const selectedBelow = (container: string): number =>
    props.modelValue.filter((dn) => dn.toLowerCase().endsWith(`,${container.toLowerCase()}`)).length;

  const result: Row[] = [];

  const walk = (container: string, depth: number): void => {
    const children = (childContainers.get(container) ?? []).sort((a, b) =>
      rdnValue(a).localeCompare(rdnValue(b), 'de'),
    );
    const groups = (byContainer.get(container) ?? []).sort((a, b) =>
      a.name.localeCompare(b.name, 'de'),
    );

    result.push({
      key: container,
      label: rdnValue(container) || container,
      hint: null,
      depth,
      isGroup: false,
      hasChildren: children.length + groups.length > 0,
      selectedBelow: selectedBelow(container),
    });

    if (collapsed.value.has(container)) {
      return;
    }

    for (const child of children) {
      walk(child, depth + 1);
    }

    for (const group of groups) {
      result.push({
        key: group.dn,
        label: group.name,
        hint: group.accountName,
        depth: depth + 1,
        isGroup: true,
        hasChildren: false,
        selectedBelow: 0,
      });
    }
  };

  for (const root of roots.sort((a, b) => a.localeCompare(b, 'de'))) {
    walk(root, 0);
  }

  return result;
});

function toggle(dn: string, checked: boolean): void {
  emit(
    'update:modelValue',
    checked ? [...props.modelValue, dn] : props.modelValue.filter((entry) => entry !== dn),
  );
}

function toggleCollapse(key: string): void {
  const next = new Set(collapsed.value);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  collapsed.value = next;
}

// Eine frische Suche wird aufgeklappt gezeigt: Wer gesucht hat, will die
// Treffer sehen und nicht erst danach suchen, in welchem Ast sie liegen.
watch(
  () => props.groups,
  () => {
    collapsed.value = new Set();
  },
);
</script>

<template>
  <div
    v-if="groups.length === 0 && modelValue.length === 0"
    class="text-muted-foreground rounded-md border border-dashed p-3 text-sm"
  >
    {{ emptyHint ?? 'Keine Gruppen geladen.' }}
  </div>

  <div v-else class="max-h-72 overflow-auto rounded-md border p-1" :class="loading ? 'opacity-60' : ''">
    <div
      v-for="row in rows"
      :key="row.key"
      class="flex items-center gap-1.5 rounded px-1 py-1 text-sm"
      :class="row.isGroup ? 'hover:bg-accent/50' : ''"
      :style="{ paddingLeft: `${row.depth * 1.1 + 0.25}rem` }"
    >
      <template v-if="row.isGroup">
        <span class="size-4 shrink-0" />
        <Checkbox
          :id="`grp-${row.key}`"
          :model-value="modelValue.includes(row.key)"
          @update:model-value="toggle(row.key, $event === true)"
        />
        <Users class="text-muted-foreground size-3.5 shrink-0" />
        <label :for="`grp-${row.key}`" class="cursor-pointer truncate" :title="row.key">
          {{ row.label }}
          <span v-if="row.hint" class="text-muted-foreground text-xs">({{ row.hint }})</span>
        </label>
      </template>

      <template v-else>
        <button
          v-if="row.hasChildren"
          type="button"
          class="text-muted-foreground hover:text-foreground shrink-0"
          @click="toggleCollapse(row.key)"
        >
          <ChevronRight v-if="collapsed.has(row.key)" class="size-4" />
          <ChevronDown v-else class="size-4" />
        </button>
        <span v-else class="size-4 shrink-0" />

        <Folder class="text-muted-foreground size-3.5 shrink-0" />
        <span class="text-muted-foreground truncate font-medium" :title="row.key">
          {{ row.label }}
          <span v-if="row.selectedBelow > 0" class="text-xs font-normal">
            ({{ row.selectedBelow }} gewählt)
          </span>
        </span>
      </template>
    </div>
  </div>
</template>
