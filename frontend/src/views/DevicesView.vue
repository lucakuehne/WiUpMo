<script setup lang="ts">
import {
  AlertTriangle,
  ArrowUpCircle,
  Download,
  Loader2,
  MonitorDown,
  RotateCcw,
  Search,
  Trash2,
  X,
} from '@lucide/vue';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import { downloadPost, get, post } from '@/api/client';
import type {
  AgentVersionCount,
  CreateUpdateJobsResult,
  DeviceListItem,
  DeviceOu,
  DeviceStatus,
  Paged,
  UpdateSource,
} from '@/api/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import InstallDialog from '@/components/InstallDialog.vue';
import OuNavigator from '@/components/OuNavigator.vue';
import SortHead from '@/components/SortHead.vue';
import SourceLegend from '@/components/SourceLegend.vue';
import TablePager from '@/components/TablePager.vue';
import { formatDnPath } from '@/dn';
import { UPDATE_SOURCE_LABELS, formatDateTime, formatRelative, sourceBadgeClass } from '@/format';

const route = useRoute();
const router = useRouter();

const rows = ref<DeviceListItem[]>([]);
const total = ref(0);
const loading = ref(true);
const error = ref<string | null>(null);

const page = ref(1);
const limit = ref(25);
const sortBy = ref('hostname');
const sortDir = ref<'asc' | 'desc'>('asc');

const search = ref('');

/**
 * Archivierte Geräte sind standardmässig ausgeblendet.
 *
 * Der Server filtert bewusst nicht von sich aus — für die Schnittstelle ist
 * „alle Geräte" die richtige Vorgabe. In der Liste ist es die falsche: Wer eine
 * Organisationseinheit aus dem Abgleich nimmt, sieht deren Geräte sonst
 * unverändert weiter, obwohl sie längst archiviert sind.
 */
const status = ref<DeviceStatus | 'all'>('active');
const updateSource = ref<UpdateSource | null>(null);

/** Gewählte Organisationseinheit einschliesslich allem darunter. */
const ou = ref<string | null>(null);
const units = ref<DeviceOu[]>([]);

/** Gemeldete Agent-Version, exakt. Die Auswahl kommt aus der Auswertung. */
const agentVersion = ref<string | null>(null);
const agentVersions = ref<AgentVersionCount[]>([]);
const staleDays = ref<number | null>(null);
const hasOpenSecurity = ref(false);

/**
 * Dreiwertig: `null` schränkt nicht ein, `true`/`false` fragen jeweils eine
 * Seite ab. Beide Richtungen werden gebraucht — „welche Geräte haben den Agent
 * noch nicht" ist die Deployment-Lücke, „welche haben ihn" die Gegenprobe.
 */
const pendingReboot = ref<boolean | null>(null);
const hasAgent = ref<boolean | null>(null);

const sourceOptions = (Object.keys(UPDATE_SOURCE_LABELS) as UpdateSource[]).map((value) => ({
  value,
  label: UPDATE_SOURCE_LABELS[value],
}));

const staleOptions = [
  { value: '3', label: 'seit 3 Tagen' },
  { value: '7', label: 'seit 7 Tagen' },
  { value: '14', label: 'seit 14 Tagen' },
  { value: '30', label: 'seit 30 Tagen' },
];

/**
 * Platzhalter für „keine Einschränkung".
 *
 * Reka lässt eine leere Zeichenkette als Auswahlwert nicht zu — die steht dort
 * für „nichts gewählt" und würde den Platzhaltertext zurückholen. Der Wert
 * muss deshalb an genau einer Stelle wieder herausgefiltert werden, sonst geht
 * er als Filter ans Backend und wird dort als ungültig abgewiesen.
 */
const ANY = ' ';

function onSourceChange(value: unknown): void {
  updateSource.value = value === ANY || !value ? null : (value as UpdateSource);
  onFilterChange();
}

function onStatusChange(value: unknown): void {
  status.value = (value as DeviceStatus | 'all') || 'active';
  onFilterChange();

  // Die Zahlen im Baum zählen dieselbe Menge, die die Tabelle zeigt — sonst
  // steht neben einer Einheit eine Zahl, die sich beim Anklicken ändert.
  void loadUnits();
}

