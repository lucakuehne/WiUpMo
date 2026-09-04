<script setup lang="ts">
import { ChevronDown, ChevronRight, Loader2 } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import type { OrganizationalUnit } from '@/api/types';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';

/**
 * Auswahl von Verzeichnisbereichen.
 *
 * Von Hand gebaut, weil shadcn keine Baumkomponente mitbringt. Das ist hier
 * kein Nachteil: Die Auswahl hat eine Eigenart, die eine allgemeine
 * Baumkomponente nicht kennt — ein angekreuzter Knoten schliesst alles
 * darunter ein, weil die LDAP-Suche über den gesamten Unterbaum läuft. Die
 * Kinder werden deshalb *nicht* mit angekreuzt, sondern als abgedeckt
 * dargestellt und gesperrt.
 */
const props = defineProps<{
  modelValue: string[];
  units: OrganizationalUnit[];
  loading?: boolean;
  emptyHint?: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [string[]] }>();

interface Node {
  dn: string;
  label: string;
  children: Node[];
}

const search = ref('');
const collapsed = ref<Set<string>>(new Set());

/**
 * Baut aus der flachen Liste einen Baum. Der übergeordnete Knoten eines DN ist
 * alles nach dem ersten Komma; Einträge ohne bekanntes Elternteil hängen an
 * der Wurzel, statt verlorenzugehen.
 */
