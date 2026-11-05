<script setup lang="ts">
import { Download, RotateCcw, Search } from '@lucide/vue';
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get } from '@/api/client';
import type {
  Paged,
  UpdateClassification,
  UpdateClassificationCount,
  UpdateListItem,
  UpdateSeverityFilter,
  UpdateStateFilter,
} from '@/api/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import SortHead from '@/components/SortHead.vue';
import TablePager from '@/components/TablePager.vue';
import ClassificationNavigator from '@/components/updates/ClassificationNavigator.vue';
import SeverityBadge from '@/components/updates/SeverityBadge.vue';
import { UPDATE_CLASSIFICATION_LABELS, formatBytes, formatDate, kbUrl } from '@/format';

/**
 * Der ganze Katalog, aufgebaut wie die Geräteliste: Filter darüber, die
 * Update-Typen daneben, ein Klick führt zur Detailseite.
 *
 * Die Filter stehen in der Adresse. Wer ein Update öffnet und zurückgeht,
 * findet die Liste so vor, wie er sie verlassen hat.
 */
const route = useRoute();
const router = useRouter();

const DEFAULT_SORT = 'firstSeenAt';
const SORT_FIELDS = [
  'kbArticle',
  'title',
  'classification',
  'severity',
  'sizeBytes',
  'affectedDevices',
  'installedDevices',
  'failedDevices',
  'firstSeenAt',
];
const CLASSIFICATIONS = Object.keys(UPDATE_CLASSIFICATION_LABELS) as UpdateClassification[];

const SEVERITY_OPTIONS: { value: UpdateSeverityFilter; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'important', label: 'Important' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'low', label: 'Low' },
  { value: 'none', label: 'Ohne Einstufung' },
];

const STATE_OPTIONS: { value: UpdateStateFilter; label: string }[] = [
  { value: 'open', label: 'Auf Geräten offen' },
  { value: 'failed', label: 'Auf Geräten gescheitert' },
  { value: 'closed', label: 'Nirgends offen' },
];

/** Wie in der Geräteliste: Reka lässt eine leere Zeichenkette als Wert nicht zu. */
const ANY = ' ';