async function loadUnits(): Promise<void> {
  try {
    units.value = await get<DeviceOu[]>('/api/devices/organizational-units', {
      status: status.value === 'all' ? undefined : status.value,
    });
  } catch {
    // Die Navigation ist eine Hilfe, kein Muss. Fällt sie aus, bleibt die
    // Liste vollständig bedienbar — eine rote Meldung darüber wäre unverhältnismässig.
    units.value = [];
  }
}

function onOuChange(value: string | null): void {
  ou.value = value;
  onFilterChange();
}

function onAgentVersionChange(value: unknown): void {
  agentVersion.value = value === ANY || !value ? null : String(value);
  onFilterChange();
}

async function loadAgentVersions(): Promise<void> {
  try {
    agentVersions.value = await get<AgentVersionCount[]>('/api/reports/agent-versions');
  } catch {
    // Nur die Auswahl im Filter; ohne sie bleibt die Liste bedienbar.
    agentVersions.value = [];
  }
}

function onStaleChange(value: unknown): void {
  staleDays.value = value === ANY || !value ? null : Number(value);
  onFilterChange();
}

/**
 * Wie bei den Umschaltern über den Namen statt über die Referenz — in der
 * Vorlage werden Refs entpackt und liessen sich nicht mehr setzen.
 */
const triFilters = { pendingReboot, hasAgent };

function triValue(value: boolean | null): string {
  return value === null ? ANY : String(value);
}

function onTriChange(name: keyof typeof triFilters, value: unknown): void {
  triFilters[name].value = value === ANY || !value ? null : value === 'true';
  onFilterChange();
}

/**
 * Die Filter, wie das Backend sie erwartet — an einer Stelle, weil Liste,
 * Export und „alle Treffer auswählen" dieselbe Menge meinen müssen. Der Export
 * hatte die Agent-Version einmal vergessen und enthielt dann mehr Geräte, als
 * die Liste zeigte.
 */
function filterParams(): Record<string, unknown> {
  return {
    sortBy: sortBy.value,
    sortDir: sortDir.value,
    search: search.value || undefined,
    status: status.value === 'all' ? undefined : status.value,
    ou: ou.value ?? undefined,
    agentVersion: agentVersion.value ?? undefined,
    updateSource: updateSource.value ?? undefined,
    staleDays: staleDays.value ?? undefined,
    hasOpenSecurity: hasOpenSecurity.value || undefined,
    // Hier bewusst `??` statt `||`: `false` ist ein Filter, kein leerer Wert.
    pendingReboot: pendingReboot.value ?? undefined,
    hasAgent: hasAgent.value ?? undefined,
  };
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    // Serverseitig filtern, sortieren und blättern — die Tabelle lädt niemals
    // die ganze Flotte in den Browser.
    const result = await get<Paged<DeviceListItem>>('/api/devices', {
      ...filterParams(),
      page: page.value,
      limit: limit.value,
    });

    rows.value = result.items;
    total.value = result.total;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Die Geräteliste konnte nicht geladen werden.';
  } finally {
    loading.value = false;
  }
}

function onSort(field: string, dir: 'asc' | 'desc'): void {
  sortBy.value = field;
  sortDir.value = dir;
  page.value = 1;
  void load();
}

/**
 * Jede Filteränderung springt zurück auf Seite 1 — sonst zeigt die Tabelle
 * Leere. Die Auswahl fällt dabei weg: Sie enthielte sonst Geräte, die nicht
 * mehr zu sehen sind, und eine Aktion träfe sie trotzdem.
 */
function onFilterChange(): void {
  page.value = 1;
  clearSelection();
  void load();
}

// --- Auswahl ------------------------------------------------------------------

/**
 * Ausgewählte Geräte über die Seiten hinweg, mit ihrer Zeile: Die Aktionen
 * brauchen den Status (nur archivierte lassen sich löschen) auch für Geräte,
 * deren Seite gerade nicht angezeigt wird.
 */
const selected = ref(new Map<string, DeviceListItem>());

const pageSelection = computed<boolean | 'indeterminate'>(() => {
  const onPage = rows.value.filter((row) => selected.value.has(row.id)).length;
  if (onPage === 0) return false;
  return onPage === rows.value.length ? true : 'indeterminate';
});

const archivedSelected = computed(() =>
  [...selected.value.values()].filter((row) => row.status === 'archived'),
);

