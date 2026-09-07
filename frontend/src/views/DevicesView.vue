<script setup lang="ts">
import { AlertTriangle, Download, RotateCcw, Search } from '@lucide/vue';
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get } from '@/api/client';
import type { DeviceListItem, Paged, UpdateSource } from '@/api/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import SortHead from '@/components/SortHead.vue';
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
const updateSource = ref<UpdateSource | null>(null);
const staleDays = ref<number | null>(null);
const hasOpenSecurity = ref(false);
const pendingReboot = ref(false);
const withoutAgent = ref(false);

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

function onStaleChange(value: unknown): void {
  staleDays.value = value === ANY || !value ? null : Number(value);
  onFilterChange();
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    // Serverseitig filtern, sortieren und blättern — die Tabelle lädt niemals
    // die ganze Flotte in den Browser.
    const result = await get<Paged<DeviceListItem>>('/api/devices', {
      page: page.value,
      limit: limit.value,
      sortBy: sortBy.value,
      sortDir: sortDir.value,
      search: search.value || undefined,
      updateSource: updateSource.value ?? undefined,
      staleDays: staleDays.value ?? undefined,
      hasOpenSecurity: hasOpenSecurity.value || undefined,
      pendingReboot: pendingReboot.value || undefined,
      withoutAgent: withoutAgent.value || undefined,
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

/** Jede Filteränderung springt zurück auf Seite 1 — sonst zeigt die Tabelle Leere. */
function onFilterChange(): void {
  page.value = 1;
  void load();
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
const booleanFilters = { hasOpenSecurity, pendingReboot, withoutAgent };

function toggleFilter(name: keyof typeof booleanFilters): void {
  booleanFilters[name].value = !booleanFilters[name].value;
  onFilterChange();
}

function resetFilters(): void {
  search.value = '';
  updateSource.value = null;
  staleDays.value = null;
  hasOpenSecurity.value = false;
  pendingReboot.value = false;
  withoutAgent.value = false;
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
  const filters: Record<string, unknown> = {
    sortBy: sortBy.value,
    sortDir: sortDir.value,
    search: search.value || undefined,
    updateSource: updateSource.value ?? undefined,
    staleDays: staleDays.value ?? undefined,
    hasOpenSecurity: hasOpenSecurity.value || undefined,
    pendingReboot: pendingReboot.value || undefined,
    withoutAgent: withoutAgent.value || undefined,
  };

  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') {
      params.set(key, String(value));
    }
  }

  window.location.href = `/api/devices/export?${params.toString()}`;
}

/** Übernimmt Filter, mit denen das Dashboard hierher verlinkt. */
function applyQueryFilters(): void {
  const query = route.query;

  if (typeof query.staleDays === 'string') {
    staleDays.value = Number(query.staleDays);
  }
  if (query.hasOpenSecurity === '1') {
    hasOpenSecurity.value = true;
  }
  if (query.pendingReboot === '1') {
    pendingReboot.value = true;
  }
  if (query.withoutAgent === '1') {
    withoutAgent.value = true;
  }
}

onMounted(() => {
  applyQueryFilters();
  void load();
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
          placeholder="Hostname oder OU"
          class="w-56 pl-8"
          @input="onSearchInput"
        />
      </div>

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

      <Button
        :variant="pendingReboot ? 'default' : 'outline'"
        size="sm"
        @click="toggleFilter('pendingReboot')"
      >
        Neustart ausstehend
      </Button>

      <Button
        :variant="withoutAgent ? 'default' : 'outline'"
        size="sm"
        @click="toggleFilter('withoutAgent')"
      >
        Ohne Agent
      </Button>

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

    <div class="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <SortHead field="hostname" :sort-by="sortBy" :sort-dir="sortDir" @sort="onSort">
              Hostname
            </SortHead>
            <SortHead field="osBuild" :sort-by="sortBy" :sort-dir="sortDir" @sort="onSort">
              Betriebssystem
            </SortHead>
            <SortHead field="updateSource" :sort-by="sortBy" :sort-dir="sortDir" @sort="onSort">
              Quelle
            </SortHead>
            <SortHead field="openUpdates" numeric :sort-by="sortBy" :sort-dir="sortDir" @sort="onSort">
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
            <SortHead field="patchAgeDays" numeric :sort-by="sortBy" :sort-dir="sortDir" @sort="onSort">
              Patch-Alter
            </SortHead>
            <SortHead field="lastSeenAt" :sort-by="sortBy" :sort-dir="sortDir" @sort="onSort">
              Letzter Check-in
            </SortHead>
            <TableHead class="w-20">Neustart</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          <template v-if="loading">
            <TableRow v-for="n in 6" :key="n">
              <TableCell v-for="column in 8" :key="column">
                <Skeleton class="h-4 w-full" />
              </TableCell>
            </TableRow>
          </template>

          <TableRow v-else-if="rows.length === 0">
            <TableCell :colspan="8" class="text-muted-foreground py-8 text-center">
              Keine Geräte gefunden.
            </TableCell>
          </TableRow>

          <TableRow
            v-for="row in loading ? [] : rows"
            :key="row.id"
            class="cursor-pointer"
            @click="openDevice(row.id)"
          >
            <TableCell>
              <div class="font-medium">{{ row.hostname }}</div>
              <!-- Der Pfad statt des DN; der vollständige Wert bleibt als
                   Hinweistext erreichbar. -->
              <div v-if="row.adOu" class="text-muted-foreground truncate text-xs" :title="row.adOu">
                {{ formatDnPath(row.adOu) }}
              </div>
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
              <Badge v-if="!row.enrolledAt" variant="destructive" class="ml-2">ohne Agent</Badge>
            </TableCell>

            <TableCell>
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
</template>