const tree = computed<Node[]>(() => {
  const nodes = new Map<string, Node>();

  for (const unit of props.units) {
    nodes.set(unit.dn, {
      dn: unit.dn,
      label: unit.depth === 0 ? unit.dn : unit.name,
      children: [],
    });
  }

  const roots: Node[] = [];

  for (const unit of props.units) {
    const node = nodes.get(unit.dn)!;
    const parent = unit.dn.includes(',')
      ? nodes.get(unit.dn.slice(unit.dn.indexOf(',') + 1))
      : undefined;

    if (parent && parent !== node) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
});

/** Abgeflachte Darstellung mit Tiefe — einfacher zu rendern als verschachtelte Vorlagen. */
interface Row {
  dn: string;
  label: string;
  depth: number;
  hasChildren: boolean;
}

const rows = computed<Row[]>(() => {
  const term = search.value.trim().toLowerCase();
  const result: Row[] = [];

  const walk = (nodes: Node[], depth: number): void => {
    for (const node of nodes) {
      // Beim Suchen wird flach gezeigt, was passt — sonst müsste man erst den
      // Pfad dorthin aufklappen, um den Treffer zu sehen.
      const matches = term === '' || node.label.toLowerCase().includes(term) || node.dn.toLowerCase().includes(term);

      if (matches) {
        result.push({
          dn: node.dn,
          label: node.label,
          depth: term === '' ? depth : 0,
          hasChildren: node.children.length > 0,
        });
      }

      if (term !== '' || !collapsed.value.has(node.dn)) {
        walk(node.children, depth + 1);
      }
    }
  };

  walk(tree.value, 0);
  return result;
});

function isDescendantOf(dn: string, ancestor: string): boolean {
  return dn.toLowerCase().endsWith(`,${ancestor.toLowerCase()}`);
}

/** Deckt eine gewählte übergeordnete Auswahl diesen Knoten bereits ab? */
function coveredByParent(dn: string): boolean {
  return props.modelValue.some((selected) => selected !== dn && isDescendantOf(dn, selected));
}

/** Wie viele Einträge unterhalb dieses Knotens sind einzeln gewählt? */
function selectedBelow(dn: string): number {
  return props.modelValue.filter((selected) => isDescendantOf(selected, dn)).length;
}

/**
 * Drei Zustände statt zwei.
 *
 * `indeterminate` heisst hier: Der Knoten selbst ist nicht gewählt, aber
 * darunter liegt eine Auswahl. Ohne diesen Zustand sähe ein eingeklappter
 * Ast leer aus, obwohl darin etwas ausgewählt ist — und man würde ihn
 * versehentlich ganz ankreuzen und damit die feinere Auswahl überschreiben.
 */
function nodeState(dn: string): boolean | 'indeterminate' {
  if (props.modelValue.includes(dn)) {
    return true;
  }
  return selectedBelow(dn) > 0 ? 'indeterminate' : false;
}

/**
 * Ein Klick auf einen teilweise gewählten Knoten wählt den ganzen Ast — das
 * ist die übliche Erwartung und zugleich die einzige sinnvolle Deutung: Ein
 * zweiter Klick nimmt ihn wieder ganz heraus.
 */
function toggle(dn: string, checked: boolean): void {
  if (checked) {
    // Untergeordnete Auswahlen fallen weg — sie wären ab jetzt redundant.
    const kept = props.modelValue.filter((selected) => !isDescendantOf(selected, dn));
    emit('update:modelValue', [...kept, dn]);
  } else {
    emit(
      'update:modelValue',
      props.modelValue.filter((selected) => selected !== dn),
    );
  }
}

function toggleCollapse(dn: string): void {
  const next = new Set(collapsed.value);
  if (next.has(dn)) {
    next.delete(dn);
  } else {
    next.add(dn);
  }
  collapsed.value = next;
}

/**
 * Bei einer frisch geladenen Struktur alles ausser der Wurzel einklappen — ein
 * Verzeichnis mit hundert Einheiten wäre sonst unlesbar.
 *
 * Ausgenommen sind die Pfade zu bereits gewählten Einträgen: Eine bestehende
 * Auswahl soll man sehen, ohne sie erst suchen zu müssen.
 */
watch(
  () => props.units,
  (units) => {
    const next = new Set(units.filter((unit) => unit.depth >= 1).map((unit) => unit.dn));

    for (const selected of props.modelValue) {
      for (const unit of units) {
        if (isDescendantOf(selected, unit.dn)) {
          next.delete(unit.dn);
        }
      }
    }

    collapsed.value = next;
  },
);
</script>

<template>
  <div
    v-if="units.length === 0"
    class="text-muted-foreground rounded-md border border-dashed p-4 text-sm"
  >
    <Loader2 v-if="loading" class="mr-2 inline size-4 animate-spin" />
    {{ emptyHint ?? 'Keine Einträge.' }}
  </div>

  <div v-else class="rounded-md border">
    <div class="border-b p-2">
      <Input v-model="search" placeholder="Suchen" class="h-8" />
    </div>

    <!-- Begrenzte Höhe mit eigenem Rollbereich: Ein grosses Verzeichnis würde
         die Seite sonst unbenutzbar lang machen. -->
    <div class="max-h-80 overflow-auto p-1">
      <div
        v-for="row in rows"
        :key="row.dn"
        class="hover:bg-accent/50 flex items-center gap-1.5 rounded px-1 py-1 text-sm"
        :style="{ paddingLeft: `${row.depth * 1.1 + 0.25}rem` }"
      >
        <button
          v-if="row.hasChildren"
          type="button"
          class="text-muted-foreground hover:text-foreground shrink-0"
          @click="toggleCollapse(row.dn)"
        >
          <ChevronRight v-if="collapsed.has(row.dn)" class="size-4" />
          <ChevronDown v-else class="size-4" />
        </button>
        <span v-else class="size-4 shrink-0" />

        <Checkbox
          :id="`ou-${row.dn}`"
          :model-value="nodeState(row.dn)"
          :disabled="coveredByParent(row.dn)"
          @update:model-value="toggle(row.dn, $event === true)"
        />

        <label
          :for="`ou-${row.dn}`"
          class="cursor-pointer truncate"
          :class="coveredByParent(row.dn) ? 'text-muted-foreground' : ''"
          :title="row.dn"
        >
          {{ row.label }}
          <span v-if="coveredByParent(row.dn)" class="text-xs">(bereits abgedeckt)</span>
          <span
            v-else-if="nodeState(row.dn) === 'indeterminate'"
            class="text-muted-foreground text-xs"
          >
            ({{ selectedBelow(row.dn) }} darunter gewählt)
          </span>
        </label>
      </div>
    </div>
  </div>
</template>