const updatableSelected = computed(() =>
  [...selected.value.values()].filter((row) => row.status === 'active' && row.enrolledAt),
);

/** Ganze Seite gewählt, aber nicht alle Treffer — dann lohnt das Angebot, den Rest dazuzunehmen. */
const canSelectAllMatching = computed(
  () => pageSelection.value === true && selected.value.size < total.value,
);

function toggleRow(row: DeviceListItem, checked: boolean): void {
  const next = new Map(selected.value);
  if (checked) next.set(row.id, row);
  else next.delete(row.id);
  selected.value = next;
}

function togglePage(checked: boolean): void {
  const next = new Map(selected.value);
  for (const row of rows.value) {
    if (checked) next.set(row.id, row);
    else next.delete(row.id);
  }
  selected.value = next;
}

function clearSelection(): void {
  selected.value = new Map();
}

const selectingAll = ref(false);

/** Holt die übrigen Treffer seitenweise; die Liste selbst bleibt auf ihrer Seite. */
async function selectAllMatching(): Promise<void> {
  selectingAll.value = true;
  try {
    const next = new Map(selected.value);
    for (let p = 1; next.size < total.value; p++) {
      const result = await get<Paged<DeviceListItem>>('/api/devices', { ...filterParams(), page: p, limit: 200 });
      result.items.forEach((row) => next.set(row.id, row));
      if (result.items.length < 200) break;
    }
    selected.value = next;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Die Treffer konnten nicht ausgewählt werden.';
  } finally {
    selectingAll.value = false;
  }
}

async function exportSelected(): Promise<void> {
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    await downloadPost('/api/devices/export', { ids: [...selected.value.keys()] }, `geraete-${stamp}.csv`);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Der Export ist fehlgeschlagen.';
  }
}

/**
 * Beide Aktionen mit Rückfrage: Ein Agent-Update setzt die ausgewählten
 * Geräte in Bewegung, das Löschen lässt sich nicht zurücknehmen.
 */
const confirmAgentUpdate = ref(false);
const confirmDelete = ref(false);

/** Der Dialog fragt selbst nach Umfang und Zeitpunkt; ältere Agents übergeht das Backend. */
const installDialog = ref(false);

function onInstallCreated(): void {
  clearSelection();
}
const busy = ref(false);

async function updateAgents(): Promise<void> {
  busy.value = true;
  try {
    const ids = updatableSelected.value.map((row) => row.id);
    const result = await post<CreateUpdateJobsResult>('/api/agent-update-jobs', { deviceIds: ids });
    const current = ids.length - result.created - result.skipped;
    toast.success(`${result.created} Update-Auftrag/-Aufträge auf ${result.targetVersion} angelegt.`, {
      description:
        [
          result.skipped > 0 ? `${result.skipped} mit bereits offenem Auftrag` : '',
          current > 0 ? `${current} schon auf dieser Version` : '',
        ]
          .filter(Boolean)
          .join(', ') || 'Die Geräte holen den Auftrag beim nächsten Check-in ab.',
    });
    clearSelection();
    void load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Die Aufträge konnten nicht angelegt werden.';
  } finally {
    busy.value = false;
    confirmAgentUpdate.value = false;
  }
}

async function deleteSelected(): Promise<void> {
  busy.value = true;
  try {
    const result = await post<{ deleted: number; skipped: number }>('/api/devices/delete', {
      ids: archivedSelected.value.map((row) => row.id),
    });
    toast.success(`${result.deleted} Gerät(e) endgültig gelöscht.`);
    clearSelection();
    void load();
    void loadUnits();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Das Löschen ist fehlgeschlagen.';
  } finally {
    busy.value = false;
    confirmDelete.value = false;
  }
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;

function onSearchInput(): void {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(onFilterChange, 300);
}

/**
 * Angesprochen über den Namen, nicht über die Referenz: In der Vorlage werden
 * Refs automatisch entpackt, ein übergebener Ref käme dort als Wahrheitswert
 * an und liesse sich nicht mehr setzen.
 */
const booleanFilters = { hasOpenSecurity };

function toggleFilter(name: keyof typeof booleanFilters): void {
  booleanFilters[name].value = !booleanFilters[name].value;
  onFilterChange();
}

function resetFilters(): void {
  search.value = '';
  status.value = 'active';
  ou.value = null;
  agentVersion.value = null;
  updateSource.value = null;
  staleDays.value = null;
  hasOpenSecurity.value = false;
  pendingReboot.value = null;
  hasAgent.value = null;
  onFilterChange();
}

function openDevice(id: string): void {
  void router.push({ name: 'device', params: { id } });
}

/**
 * Der Export geht über einen eigenen Endpunkt statt über die geladenen Zeilen:
 * Die Tabelle kennt nur die aktuelle Seite, der Export soll die gesamte
 * gefilterte Menge enthalten. Deshalb ein direkter Navigationsaufruf — der
 * Browser lädt die Datei und schickt das Sitzungscookie dabei mit.
 */
function exportCsv(): void {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filterParams())) {
    if (value !== undefined && value !== '') {
      params.set(key, String(value));
    }
  }

  window.location.href = `/api/devices/export?${params.toString()}`;
}

