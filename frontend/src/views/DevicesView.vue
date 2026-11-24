<script setup lang="ts">
import {
  AlertTriangle,
  ArrowUpCircle,
  Download,
  Loader2,
  MonitorDown,
  Power,
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
import RestartDialog from '@/components/RestartDialog.vue';
import MultiSelectFilter from '@/components/MultiSelectFilter.vue';
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

/** Eine oder mehrere Update-Quellen; leer heisst: alle. */
const updateSources = ref<UpdateSource[]>([]);

/** Gewählte Organisationseinheiten, jeweils einschliesslich allem darunter. */
const ous = ref<string[]>([]);
const units = ref<DeviceOu[]>([]);

/** Gemeldete Agent-Versionen, exakt. Die Auswahl kommt aus der Auswertung. */
const agentVersions = ref<string[]>([]);
const versionCounts = ref<AgentVersionCount[]>([]);

/**
 * Tage als Zahlenfeld statt fester Stufen. Leer heisst egal — und muss leer
 * bleiben, nicht zu 0 werden: 0 ist ein gültiger Filter.
 *
 * Zahl oder Text: Vue macht aus dem Wert eines `type="number"`-Feldes von sich
 * aus eine Zahl, solange etwas darin steht, und lässt ein leeres Feld als
 * leeren Text. Mit `.trim()` auf dem Wert brach die Liste deshalb ab.
 */
const staleDaysText = ref<string | number>('');

/** Letzter Neustart länger her als so viele Tage. Geräte ohne bekannten Neustart fallen heraus. */
const notRebootedDaysText = ref<string | number>('');
const hasOpenSecurity = ref(false);

function daysOf(input: string | number): number | undefined {
  const text = String(input).trim();
  const value = Number(text);
  return text !== '' && Number.isInteger(value) && value >= 0 && value <= 3650 ? value : undefined;
}

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

/** Versionen ohne Angabe fehlen: Nach „unbekannt“ lässt sich nicht filtern. */
const versionOptions = computed(() =>
  versionCounts.value
    .filter((entry) => entry.version !== null)
    .map((entry) => ({ value: entry.version as string, label: `${entry.version} (${entry.devices})` })),
);

/**
 * Platzhalter für „keine Einschränkung".
 *
 * Reka lässt eine leere Zeichenkette als Auswahlwert nicht zu — die steht dort
 * für „nichts gewählt" und würde den Platzhaltertext zurückholen. Der Wert
 * muss deshalb an genau einer Stelle wieder herausgefiltert werden, sonst geht
 * er als Filter ans Backend und wird dort als ungültig abgewiesen.
 */
const ANY = ' ';

function onSourcesChange(value: string[]): void {
  updateSources.value = value as UpdateSource[];
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

function onOusChange(value: string[]): void {
  ous.value = value;
  onFilterChange();
}

function onAgentVersionsChange(value: string[]): void {
  agentVersions.value = value;
  onFilterChange();
}

async function loadAgentVersions(): Promise<void> {
  try {
    versionCounts.value = await get<AgentVersionCount[]>('/api/reports/agent-versions');
  } catch {
    // Nur die Auswahl im Filter; ohne sie bleibt die Liste bedienbar.
    versionCounts.value = [];
  }
}

let daysTimer: ReturnType<typeof setTimeout> | undefined;

/** Wie die Suche mit kurzer Pause: Bei „30“ soll nicht erst nach „3“ gefiltert werden. */
function onDaysInput(): void {
  clearTimeout(daysTimer);
  daysTimer = setTimeout(onFilterChange, 400);
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
    ou: ous.value,
    agentVersion: agentVersions.value,
    updateSource: updateSources.value,
    staleDays: daysOf(staleDaysText.value),
    notRebootedDays: daysOf(notRebootedDaysText.value),
    hasOpenSecurity: hasOpenSecurity.value || undefined,
    // Hier bewusst `??` statt `||`: `false` ist ein Filter, kein leerer Wert.
    pendingReboot: pendingReboot.value ?? undefined,
    hasAgent: hasAgent.value ?? undefined,
  };
}

// --- Filter in der Adresse ------------------------------------------------------

/**
 * Die Filter stehen in der Adresse der Liste. Wer ein Gerät öffnet und mit
 * „Zurück“ wiederkommt, findet die Liste so vor, wie er sie verlassen hat —
 * und eine gefilterte Liste lässt sich als Lesezeichen ablegen oder schicken.
 * Dieselben Schlüssel benutzen die Verweise vom Dashboard.
 */
function readQuery(): void {
  const query = route.query;
  const text = (key: string): string => (typeof query[key] === 'string' ? (query[key] as string) : '');
  const list = (key: string): string[] => {
    const value = query[key];
    return (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string' && v !== '');
  };
  const flag = (key: string): boolean | null => (text(key) === '1' ? true : text(key) === '0' ? false : null);

  search.value = text('search');
  if (text('status') === 'archived' || text('status') === 'all') status.value = text('status') as 'archived' | 'all';
  updateSources.value = list('updateSource').filter((v): v is UpdateSource => v in UPDATE_SOURCE_LABELS);
  ous.value = list('ou');
  agentVersions.value = list('agentVersion');
  staleDaysText.value = daysOf(text('staleDays')) !== undefined ? text('staleDays') : '';
  notRebootedDaysText.value = daysOf(text('notRebootedDays')) !== undefined ? text('notRebootedDays') : '';
  hasOpenSecurity.value = text('hasOpenSecurity') === '1';
  pendingReboot.value = flag('pendingReboot');
  hasAgent.value = flag('hasAgent');
  if (text('sortBy')) sortBy.value = text('sortBy');
  if (text('sortDir') === 'asc' || text('sortDir') === 'desc') sortDir.value = text('sortDir') as 'asc' | 'desc';
  page.value = Math.max(1, Number(text('page')) || 1);
  if ([10, 25, 50, 100, 200].includes(Number(text('limit')))) limit.value = Number(text('limit'));
}

/** Ersetzt den Eintrag im Verlauf: Jeder Filterklick als eigener Schritt wäre beim Zurückgehen lästig. */
function writeQuery(): void {
  const flag = (value: boolean | null): string | undefined => (value === null ? undefined : value ? '1' : '0');
  const staleDays = daysOf(staleDaysText.value);
  const notRebootedDays = daysOf(notRebootedDaysText.value);

  void router.replace({
    query: {
      search: search.value || undefined,
      status: status.value !== 'active' ? status.value : undefined,
      updateSource: updateSources.value.length ? updateSources.value : undefined,
      ou: ous.value.length ? ous.value : undefined,
      agentVersion: agentVersions.value.length ? agentVersions.value : undefined,
      staleDays: staleDays !== undefined ? String(staleDays) : undefined,
      notRebootedDays: notRebootedDays !== undefined ? String(notRebootedDays) : undefined,
      hasOpenSecurity: hasOpenSecurity.value ? '1' : undefined,
      pendingReboot: flag(pendingReboot.value),
      hasAgent: flag(hasAgent.value),
      sortBy: sortBy.value !== 'hostname' ? sortBy.value : undefined,
      sortDir: sortDir.value !== 'asc' ? sortDir.value : undefined,
      page: page.value > 1 ? String(page.value) : undefined,
      limit: limit.value !== 25 ? String(limit.value) : undefined,
    },
  });
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  writeQuery();

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
const restartDialog = ref(false);

/** Nach einem Sammelauftrag ist die Auswahl erledigt. */
function onJobsCreated(): void {
  clearSelection();
}
const busy = ref(false);

async function updateAgents(): Promise<void> {
  busy.value = true;
  try {
    const ids = updatableSelected.value.map((row) => row.id);
    const result = await post<CreateUpdateJobsResult>('/api/agent-update-jobs', { deviceIds: ids });
    const current = ids.length - result.created - result.skipped;
    const rolloutId = result.rolloutId;
    toast.success(`${result.created} Update-Auftrag/-Aufträge auf ${result.targetVersion} angelegt.`, {
      description:
        [
          result.skipped > 0 ? `${result.skipped} mit bereits offenem Auftrag` : '',
          current > 0 ? `${current} schon auf dieser Version` : '',
        ]
          .filter(Boolean)
          .join(', ') || 'Die Geräte holen den Auftrag beim nächsten Check-in ab.',
      action: rolloutId
        ? { label: 'Anzeigen', onClick: () => void router.push({ name: 'agents', query: { rollout: rolloutId } }) }
        : undefined,
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
  ous.value = [];
  agentVersions.value = [];
  updateSources.value = [];
  staleDaysText.value = '';
  notRebootedDaysText.value = '';
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
    // Listen als wiederholter Parameter, wie beim Laden der Liste.
    if (Array.isArray(value)) {
      value.forEach((item) => params.append(key, String(item)));
    } else if (value !== undefined && value !== '') {
      params.set(key, String(value));
    }
  }

  window.location.href = `/api/devices/export?${params.toString()}`;
}

onMounted(() => {
  readQuery();
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
        <MultiSelectFilter
          placeholder="Update-Quelle"
          :options="sourceOptions"
          :model-value="updateSources"
          @update:model-value="onSourcesChange"
        />
        <SourceLegend />
      </div>

      <MultiSelectFilter
        placeholder="Agent-Version"
        class="w-44"
        :options="versionOptions"
        :model-value="agentVersions"
        @update:model-value="onAgentVersionsChange"
      />

      <!-- Tage als Zahl: leer heisst egal. -->
      <label class="border-input flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-sm">
        <span class="text-muted-foreground whitespace-nowrap">Kein Check-in seit</span>
        <input
          v-model="staleDaysText"
          type="number"
          min="0"
          max="3650"
          placeholder="–"
          aria-label="Kein Check-in seit Tagen"
          class="tabular w-12 bg-transparent text-right outline-none"
          @input="onDaysInput"
        />
        <span class="text-muted-foreground">Tagen</span>
      </label>

      <label
        class="border-input flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-sm"
        title="Letzter Neustart länger her als so viele Tage. Geräte ohne bekannten Neustart fallen heraus."
      >
        <span class="text-muted-foreground whitespace-nowrap">Kein Neustart seit</span>
        <input
          v-model="notRebootedDaysText"
          type="number"
          min="0"
          max="3650"
          placeholder="–"
          aria-label="Kein Neustart seit Tagen"
          class="tabular w-12 bg-transparent text-right outline-none"
          @input="onDaysInput"
        />
        <span class="text-muted-foreground">Tagen</span>
      </label>

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
        <OuNavigator :model-value="ous" :units="units" @update:model-value="onOusChange" />
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
              :disabled="updatableSelected.length === 0"
              :title="updatableSelected.length === 0 ? 'Keines der ausgewählten Geräte ist aktiv und hat einen Agent.' : undefined"
              @click="restartDialog = true"
            >
              <Power class="size-4" />
              Neustart anfordern …
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
                  field="patchAgeDays"
                  class="whitespace-normal"
                  numeric
                  :sort-by="sortBy"
                  :sort-dir="sortDir"
                  @sort="onSort"
                >
                  Patch-Alter
                </SortHead>
                <!-- Die langen Köpfe dürfen umbrechen: Sonst bestimmten sie die
                     Spaltenbreite, und die Tabelle lief rechts aus dem Bild. -->
                <SortHead
                  field="lastSeenAt"
                  class="whitespace-normal"
                  :sort-by="sortBy"
                  :sort-dir="sortDir"
                  @sort="onSort"
                >
                  <!-- Geschützter Bindestrich: umbrechen nach „Letzter“, nicht in „Check-in“. -->
                  Letzter Check&#8209;in
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
                <SortHead
                  field="lastBootAt"
                  class="whitespace-normal"
                  :sort-by="sortBy"
                  :sort-dir="sortDir"
                  @sort="onSort"
                >
                  Letzter Neustart
                </SortHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              <template v-if="loading">
                <TableRow v-for="n in 6" :key="n">
                  <TableCell v-for="column in 10" :key="column">
                    <Skeleton class="h-4 w-full" />
                  </TableCell>
                </TableRow>
              </template>

              <TableRow v-else-if="rows.length === 0">
                <TableCell :colspan="10" class="text-muted-foreground py-8 text-center">
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

                <!-- Darf umbrechen: „Windows Server 2022 Standard“ machte die Spalte
                     sonst so breit, dass „Letzter Neustart“ aus dem Bild lief. -->
                <TableCell class="min-w-32 whitespace-normal">
                  <div>{{ row.osName ?? '—' }}</div>
                  <!-- Version und Build bleiben auf einer Zeile; umbrechen darf nur der Name. -->
                  <div class="text-muted-foreground text-xs whitespace-nowrap">
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

                <!-- Wann zuletzt, und ob Windows schon wieder einen verlangt. -->
                <TableCell class="whitespace-nowrap">
                  <span class="inline-flex items-center gap-1.5">
                    <span v-if="row.lastBootAt" :title="formatDateTime(row.lastBootAt)">
                      {{ formatRelative(row.lastBootAt) }}
                    </span>
                    <span v-else class="text-muted-foreground" title="Erst ab Agent 0.8.0 bekannt">—</span>
                    <span
                      v-if="row.pendingReboot"
                      title="Neustart ausstehend"
                      aria-label="Neustart ausstehend"
                      class="inline-flex"
                    >
                      <AlertTriangle class="text-warning size-4" />
                    </span>
                  </span>
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
      @created="onJobsCreated"
    />

    <RestartDialog
      v-model:open="restartDialog"
      :device-ids="updatableSelected.map((row) => row.id)"
      @created="onJobsCreated"
    />
  </div>
</template>
