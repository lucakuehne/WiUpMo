<script setup lang="ts">
import { ArrowLeft, ExternalLink, Search } from '@lucide/vue';
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { get } from '@/api/client';
import type { UpdateDevice, UpdateDevices, UpdateListItem } from '@/api/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import HresultCell from '@/components/HresultCell.vue';
import TablePager from '@/components/TablePager.vue';
import SeverityBadge from '@/components/updates/SeverityBadge.vue';
import { formatDnPath } from '@/dn';
import {
  UPDATE_CLASSIFICATION_LABELS,
  UPDATE_STATE_LABELS,
  formatBytes,
  formatDate,
  formatDateTime,
  formatRelative,
  kbUrl,
  stateBadgeClass,
} from '@/format';

const props = defineProps<{ id: string }>();

const router = useRouter();

const update = ref<UpdateListItem | null>(null);
const devices = ref<UpdateDevices | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    [update.value, devices.value] = await Promise.all([
      get<UpdateListItem>(`/api/updates/${props.id}`),
      get<UpdateDevices>(`/api/updates/${props.id}/devices`),
    ]);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Das Update konnte nicht geladen werden.';
  } finally {
    loading.value = false;
  }
}

/** Zurück in die Liste, wie sie verlassen wurde — sonst in den ganzen Katalog. */
function back(): void {
  if (window.history.state?.back) router.back();
  else void router.push({ name: 'updates', params: { section: 'all' } });
}

// --- Geräte -----------------------------------------------------------------------

type DeviceFilter = 'all' | 'available' | 'failed' | 'installed' | 'other';

const deviceFilter = ref<DeviceFilter>('all');
const deviceSearch = ref('');
const page = ref(1);
const limit = ref(25);

function group(device: UpdateDevice): Exclude<DeviceFilter, 'all'> {
  return device.state === 'available' || device.state === 'failed' || device.state === 'installed'
    ? device.state
    : 'other';
}

/** Die Zahlen sind zugleich die Filter: Ein Klick zeigt genau die gezählten Geräte. */
const filters = computed(() => {
  const items = devices.value?.items ?? [];
  const count = (key: DeviceFilter) =>
    key === 'all' ? items.length : items.filter((device) => group(device) === key).length;

  return (
    [
      { key: 'all', label: 'Alle' },
      { key: 'available', label: 'Offen' },
      { key: 'failed', label: 'Fehlgeschlagen' },
      { key: 'installed', label: 'Installiert' },
      { key: 'other', label: 'Abgelöst oder ausgeblendet' },
    ] as const
  )
    .map((filter) => ({ ...filter, count: count(filter.key) }))
    .filter((filter) => filter.key === 'all' || filter.count > 0 || filter.key === deviceFilter.value);
});

const filtered = computed(() => {
  const term = deviceSearch.value.trim().toLowerCase();
  return (devices.value?.items ?? []).filter(
    (device) =>
      (deviceFilter.value === 'all' || group(device) === deviceFilter.value) &&
      (!term || device.hostname.toLowerCase().includes(term)),
  );
});

const paged = computed(() =>
  filtered.value.slice((page.value - 1) * limit.value, page.value * limit.value),
);

watch([deviceFilter, deviceSearch], () => {
  page.value = 1;
});

onMounted(load);
</script>

<template>
  <div class="mx-auto max-w-[1600px] px-5 py-6">
    <Button variant="ghost" size="sm" class="-ml-2 mb-2" @click="back">
      <ArrowLeft class="size-4" />
      Updates
    </Button>

    <Alert v-if="error" variant="destructive" class="mb-4">
      <AlertDescription>{{ error }}</AlertDescription>
    </Alert>

    <div v-if="loading" class="space-y-4">
      <Skeleton class="h-8 w-2/3" />
      <Skeleton class="h-32 w-full" />
      <Skeleton class="h-64 w-full" />
    </div>

    <template v-else-if="update && devices">
      <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
        <h1 class="max-w-4xl text-xl font-semibold">{{ update.title }}</h1>
        <a
          v-if="update.kbArticle"
          :href="update.supportUrl ?? kbUrl(update.kbArticle)"
          target="_blank"
          rel="noreferrer"
          class="text-primary flex items-center gap-1 text-sm hover:underline"
        >
          KB{{ update.kbArticle }} bei Microsoft
          <ExternalLink class="size-3.5" />
        </a>
      </div>

      <Card class="mb-4">
        <CardContent>
          <dl class="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt class="text-muted-foreground text-xs">Typ</dt>
              <dd>{{ UPDATE_CLASSIFICATION_LABELS[update.classification] }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground text-xs">Einstufung</dt>
              <dd><SeverityBadge :update="update" /></dd>
            </div>
            <div>
              <dt class="text-muted-foreground text-xs">Grösse</dt>
              <dd class="tabular">{{ formatBytes(update.sizeBytes) }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground text-xs">Erstmals gesehen</dt>
              <dd>{{ formatDateTime(update.firstSeenAt) }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground text-xs">Kategorien</dt>
              <dd>{{ update.categories.length > 0 ? update.categories.join(', ') : '—' }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground text-xs">Security Bulletin</dt>
              <dd>{{ update.msrcNumber ?? '—' }}</dd>
            </div>
            <div class="sm:col-span-2">
              <dt class="text-muted-foreground text-xs">Update-ID</dt>
              <dd class="tabular text-sm break-all">{{ update.wuUpdateId }}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <div class="mb-3 flex flex-wrap items-center gap-2">
        <h2 class="mr-2 text-base font-semibold">Geräte</h2>

        <Button
          v-for="filter in filters"
          :key="filter.key"
          :variant="deviceFilter === filter.key ? 'default' : 'outline'"
          size="sm"
          @click="deviceFilter = filter.key"
        >
          {{ filter.label }}
          <span class="tabular opacity-70">{{ filter.count }}</span>
        </Button>

        <div class="relative ml-auto">
          <Search class="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input v-model="deviceSearch" placeholder="Hostname" class="w-56 pl-8" />
        </div>
      </div>

      <p class="text-muted-foreground mb-2 text-xs">
        Nur aktive Geräte. {{ devices.unaffected }} weitere registrierte Geräte haben dieses Update
        nie angeboten bekommen.
      </p>

      <div class="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Gerät</TableHead>
              <TableHead>Organisationseinheit</TableHead>
              <TableHead class="w-48">Zustand</TableHead>
              <TableHead class="w-28">Offen seit</TableHead>
              <TableHead class="w-28">Installiert</TableHead>
              <TableHead class="w-64">Fehlercode</TableHead>
              <TableHead class="w-32">Letzter Check-in</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            <TableRow v-if="paged.length === 0">
              <TableCell :colspan="7" class="text-muted-foreground py-8 text-center">
                {{ devices.items.length === 0 ? 'Kein aktives Gerät kennt dieses Update.' : 'Kein Gerät passt zum Filter.' }}
              </TableCell>
            </TableRow>

            <TableRow
              v-for="device in paged"
              :key="device.deviceId"
              class="cursor-pointer"
              @click="router.push({ name: 'device', params: { id: device.deviceId } })"
            >
              <TableCell class="font-medium">{{ device.hostname }}</TableCell>
              <TableCell class="text-muted-foreground text-sm">
                {{ device.adOu ? formatDnPath(device.adOu) : '—' }}
              </TableCell>
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
              <TableCell>{{ formatRelative(device.lastSeenAt) }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <TablePager v-model:page="page" v-model:limit="limit" :total="filtered.length" />
    </template>
  </div>
</template>
