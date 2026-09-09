<script setup lang="ts">
import { ChevronDown, ChevronRight, Search } from '@lucide/vue';
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { get } from '@/api/client';
import type { Paged, UpdateDevices, UpdateListItem } from '@/api/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import {
  UPDATE_STATE_LABELS,
  formatBytes,
  formatDate,
  stateBadgeClass,
} from '@/format';
import HresultCell from '@/components/HresultCell.vue';

const router = useRouter();

const rows = ref<UpdateListItem[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref<string | null>(null);

const page = ref(1);
const limit = ref(25);
const sortBy = ref('affectedDevices');
const sortDir = ref<'asc' | 'desc'>('desc');

const search = ref('');
const isSecurity = ref(false);
const onlyOpen = ref(true);

/** Aufgeklappte Zeilen mit ihren Gerätelisten, nachgeladen bei Bedarf. */
const expanded = ref<Set<string>>(new Set());
const deviceLists = ref<Record<string, UpdateDevices | undefined>>({});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    const result = await get<Paged<UpdateListItem>>('/api/updates', {
      page: page.value,
      limit: limit.value,
      sortBy: sortBy.value,
      sortDir: sortDir.value,
      search: search.value || undefined,
      isSecurity: isSecurity.value || undefined,
      onlyOpen: onlyOpen.value || undefined,
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
}

/**
 * Über den Namen statt über die Referenz: In der Vorlage werden Refs entpackt,
 * ein übergebener Ref käme dort als Wahrheitswert an.
 */
const toggles = { onlyOpen, isSecurity };

function toggleFilter(name: keyof typeof toggles): void {
  toggles[name].value = !toggles[name].value;
  onFilterChange();
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;

function onSearchInput(): void {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(onFilterChange, 300);
}

function kbUrl(article: string): string {
  return `https://support.microsoft.com/help/${article}`;
}

onMounted(load);
</script>

<template>
  <div class="mx-auto max-w-[1600px] px-5 py-6">
    <div class="mb-4 flex flex-wrap items-baseline justify-between gap-3">
      <h1 class="text-xl font-semibold">Updates</h1>
      <span class="text-muted-foreground tabular text-sm">{{ total }} Einträge</span>
    </div>

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

      <Button
        :variant="onlyOpen ? 'default' : 'outline'"
        size="sm"
        @click="toggleFilter('onlyOpen')"
      >
        Nur offene
      </Button>

      <Button
        :variant="isSecurity ? 'default' : 'outline'"
        size="sm"
        @click="toggleFilter('isSecurity')"
      >
        Nur Sicherheit
      </Button>
    </div>

    <Alert v-if="error" variant="destructive" class="mb-4">
      <AlertDescription>{{ error }}</AlertDescription>
    </Alert>

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
              Keine Updates gefunden.
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
                <div>{{ row.title }}</div>
                <div v-if="row.categories.length" class="text-muted-foreground text-xs">
                  {{ row.categories.join(', ') }}
                </div>
              </TableCell>

              <TableCell>
                <Badge
                  v-if="row.isSecurity"
                  variant="outline"
                  class="bg-destructive/15 text-destructive border-destructive/30"
                >
                  {{ row.severity ?? 'Sicherheit' }}
                </Badge>
                <span v-else class="text-muted-foreground">—</span>
              </TableCell>

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
                <p v-if="deviceLists[row.id]" class="text-muted-foreground mb-2 text-xs">
                  {{ deviceLists[row.id]!.unaffected }} registrierte Geräte haben dieses Update nie
                  angeboten bekommen.
                </p>
                <p v-else class="text-muted-foreground text-xs">Wird geladen …</p>

                <div v-if="deviceLists[row.id]" class="rounded-md border bg-background">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Gerät</TableHead>
                        <TableHead class="w-36">Zustand</TableHead>
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
</template>
