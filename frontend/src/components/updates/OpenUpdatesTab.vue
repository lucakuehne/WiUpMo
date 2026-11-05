<script setup lang="ts">
import { ChevronDown, ChevronRight, Search } from '@lucide/vue';
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get } from '@/api/client';
import type {
  Paged,
  UpdateClassification,
  UpdateClassificationCount,
  UpdateDevices,
  UpdateListItem,
} from '@/api/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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
import HresultCell from '@/components/HresultCell.vue';
import SortHead from '@/components/SortHead.vue';
import TablePager from '@/components/TablePager.vue';
import ClassificationNavigator from '@/components/updates/ClassificationNavigator.vue';
import SeverityBadge from '@/components/updates/SeverityBadge.vue';
import {
  UPDATE_CLASSIFICATION_LABELS,
  UPDATE_STATE_LABELS,
  formatBytes,
  formatDate,
  kbUrl,
  stateBadgeClass,
} from '@/format';

/**
 * Was gerade auf mindestens einem aktiven Gerät offen ist — die Arbeitsliste.
 * Die Geräte hängen aufklappbar unter jedem Update; alles Weitere steht auf
 * der Detailseite. Daneben die Update-Typen wie unter „Alle Updates";
 * gezählt wird auch dort nur, was offen ist.
 *
 * Suche, Typ, Seite und Sortierung stehen in der Adresse, damit der Weg
 * zurück von der Detailseite dieselbe Auswahl zeigt.
 */
const route = useRoute();
const router = useRouter();

const DEFAULT_SORT = 'affectedDevices';
const SORT_FIELDS = ['kbArticle', 'title', 'severity', 'affectedDevices', 'firstSeenAt'];
const CLASSIFICATIONS = Object.keys(UPDATE_CLASSIFICATION_LABELS) as UpdateClassification[];

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

function readQuery(): void {
  const text = (key: string): string => {
    const value = route.query[key];
    return typeof value === 'string' ? value : '';
  };

  search.value = text('search');
  classification.value = CLASSIFICATIONS.find((c) => c === text('classification')) ?? null;
  page.value = Math.max(1, Number(text('page')) || 1);
  if (SORT_FIELDS.includes(text('sortBy'))) sortBy.value = text('sortBy');
  if (text('sortDir') === 'asc' || text('sortDir') === 'desc') sortDir.value = text('sortDir') as 'asc' | 'desc';
}

/** Ersetzt den Eintrag im Verlauf: Jeder Filterklick als eigener Schritt wäre beim Zurückgehen lästig. */
function writeQuery(): void {
  void router.replace({
    query: {
      search: search.value || undefined,
      classification: classification.value ?? undefined,
      page: page.value > 1 ? String(page.value) : undefined,
      sortBy: sortBy.value !== DEFAULT_SORT ? sortBy.value : undefined,
      sortDir: sortDir.value !== 'desc' ? sortDir.value : undefined,
    },
  });
}

/** Aufgeklappte Zeilen mit ihren Gerätelisten, nachgeladen bei Bedarf. */
const expanded = ref<Set<string>>(new Set());
const deviceLists = ref<Record<string, UpdateDevices | undefined>>({});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  writeQuery();

  try {
    const result = await get<Paged<UpdateListItem>>('/api/updates', {
      page: page.value,
      limit: limit.value,
      sortBy: sortBy.value,
      sortDir: sortDir.value,
      search: search.value || undefined,
      classification: classification.value ?? undefined,
      state: 'open',
    });

    rows.value = result.items;
    total.value = result.total;

    // Beim Seitenwechsel ist kein Eintrag mehr derselbe.
    expanded.value = new Set();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Der Update-Katalog konnte nicht geladen werden.';
  } finally {
    loading.value = false;
  }
}

/** Die Zahlen der Navigation hängen nicht vom gewählten Typ ab, nur von der Suche. */
async function loadCounts(): Promise<void> {
  try {
    counts.value = await get<UpdateClassificationCount[]>('/api/updates/classifications', {
      search: search.value || undefined,
      state: 'open',
    });
  } catch {
    // Die Navigation ist Beiwerk; die Liste meldet den Fehler, falls es einer ist.
  }
}

/**
 * Die Geräteliste hängt an jedem Katalogeintrag, wird aber erst beim
 * Aufklappen geholt — bei einigen hundert Updates wäre das Mitladen die
 * teuerste Abfrage der Seite und in den meisten Fällen umsonst.
 */
async function toggleRow(update: UpdateListItem): Promise<void> {
  const next = new Set(expanded.value);

  if (next.has(update.id)) {
    next.delete(update.id);
    expanded.value = next;
    return;
  }

  next.add(update.id);
  expanded.value = next;

  if (!deviceLists.value[update.id]) {
    deviceLists.value = {
      ...deviceLists.value,
      [update.id]: await get<UpdateDevices>(`/api/updates/${update.id}/devices`),
    };
  }
}

