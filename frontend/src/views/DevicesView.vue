<script setup lang="ts">
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable, { type DataTablePageEvent, type DataTableSortEvent } from 'primevue/datatable';
import IconField from 'primevue/iconfield';
import InputIcon from 'primevue/inputicon';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Select from 'primevue/select';
import Tag from 'primevue/tag';
import ToggleButton from 'primevue/togglebutton';
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { get } from '@/api/client';
import type { DeviceListItem, Paged, UpdateSource } from '@/api/types';
import {
  UPDATE_SOURCE_LABELS,
  formatDateTime,
  formatRelative,
  sourceSeverity,
} from '@/format';

const router = useRouter();

const rows = ref<DeviceListItem[]>([]);
const total = ref(0);
const loading = ref(false);
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
  { value: 3, label: 'seit 3 Tagen' },
  { value: 7, label: 'seit 7 Tagen' },
  { value: 14, label: 'seit 14 Tagen' },
  { value: 30, label: 'seit 30 Tagen' },
];

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    // Serverseitig filtern, sortieren und blaettern — die Tabelle laedt
    // niemals die ganze Flotte in den Browser.
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

function onPage(event: DataTablePageEvent): void {
  page.value = event.page + 1;
  limit.value = event.rows;
  void load();
}

function onSort(event: DataTableSortEvent): void {
  if (typeof event.sortField === 'string') {
    sortBy.value = event.sortField;
    sortDir.value = event.sortOrder === -1 ? 'desc' : 'asc';
  }
  page.value = 1;
  void load();
}

/** Jede Filteraenderung springt zurueck auf Seite 1 — sonst zeigt die Tabelle Leere. */
function onFilterChange(): void {
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

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h1>Geräte</h1>
      <span class="muted">{{ total }} Geräte</span>
    </div>

    <div class="filters">
      <IconField>
        <InputIcon class="pi pi-search" />
        <InputText v-model="search" placeholder="Hostname oder OU" @input="onSearchInput" />
      </IconField>

      <Select
        v-model="updateSource"
        :options="sourceOptions"
        option-label="label"
        option-value="value"
        placeholder="Update-Quelle"
        show-clear
        @change="onFilterChange"
      />

      <Select
        v-model="staleDays"
        :options="staleOptions"
        option-label="label"
        option-value="value"
        placeholder="Kein Check-in"
        show-clear
        @change="onFilterChange"
      />

      <ToggleButton
        v-model="hasOpenSecurity"
        on-label="Sicherheitsupdates offen"
        off-label="Sicherheitsupdates offen"
        @change="onFilterChange"
      />

      <ToggleButton
        v-model="pendingReboot"
        on-label="Neustart ausstehend"
        off-label="Neustart ausstehend"
        @change="onFilterChange"
      />

      <ToggleButton
        v-model="withoutAgent"
        on-label="Ohne Agent"
        off-label="Ohne Agent"
        @change="onFilterChange"
      />

      <Button label="Zurücksetzen" severity="secondary" text size="small" @click="resetFilters" />
    </div>

    <Message v-if="error" severity="error" :closable="false" style="margin-bottom: 1rem">
      {{ error }}
    </Message>

    <DataTable
      :value="rows"
      :loading="loading"
      lazy
      paginator
      :rows="limit"
      :total-records="total"
      :rows-per-page-options="[25, 50, 100]"
      :first="(page - 1) * limit"
      data-key="id"
      removable-sort
      :sort-field="sortBy"
      :sort-order="sortDir === 'asc' ? 1 : -1"
      size="small"
      striped-rows
      row-hover
      @page="onPage"
      @sort="onSort"
      @row-click="openDevice(($event.data as DeviceListItem).id)"
    >
      <template #empty>Keine Geräte gefunden.</template>

      <Column field="hostname" header="Hostname" sortable>
        <template #body="{ data }">
          <strong>{{ (data as DeviceListItem).hostname }}</strong>
          <div v-if="(data as DeviceListItem).adOu" class="muted" style="font-size: 0.8rem">
            {{ (data as DeviceListItem).adOu }}
          </div>
        </template>
      </Column>

      <Column field="osBuild" header="Betriebssystem" sortable>
        <template #body="{ data }">
          <div>{{ (data as DeviceListItem).osName ?? '—' }}</div>
          <div class="muted" style="font-size: 0.8rem">
            {{ (data as DeviceListItem).osVersion ?? '' }}
            {{ (data as DeviceListItem).osBuild ? `(${(data as DeviceListItem).osBuild})` : '' }}
          </div>
        </template>
      </Column>

      <Column field="updateSource" header="Quelle" sortable>
        <template #body="{ data }">
          <Tag
            :value="UPDATE_SOURCE_LABELS[(data as DeviceListItem).updateSource ?? 'unknown']"
            :severity="sourceSeverity((data as DeviceListItem).updateSource)"
          />
        </template>
      </Column>

      <Column field="openUpdates" header="Offen" sortable body-class="num" header-class="num">
        <template #body="{ data }">{{ (data as DeviceListItem).openUpdates }}</template>
      </Column>

      <Column
        field="openSecurityUpdates"
        header="davon Sicherheit"
        sortable
        body-class="num"
        header-class="num"
      >
        <template #body="{ data }">
          <span :style="(data as DeviceListItem).openSecurityUpdates > 0 ? 'color: var(--p-red-500); font-weight: 600' : ''">
            {{ (data as DeviceListItem).openSecurityUpdates }}
          </span>
        </template>
      </Column>

      <Column field="patchAgeDays" header="Patch-Alter" sortable body-class="num" header-class="num">
        <template #body="{ data }">
          <span v-if="(data as DeviceListItem).patchAgeDays === null">—</span>
          <span v-else>{{ (data as DeviceListItem).patchAgeDays }} T</span>
        </template>
      </Column>

      <Column field="lastSeenAt" header="Letzter Check-in" sortable>
        <template #body="{ data }">
          <span :title="formatDateTime((data as DeviceListItem).lastSeenAt)">
            {{ formatRelative((data as DeviceListItem).lastSeenAt) }}
          </span>
          <Tag
            v-if="!(data as DeviceListItem).enrolledAt"
            value="ohne Agent"
            severity="danger"
            style="margin-left: 0.5rem"
          />
        </template>
      </Column>

      <Column header="Neustart">
        <template #body="{ data }">
          <i v-if="(data as DeviceListItem).pendingReboot" class="pi pi-exclamation-triangle" style="color: var(--p-orange-500)" />
          <span v-else class="muted">—</span>
        </template>
      </Column>
    </DataTable>
  </div>
</template>