/** Übernimmt Filter, mit denen das Dashboard hierher verlinkt. */
function applyQueryFilters(): void {
  const query = route.query;

  if (query.status === 'archived' || query.status === 'all') {
    status.value = query.status;
  }
  if (typeof query.staleDays === 'string') {
    staleDays.value = Number(query.staleDays);
  }
  if (query.hasOpenSecurity === '1') {
    hasOpenSecurity.value = true;
  }
  if (query.pendingReboot === '1') {
    pendingReboot.value = true;
  }
  if (query.hasAgent === '0' || query.hasAgent === '1') {
    hasAgent.value = query.hasAgent === '1';
  }
  if (typeof query.updateSource === 'string' && query.updateSource in UPDATE_SOURCE_LABELS) {
    updateSource.value = query.updateSource as UpdateSource;
  }
  if (typeof query.ou === 'string' && query.ou !== '') {
    ou.value = query.ou;
  }
  if (typeof query.agentVersion === 'string' && query.agentVersion !== '') {
    agentVersion.value = query.agentVersion;
  }
}

onMounted(() => {
  applyQueryFilters();
  void load();
  void loadUnits();
  void loadAgentVersions();
});
</script>

<template>
  <div class="mx-auto max-w-[1600px] px-5 py-6">
    <div class="mb-4 flex flex-wrap items-baseline justify-between gap-3">
      <h1 class="text-xl font-semibold">Geräte</h1>
      <span class="text-muted-foreground tabular text-sm">{{ total }} Geräte</span>
    </div>

    <div class="mb-3 flex flex-wrap items-center gap-2">
      <div class="relative">
        <Search class="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
        <Input
          v-model="search"
          placeholder="Hostname, OU, Benutzer"
          class="w-56 pl-8"
          @input="onSearchInput"
        />
      </div>

      <Select :model-value="status" @update:model-value="onStatusChange">
        <SelectTrigger class="w-40"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="active">Aktiv</SelectItem>
          <SelectItem value="archived">Archiviert</SelectItem>
          <SelectItem value="all">Aktiv und archiviert</SelectItem>
        </SelectContent>
      </Select>

      <div class="flex items-center gap-1">
        <Select :model-value="updateSource ?? ''" @update:model-value="onSourceChange">
          <SelectTrigger class="w-48">
            <SelectValue placeholder="Update-Quelle" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="ANY">Alle Quellen</SelectItem>
            <SelectItem v-for="option in sourceOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </SelectItem>
          </SelectContent>
        </Select>
        <SourceLegend />
      </div>

      <Select
        :model-value="agentVersion ?? ''"
        @update:model-value="onAgentVersionChange"
      >
        <SelectTrigger class="w-44">
          <SelectValue placeholder="Agent-Version" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem :value="ANY">Alle Versionen</SelectItem>
          <SelectItem
            v-for="entry in agentVersions"
            :key="entry.version ?? 'unbekannt'"
            :value="entry.version ?? ANY"
          >
            {{ entry.version ?? 'unbekannt' }} ({{ entry.devices }})
          </SelectItem>
        </SelectContent>
      </Select>

      <Select
        :model-value="staleDays === null ? '' : String(staleDays)"
        @update:model-value="onStaleChange"
      >
        <SelectTrigger class="w-44">
          <SelectValue placeholder="Kein Check-in" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem :value="ANY">Egal</SelectItem>
          <SelectItem v-for="option in staleOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </SelectItem>
        </SelectContent>
      </Select>

      <Button
        :variant="hasOpenSecurity ? 'default' : 'outline'"
        size="sm"
        @click="toggleFilter('hasOpenSecurity')"
      >
        Sicherheitsupdates offen
      </Button>

      <Select
        :model-value="triValue(pendingReboot)"
        @update:model-value="onTriChange('pendingReboot', $event)"
      >
        <SelectTrigger class="w-52"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem :value="ANY">Neustart: egal</SelectItem>
          <SelectItem value="true">Neustart ausstehend</SelectItem>
          <SelectItem value="false">Kein Neustart ausstehend</SelectItem>
        </SelectContent>
      </Select>

      <Select :model-value="triValue(hasAgent)" @update:model-value="onTriChange('hasAgent', $event)">
        <SelectTrigger class="w-44"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem :value="ANY">Agent: egal</SelectItem>
          <SelectItem value="true">Mit Agent</SelectItem>
          <SelectItem value="false">Ohne Agent</SelectItem>
        </SelectContent>
      </Select>

      <Button variant="ghost" size="sm" @click="resetFilters">
        <RotateCcw class="size-4" />
        Zurücksetzen
      </Button>

      <Button variant="outline" size="sm" class="ml-auto" @click="exportCsv">
        <Download class="size-4" />
        Export
      </Button>
    </div>

    <Alert v-if="error" variant="destructive" class="mb-4">
      <AlertDescription>{{ error }}</AlertDescription>
    </Alert>

    <!-- Der Baum steht neben der Tabelle, die Filterleiste darüber: Sie gilt
         für beides, er schränkt nur die Tabelle ein. -->
    <div class="flex items-start gap-5">
      <aside class="hidden w-64 shrink-0 lg:block">
        <OuNavigator :model-value="ou" :units="units" @update:model-value="onOuChange" />
      </aside>

      <div class="min-w-0 flex-1">
        <!-- Erscheint nur mit Auswahl, damit die Tabelle sonst nicht nach unten rutscht. -->
        <div
          v-if="selected.size > 0"
          class="bg-muted/50 mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border px-3 py-2 text-sm"
        >
          <span class="font-medium tabular">{{ selected.size }} ausgewählt</span>
          <button
            v-if="canSelectAllMatching"
            type="button"
            class="text-primary hover:underline disabled:opacity-50"
            :disabled="selectingAll"
            @click="selectAllMatching"
          >
            Alle {{ total }} Treffer auswählen
          </button>

          <div class="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="outline" @click="exportSelected">
              <Download class="size-4" />
              Exportieren
            </Button>
            <Button
              size="sm"
              variant="outline"
              :disabled="updatableSelected.length === 0"
              :title="updatableSelected.length === 0 ? 'Keines der ausgewählten Geräte ist aktiv und hat einen Agent.' : undefined"
              @click="confirmAgentUpdate = true"
            >
              <ArrowUpCircle class="size-4" />
              Agent aktualisieren
            </Button>
            <Button
              size="sm"
              variant="outline"
              :disabled="updatableSelected.length === 0"
              :title="updatableSelected.length === 0 ? 'Keines der ausgewählten Geräte ist aktiv und hat einen Agent.' : undefined"
              @click="installDialog = true"
            >
              <MonitorDown class="size-4" />
              Offene Updates installieren …
            </Button>
            <Button
              size="sm"
              variant="outline"
              :disabled="archivedSelected.length === 0"
              :title="archivedSelected.length === 0 ? 'Nur archivierte Geräte lassen sich löschen.' : undefined"
              @click="confirmDelete = true"
            >
              <Trash2 class="size-4" />
              Endgültig löschen
              <span v-if="archivedSelected.length > 0" class="tabular">({{ archivedSelected.length }})</span>
            </Button>
            <Button size="sm" variant="ghost" @click="clearSelection">
              <X class="size-4" />
              Auswahl aufheben
            </Button>
          </div>
        </div>

        <div class="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead class="w-10">
                  <Checkbox
                    aria-label="Alle Geräte dieser Seite auswählen"
                    :model-value="pageSelection"
                    :disabled="loading || rows.length === 0"
                    @update:model-value="togglePage($event === true)"
                  />
                </TableHead>
                <SortHead field="hostname" :sort-by="sortBy" :sort-dir="sortDir" @sort="onSort">
                  Hostname
                </SortHead>
                <SortHead field="lastLogonUser" :sort-by="sortBy" :sort-dir="sortDir" @sort="onSort">
                  Benutzer
                </SortHead>
                <SortHead field="osBuild" :sort-by="sortBy" :sort-dir="sortDir" @sort="onSort">
                  Betriebssystem
                </SortHead>
                <SortHead field="updateSource" :sort-by="sortBy" :sort-dir="sortDir" @sort="onSort">
                  Quelle
                  <template #after><SourceLegend /></template>
                </SortHead>
                <SortHead
                  field="openUpdates"
                  numeric
                  :sort-by="sortBy"
                  :sort-dir="sortDir"
                  @sort="onSort"
                >
                  Offen
                </SortHead>
                <SortHead
                  field="openSecurityUpdates"
                  numeric
                  :sort-by="sortBy"
                  :sort-dir="sortDir"
                  @sort="onSort"
                >
                  davon Sicherheit
                </SortHead>
                <SortHead
                  field="patchAgeDays"
                  numeric
                  :sort-by="sortBy"
                  :sort-dir="sortDir"
                  @sort="onSort"
                >
                  Patch-Alter
                </SortHead>
                <SortHead field="lastSeenAt" :sort-by="sortBy" :sort-dir="sortDir" @sort="onSort">
                  Letzter Check-in
                </SortHead>
                <SortHead
                  field="agentVersion"
                  class="w-28"
                  :sort-by="sortBy"
                  :sort-dir="sortDir"
                  @sort="onSort"
                >
                  Agent
                </SortHead>
                <TableHead class="w-20">Neustart</TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              <template v-if="loading">
                <TableRow v-for="n in 6" :key="n">
                  <TableCell v-for="column in 11" :key="column">
                    <Skeleton class="h-4 w-full" />
                  </TableCell>
                </TableRow>
              </template>

              <TableRow v-else-if="rows.length === 0">
                <TableCell :colspan="11" class="text-muted-foreground py-8 text-center">
                  Keine Geräte gefunden.
                </TableCell>
              </TableRow>

              <TableRow
                v-for="row in loading ? [] : rows"
                :key="row.id"
                class="cursor-pointer"
                :data-state="selected.has(row.id) ? 'selected' : undefined"
                @click="openDevice(row.id)"
              >
                <!-- Der Klick aufs Kästchen wählt aus und öffnet nicht das Gerät. -->
                <TableCell @click.stop>
                  <Checkbox
                    :aria-label="`${row.hostname} auswählen`"
                    :model-value="selected.has(row.id)"
                    @update:model-value="toggleRow(row, $event === true)"
                  />
                </TableCell>

                <TableCell>
                  <div class="flex items-center gap-2">
                    <span class="font-medium">{{ row.hostname }}</span>
                    <Badge v-if="row.status === 'archived'" variant="secondary">archiviert</Badge>
                  </div>
                  <!-- Der Pfad statt des DN; der vollständige Wert bleibt als
                       Hinweistext erreichbar. -->
                  <div
                    v-if="row.adOu"
                    class="text-muted-foreground truncate text-xs"
                    :title="row.adOu"
                  >
                    {{ formatDnPath(row.adOu) }}
                  </div>
                </TableCell>

                <!-- Zuletzt angemeldet: der Name vorn, das Konto darunter. -->
                <TableCell class="max-w-44">
                  <template v-if="row.lastLogonUser">
                    <div class="truncate" :title="row.lastLogonDisplayName ?? row.lastLogonUser">
                      {{ row.lastLogonDisplayName ?? row.lastLogonUser }}
                    </div>
                    <div
                      v-if="row.lastLogonDisplayName"
                      class="text-muted-foreground truncate text-xs"
                      :title="row.lastLogonUser"
                    >
                      {{ row.lastLogonUser }}
                    </div>
                  </template>
                  <span v-else class="text-muted-foreground">—</span>
                </TableCell>

                <TableCell>
                  <div>{{ row.osName ?? '—' }}</div>
                  <div class="text-muted-foreground text-xs">
                    {{ row.osVersion ?? '' }}
                    <template v-if="row.osBuild">({{ row.osBuild }})</template>
                  </div>
                </TableCell>

                <TableCell>
                  <Badge variant="outline" :class="sourceBadgeClass(row.updateSource)">
                    {{ UPDATE_SOURCE_LABELS[row.updateSource ?? 'unknown'] }}
                  </Badge>
                </TableCell>

                <TableCell class="tabular text-right">{{ row.openUpdates }}</TableCell>

                <TableCell class="tabular text-right">
                  <span :class="row.openSecurityUpdates > 0 ? 'text-destructive font-semibold' : ''">
                    {{ row.openSecurityUpdates }}
                  </span>
                </TableCell>

                <TableCell class="tabular text-right">
                  <template v-if="row.patchAgeDays === null">—</template>
                  <template v-else>{{ row.patchAgeDays }} T</template>
                </TableCell>

                <TableCell>
                  <span :title="formatDateTime(row.lastSeenAt)">
                    {{ formatRelative(row.lastSeenAt) }}
                  </span>
                  <Badge v-if="!row.enrolledAt" variant="destructive" class="ml-2">
                    ohne Agent
                  </Badge>
                </TableCell>

                <TableCell class="tabular">
                  {{ row.agentVersion ?? '—' }}
                  <!-- Ein offener Auftrag gehört neben die laufende Version:
                       Erst beides zusammen sagt, ob ein Gerät zurückliegt oder
                       nur noch nicht so weit ist. -->
                  <div
                    v-if="row.updateJobVersion"
                    class="text-muted-foreground truncate text-xs"
                    :title="`Update-Auftrag auf ${row.updateJobVersion}`"
                  >
                    → {{ row.updateJobVersion }}
                  </div>
                </TableCell>

                <TableCell
                  :title="row.lastBootAt ? `Letzter Neustart: ${formatDateTime(row.lastBootAt)}` : undefined"
                >
                  <AlertTriangle v-if="row.pendingReboot" class="text-warning size-4" />
                  <span v-else class="text-muted-foreground">—</span>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <TablePager
          v-model:page="page"
          v-model:limit="limit"
          :total="total"
          @update:page="load"
          @update:limit="
            page = 1;
            load();
          "
        />
      </div>
    </div>

    <Dialog :open="confirmAgentUpdate" @update:open="confirmAgentUpdate = false">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Agent auf {{ updatableSelected.length }} Geräten aktualisieren?</DialogTitle>
          <DialogDescription>
            Jedes Gerät bekommt einen Auftrag auf die als aktuell markierte Agent-Version und holt
            ihn beim nächsten Check-in ab. Geräte, die schon darauf laufen oder einen offenen
            Auftrag haben, werden übergangen.
            <template v-if="updatableSelected.length < selected.size">
              {{ selected.size - updatableSelected.length }} der ausgewählten sind archiviert oder
              haben keinen Agent und bleiben aussen vor.
            </template>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="confirmAgentUpdate = false">Abbrechen</Button>
          <Button :disabled="busy" @click="updateAgents">
            <Loader2 v-if="busy" class="size-4 animate-spin" />
            Aufträge anlegen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="confirmDelete" @update:open="confirmDelete = false">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ archivedSelected.length }} archivierte Geräte endgültig löschen?</DialogTitle>
          <DialogDescription>
            Die Geräte verschwinden samt Check-ins, Update-Historie und Aufträgen; die Auswertungen
            vergangener Zeiträume zählen sie danach nicht mehr mit. Das lässt sich nicht rückgängig
            machen. Meldet sich ein Agent noch einmal oder taucht ein Konto im AD wieder auf,
            entsteht ein neues Gerät ohne Historie.
            <template v-if="archivedSelected.length < selected.size">
              {{ selected.size - archivedSelected.length }} der ausgewählten sind nicht archiviert
              und bleiben bestehen.
            </template>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="confirmDelete = false">Abbrechen</Button>
          <Button variant="destructive" :disabled="busy" @click="deleteSelected">
            <Loader2 v-if="busy" class="size-4 animate-spin" />
            Löschen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <InstallDialog
      v-model:open="installDialog"
      :device-ids="updatableSelected.map((row) => row.id)"
      @created="onInstallCreated"
    />
  </div>
</template>
