<script setup lang="ts">
import { ChevronDown, ChevronRight, Network } from '@lucide/vue';
import { computed, ref } from 'vue';
import type { DeviceOu } from '@/api/types';
import { dnSegments, domainOfDn, splitDn } from '@/dn';

/**
 * Navigation durch die Organisationseinheiten.
 *
 * Anders als der Auswahlbaum in den Einstellungen ([[OuPicker]]) wird hier
 * genau eine Einheit gewählt, und die Zahlen sind das Wesentliche: Sie zeigen,
 * wo überhaupt etwas zu sehen ist. Gezählt wird der ganze Unterbaum — die
 * Filterung tut dasselbe, und eine Zwischenebene mit „0", unter der hundert
 * Geräte liegen, wäre schlicht irreführend.
 */
const props = defineProps<{
  modelValue: string | null;
  units: DeviceOu[];
}>();

const emit = defineEmits<{ 'update:modelValue': [string | null] }>();

interface Node {
  dn: string;
  label: string;
  total: number;
  children: Node[];
}

const collapsed = ref<Set<string>>(new Set());

/**
 * Baut den Baum aus den DNs.
 *
 * Die Zwischenebenen entstehen dabei mit: Die Antwort enthält nur Einheiten,
 * in denen tatsächlich Geräte liegen — deren übergeordnete Einheiten kommen
 * darin gar nicht vor, werden zum Durchklicken aber gebraucht. Alle
 * DC-Bestandteile bilden zusammen einen einzigen Wurzelknoten; sie einzeln
 * aufzuklappen wäre eine Ebene ohne Aussage.
 */
const tree = computed<Node[]>(() => {
  const nodes = new Map<string, Node>();
  const roots: Node[] = [];

  const ensure = (segments: string[], parent: Node | null): Node => {
    const dn = segments.join(',');
    const existing = nodes.get(dn);

    if (existing) {
      return existing;
    }

    const node: Node = { dn, label: labelOf(dn), total: 0, children: [] };
    nodes.set(dn, node);
    (parent ? parent.children : roots).push(node);

    return node;
  };

  for (const unit of props.units) {
    const segments = dnSegments(unit.dn);
    const domainAt = segments.findIndex((segment) => /^dc=/i.test(segment));
    const split = domainAt < 0 ? segments.length - 1 : domainAt;

    let node = ensure(segments.slice(split), null);

    for (let i = split - 1; i >= 0; i--) {
      node = ensure(segments.slice(i), node);
    }

    // Auf jeden Knoten des Pfades, nicht nur auf den untersten: Der Zähler
    // eines Astes ist die Summe dessen, was darunter liegt.
    for (let i = 0; i <= split; i++) {
      const ancestor = nodes.get(segments.slice(i).join(','));
      if (ancestor) {
        ancestor.total += unit.devices;
      }
    }
  }

  const sort = (list: Node[]): void => {
    list.sort((a, b) => a.label.localeCompare(b.label, 'de'));
    list.forEach((node) => sort(node.children));
  };

  sort(roots);
  return roots;
});

/**
 * Der Name der Einheit selbst — beim Wurzelknoten der Domänenname.
 *
 * Die Unterscheidung über den Typ des ersten Bestandteils, nicht über das
 * Vorhandensein von DC-Teilen: Die stecken in jedem DN, auch in
 * `OU=Clients,DC=firma,DC=local`, und der heisst „Clients" und nicht
 * „firma.local".
 */
function labelOf(dn: string): string {
  const first = splitDn(dn)[0];

  if (!first) {
    return dn;
  }

  return first.type === 'dc' ? (domainOfDn(dn) ?? dn) : first.value;
}

/** Abgeflacht mit Tiefe — einfacher zu rendern als verschachtelte Vorlagen. */
interface Row {
  dn: string;
  label: string;
  total: number;
  depth: number;
  hasChildren: boolean;
}

const rows = computed<Row[]>(() => {
  const result: Row[] = [];

  const walk = (nodes: Node[], depth: number): void => {
    for (const node of nodes) {
      result.push({
        dn: node.dn,
        label: node.label,
        total: node.total,
        depth,
        hasChildren: node.children.length > 0,
      });

      if (!collapsed.value.has(node.dn)) {
        walk(node.children, depth + 1);
      }
    }
  };

  walk(tree.value, 0);
  return result;
});

/** Ein erneuter Klick auf die gewählte Einheit hebt die Einschränkung auf. */
function select(dn: string): void {
  emit('update:modelValue', props.modelValue === dn ? null : dn);
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
</script>

<template>
  <div class="rounded-md border">
    <div class="text-muted-foreground flex items-center gap-2 border-b px-3 py-2 text-xs font-medium">
      <Network class="size-3.5" />
      Organisationseinheiten
    </div>

    <div class="max-h-[calc(100vh-14rem)] overflow-auto p-1">
      <button
        type="button"
        class="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-sm"
        :class="
          modelValue === null ? 'bg-accent text-accent-foreground font-medium' : 'hover:bg-accent/50'
        "
        @click="emit('update:modelValue', null)"
      >
        <!--
          Bewusst ohne Zahl: Sie müsste die Geräte ohne Organisationseinheit
          mitzählen — die tauchen im Baum aber nirgends auf, und eine Summe, die
          nicht der Summe der Äste entspricht, verwirrt mehr als sie hilft.
        -->
        <span class="flex-1 truncate">Alle Geräte</span>
      </button>

      <div v-if="units.length === 0" class="text-muted-foreground px-2 py-3 text-xs">
        Kein Gerät trägt eine Organisationseinheit. Sie entsteht beim Abgleich mit dem Verzeichnis.
      </div>

      <div
        v-for="row in rows"
        :key="row.dn"
        class="flex items-center gap-1 rounded"
        :class="
          modelValue === row.dn ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
        "
        :style="{ paddingLeft: `${row.depth * 0.85}rem` }"
      >
        <button
          v-if="row.hasChildren"
          type="button"
          class="text-muted-foreground hover:text-foreground shrink-0 px-1 py-1.5"
          :aria-label="collapsed.has(row.dn) ? 'Aufklappen' : 'Zuklappen'"
          @click="toggleCollapse(row.dn)"
        >
          <ChevronRight v-if="collapsed.has(row.dn)" class="size-3.5" />
          <ChevronDown v-else class="size-3.5" />
        </button>
        <span v-else class="w-[1.375rem] shrink-0" />

        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-left text-sm"
          :class="modelValue === row.dn ? 'font-medium' : ''"
          :title="row.dn"
          @click="select(row.dn)"
        >
          <span class="flex-1 truncate">{{ row.label }}</span>
          <span class="text-muted-foreground tabular text-xs">{{ row.total }}</span>
        </button>
      </div>
    </div>
  </div>
</template>