function onSort(field: string, dir: 'asc' | 'desc'): void {
  sortBy.value = field;
  sortDir.value = dir;
  page.value = 1;
  void load();
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

let searchTimer: ReturnType<typeof setTimeout> | undefined;

function onSearchInput(): void {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(onFilterChange, 300);
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

      <span class="text-muted-foreground tabular ml-auto text-sm">{{ total }} {{ total === 1 ? 'offenes Update' : 'offene Updates' }}</span>
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
                <TableHead class="w-10" />
                <SortHead field="kbArticle" class="w-28" :sort-by="sortBy" :sort-dir="sortDir" @sort="onSort">
                  KB
                </SortHead>
                <SortHead field="title" :sort-by="sortBy" :sort-dir="sortDir" @sort="onSort">
                  Titel
                </SortHead>
                <SortHead field="severity" class="w-36" :sort-by="sortBy" :sort-dir="sortDir" @sort="onSort">
                  Einstufung
                </SortHead>
                <TableHead class="w-24 text-right">Grösse</TableHead>
                <SortHead
                  field="affectedDevices"
                  numeric
                  class="w-28"
                  :sort-by="sortBy"
                  :sort-dir="sortDir"
                  @sort="onSort"
                >
                  offen auf
                </SortHead>
                <TableHead class="w-28 text-right">installiert</TableHead>
                <TableHead class="w-28 text-right">gescheitert</TableHead>
                <SortHead
                  field="firstSeenAt"
                  class="w-36"
                  :sort-by="sortBy"
                  :sort-dir="sortDir"
                  @sort="onSort"
                >
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
                  Keine offenen Updates gefunden.
                </TableCell>
              </TableRow>

              <template v-for="row in loading ? [] : rows" :key="row.id">
                <TableRow class="cursor-pointer" @click="toggleRow(row)">
                  <TableCell>
                    <ChevronDown v-if="expanded.has(row.id)" class="text-muted-foreground size-4" />
                    <ChevronRight v-else class="text-muted-foreground size-4" />
                  </TableCell>

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
                    <RouterLink
                      :to="{ name: 'update', params: { id: row.id } }"
                      class="hover:underline"
                      @click.stop
                    >
                      {{ row.title }}
                    </RouterLink>
                    <div v-if="row.categories.length" class="text-muted-foreground text-xs">
                      {{ row.categories.join(', ') }}
                    </div>
                  </TableCell>

                  <TableCell><SeverityBadge :update="row" /></TableCell>

                  <TableCell class="tabular text-right">{{ formatBytes(row.sizeBytes) }}</TableCell>

                  <TableCell class="tabular text-right font-semibold">
                    {{ row.affectedDevices }}
                  </TableCell>

                  <TableCell class="tabular text-right">{{ row.installedDevices }}</TableCell>

                  <TableCell class="tabular text-right">
                    <span :class="row.failedDevices > 0 ? 'text-destructive font-semibold' : ''">
                      {{ row.failedDevices }}
                    </span>
                  </TableCell>

                  <TableCell>{{ formatDate(row.firstSeenAt) }}</TableCell>
                </TableRow>

                <TableRow v-if="expanded.has(row.id)" class="hover:bg-transparent">
                  <TableCell :colspan="9" class="bg-muted/30 p-4">
                    <div class="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                      <p v-if="deviceLists[row.id]" class="text-muted-foreground text-xs">
                        {{ deviceLists[row.id]!.unaffected }} registrierte Geräte haben dieses Update nie
                        angeboten bekommen.
                      </p>
                      <p v-else class="text-muted-foreground text-xs">Wird geladen …</p>
                      <RouterLink
                        :to="{ name: 'update', params: { id: row.id } }"
                        class="text-primary text-xs hover:underline"
                      >
                        Alle Angaben zum Update
                      </RouterLink>
                    </div>

                    <div v-if="deviceLists[row.id]" class="rounded-md border bg-background">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Gerät</TableHead>
                            <TableHead class="w-48">Zustand</TableHead>
                            <TableHead class="w-32">Offen seit</TableHead>
                            <TableHead class="w-32">Installiert</TableHead>
                            <TableHead class="w-72">Fehlercode</TableHead>
                          </TableRow>
                        </TableHeader>

                        <TableBody>
                          <TableRow v-if="deviceLists[row.id]!.items.length === 0">
                            <TableCell :colspan="5" class="text-muted-foreground py-6 text-center">
                              Kein Gerät kennt dieses Update.
                            </TableCell>
                          </TableRow>

                          <TableRow
                            v-for="device in deviceLists[row.id]!.items"
                            :key="device.deviceId"
                            class="cursor-pointer"
                            @click="router.push({ name: 'device', params: { id: device.deviceId } })"
                          >
                            <TableCell class="font-medium">{{ device.hostname }}</TableCell>
                            <TableCell>
                              <Badge variant="outline" :class="stateBadgeClass(device.state)">
                                {{ UPDATE_STATE_LABELS[device.state] }}
                              </Badge>
                              <span v-if="device.awaitingReboot" class="text-muted-foreground ml-2 text-xs">
                                wartet auf Neustart
                              </span>
                            </TableCell>
                            <TableCell>{{ formatDate(device.firstAvailableAt) }}</TableCell>
                            <TableCell>{{ formatDate(device.installedAt) }}</TableCell>
                            <TableCell><HresultCell :value="device.hresult" /></TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
                    </div>
                  </TableCell>
                </TableRow>
              </template>
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