const rows = ref<UpdateListItem[]>([]);
const total = ref(0);
const counts = ref<UpdateClassificationCount[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

const page = ref(1);
const limit = ref(25);
const sortBy = ref(DEFAULT_SORT);
const sortDir = ref<'asc' | 'desc'>('desc');

const search = ref('');
const classification = ref<UpdateClassification | null>(null);
const severity = ref<UpdateSeverityFilter | null>(null);
const state = ref<UpdateStateFilter | null>(null);

function filterParams(): Record<string, string | undefined> {
  return {
    search: search.value || undefined,
    classification: classification.value ?? undefined,
    severity: severity.value ?? undefined,
    state: state.value ?? undefined,
  };
}

function readQuery(): void {
  const text = (key: string): string => {
    const value = route.query[key];
    return typeof value === 'string' ? value : '';
  };

  search.value = text('search');
  classification.value = CLASSIFICATIONS.find((c) => c === text('classification')) ?? null;
  severity.value = SEVERITY_OPTIONS.find((o) => o.value === text('severity'))?.value ?? null;
  state.value = STATE_OPTIONS.find((o) => o.value === text('state'))?.value ?? null;
  page.value = Math.max(1, Number(text('page')) || 1);
  if (SORT_FIELDS.includes(text('sortBy'))) sortBy.value = text('sortBy');
  if (text('sortDir') === 'asc' || text('sortDir') === 'desc') sortDir.value = text('sortDir') as 'asc' | 'desc';
}

/** Ersetzt den Eintrag im Verlauf: Jeder Filterklick als eigener Schritt wäre beim Zurückgehen lästig. */
function writeQuery(): void {
  void router.replace({
    query: {
      ...filterParams(),
      page: page.value > 1 ? String(page.value) : undefined,
      sortBy: sortBy.value !== DEFAULT_SORT ? sortBy.value : undefined,
      sortDir: sortDir.value !== 'desc' ? sortDir.value : undefined,
    },
  });
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  writeQuery();

  try {
    const result = await get<Paged<UpdateListItem>>('/api/updates', {
      ...filterParams(),
      page: page.value,
      limit: limit.value,
      sortBy: sortBy.value,
      sortDir: sortDir.value,
    });
    rows.value = result.items;
    total.value = result.total;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Der Update-Katalog konnte nicht geladen werden.';
  } finally {
    loading.value = false;
  }
}

/** Die Zahlen der Navigation hängen nicht vom gewählten Typ ab, nur von den übrigen Filtern. */
async function loadCounts(): Promise<void> {
  try {
    counts.value = await get<UpdateClassificationCount[]>('/api/updates/classifications', {
      ...filterParams(),
      classification: undefined,
    });
  } catch {
    // Die Navigation ist Beiwerk; die Liste meldet den Fehler, falls es einer ist.
  }
}

function onFilterChange(): void {
  page.value = 1;
  void load();
  void loadCounts();
}

function onClassificationChange(value: UpdateClassification | null): void {
  classification.value = value;
  page.value = 1;
  void load();
}

function onClassificationSelect(value: unknown): void {
  onClassificationChange(value === ANY || !value ? null : (value as UpdateClassification));
}

function onSeverityChange(value: unknown): void {
  severity.value = value === ANY || !value ? null : (value as UpdateSeverityFilter);
  onFilterChange();
}

function onStateChange(value: unknown): void {
  state.value = value === ANY || !value ? null : (value as UpdateStateFilter);
  onFilterChange();
}

function onSort(field: string, dir: 'asc' | 'desc'): void {
  sortBy.value = field;
  sortDir.value = dir;
  page.value = 1;
  void load();
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;

function onSearchInput(): void {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(onFilterChange, 300);
}

function resetFilters(): void {
  search.value = '';
  classification.value = null;
  severity.value = null;
  state.value = null;
  onFilterChange();
}

function exportCsv(): void {
  const params = new URLSearchParams({ sortBy: sortBy.value, sortDir: sortDir.value });
  for (const [key, value] of Object.entries(filterParams())) {
    if (value) params.set(key, value);
  }
  window.location.href = `/api/updates/export?${params.toString()}`;
}

onMounted(() => {
  readQuery();
  void load();
  void loadCounts();
});
</script>

<template>
  <div>
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <div class="relative">
        <Search class="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
        <Input
          v-model="search"
          placeholder="Titel oder KB-Nummer"
          class="w-64 pl-8"
          @input="onSearchInput"
        />
      </div>

      <!-- Unterhalb der Breite, ab der die Navigation daneben steht. -->
      <Select :model-value="classification ?? ''" @update:model-value="onClassificationSelect">
        <SelectTrigger class="w-48 lg:hidden"><SelectValue placeholder="Update-Typ" /></SelectTrigger>
        <SelectContent>
          <SelectItem :value="ANY">Alle Typen</SelectItem>
          <SelectItem v-for="type in CLASSIFICATIONS" :key="type" :value="type">
            {{ UPDATE_CLASSIFICATION_LABELS[type] }}
          </SelectItem>
        </SelectContent>
      </Select>

      <Select :model-value="severity ?? ''" @update:model-value="onSeverityChange">
        <SelectTrigger class="w-44"><SelectValue placeholder="Einstufung" /></SelectTrigger>
        <SelectContent>
          <SelectItem :value="ANY">Alle Einstufungen</SelectItem>
          <SelectItem v-for="option in SEVERITY_OPTIONS" :key="option.value" :value="option.value">
            {{ option.label }}
          </SelectItem>
        </SelectContent>
      </Select>

      <Select :model-value="state ?? ''" @update:model-value="onStateChange">
        <SelectTrigger class="w-52"><SelectValue placeholder="Zustand" /></SelectTrigger>
        <SelectContent>
          <SelectItem :value="ANY">Alle Zustände</SelectItem>
          <SelectItem v-for="option in STATE_OPTIONS" :key="option.value" :value="option.value">
            {{ option.label }}
          </SelectItem>
        </SelectContent>
      </Select>

      <Button variant="ghost" size="sm" @click="resetFilters">
        <RotateCcw class="size-4" />
        Zurücksetzen
      </Button>

      <span class="text-muted-foreground tabular ml-auto text-sm">{{ total }} {{ total === 1 ? 'Update' : 'Updates' }}</span>

      <Button variant="outline" size="sm" @click="exportCsv">
        <Download class="size-4" />
        Export
      </Button>
    </div>

    <Alert v-if="error" variant="destructive" class="mb-4">
      <AlertDescription>{{ error }}</AlertDescription>
    </Alert>

    <div class="flex items-start gap-5">
      <aside class="hidden w-56 shrink-0 lg:block">
        <ClassificationNavigator
          :model-value="classification"
          :counts="counts"
          @update:model-value="onClassificationChange"
        />
      </aside>

      <div class="min-w-0 flex-1">
        <div class="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <SortHead field="kbArticle" class="w-28" :sort-by="sortBy" :sort-dir="sortDir" @sort="onSort">
                  KB
                </SortHead>
                <SortHead field="title" :sort-by="sortBy" :sort-dir="sortDir" @sort="onSort">
                  Titel
                </SortHead>
                <SortHead field="classification" class="w-40" :sort-by="sortBy" :sort-dir="sortDir" @sort="onSort">
                  Typ
                </SortHead>
                <SortHead field="severity" class="w-32" :sort-by="sortBy" :sort-dir="sortDir" @sort="onSort">
                  Einstufung
                </SortHead>
                <SortHead field="sizeBytes" numeric class="w-24" :sort-by="sortBy" :sort-dir="sortDir" @sort="onSort">
                  Grösse
                </SortHead>
                <SortHead field="affectedDevices" numeric class="w-20" :sort-by="sortBy" :sort-dir="sortDir" @sort="onSort">
                  offen
                </SortHead>
                <SortHead field="installedDevices" numeric class="w-24" :sort-by="sortBy" :sort-dir="sortDir" @sort="onSort">
                  installiert
                </SortHead>
                <SortHead field="failedDevices" numeric class="w-24" :sort-by="sortBy" :sort-dir="sortDir" @sort="onSort">
                  gescheitert
                </SortHead>
                <SortHead field="firstSeenAt" class="w-32" :sort-by="sortBy" :sort-dir="sortDir" @sort="onSort">
                  Erstmals gesehen
                </SortHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              <template v-if="loading">
                <TableRow v-for="n in 6" :key="n">
                  <TableCell v-for="column in 9" :key="column">
                    <Skeleton class="h-4 w-full" />
                  </TableCell>
                </TableRow>
              </template>

              <TableRow v-else-if="rows.length === 0">
                <TableCell :colspan="9" class="text-muted-foreground py-8 text-center">
                  Keine Updates gefunden.
                </TableCell>
              </TableRow>

              <TableRow
                v-for="row in loading ? [] : rows"
                :key="row.id"
                class="cursor-pointer"
                @click="router.push({ name: 'update', params: { id: row.id } })"
              >
                <TableCell @click.stop>
                  <a
                    v-if="row.kbArticle"
                    :href="kbUrl(row.kbArticle)"
                    target="_blank"
                    rel="noreferrer"
                    class="text-primary hover:underline"
                  >
                    KB{{ row.kbArticle }}
                  </a>
                  <span v-else class="text-muted-foreground">—</span>
                </TableCell>

                <TableCell>
                  <div>{{ row.title }}</div>
                  <div v-if="row.categories.length" class="text-muted-foreground text-xs">
                    {{ row.categories.join(', ') }}
                  </div>
                </TableCell>

                <TableCell class="text-sm">{{ UPDATE_CLASSIFICATION_LABELS[row.classification] }}</TableCell>
                <TableCell><SeverityBadge :update="row" /></TableCell>
                <TableCell class="tabular text-right">{{ formatBytes(row.sizeBytes) }}</TableCell>
                <TableCell class="tabular text-right font-semibold">{{ row.affectedDevices }}</TableCell>
                <TableCell class="tabular text-right">{{ row.installedDevices }}</TableCell>
                <TableCell class="tabular text-right">
                  <span :class="row.failedDevices > 0 ? 'text-destructive font-semibold' : ''">
                    {{ row.failedDevices }}
                  </span>
                </TableCell>
                <TableCell>{{ formatDate(row.firstSeenAt) }}</TableCell>
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
  </div>
</template>
