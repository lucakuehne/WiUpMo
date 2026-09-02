<script setup lang="ts">
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable, { type DataTablePageEvent, type DataTableSortEvent } from 'primevue/datatable';
import IconField from 'primevue/iconfield';
import InputIcon from 'primevue/inputicon';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Tag from 'primevue/tag';
import ToggleButton from 'primevue/togglebutton';
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { get } from '@/api/client';
import type { Paged, UpdateDevice, UpdateDevices, UpdateListItem } from '@/api/types';
import {
  UPDATE_STATE_LABELS,
  formatBytes,
  formatDate,
  formatHresult,
  stateSeverity,
} from '@/format';

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

/** Aufgeklappte Zeilen mit ihren Geraetelisten, nachgeladen bei Bedarf. */
const expanded = ref<Record<string, boolean>>({});
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
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Der Update-Katalog konnte nicht geladen werden.';
  } finally {
    loading.value = false;
  }
}

/**
 * Die Geraeteliste haengt an jedem Katalogeintrag, wird aber erst beim
 * Aufklappen geholt — bei einigen hundert Updates waere das Mitladen die
 * teuerste Abfrage der Seite und in den meisten Faellen umsonst.
 */
async function onExpand(update: UpdateListItem): Promise<void> {
  if (deviceLists.value[update.id]) {
    return;
  }
  deviceLists.value = {
    ...deviceLists.value,
    [update.id]: await get<UpdateDevices>(`/api/updates/${update.id}/devices`),
  };
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

function onFilterChange(): void {
  page.value = 1;
  void load();
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;

function onSearchInput(): void {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(onFilterChange, 300);
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h1>Updates</h1>
      <span class="muted">{{ total }} Einträge</span>
    </div>

    <div class="filters">
      <IconField>
        <InputIcon class="pi pi-search" />
        <InputText v-model="search" placeholder="Titel oder KB-Nummer" @input="onSearchInput" />
      </IconField>

      <ToggleButton
        v-model="onlyOpen"
        on-label="Nur offene"
        off-label="Nur offene"
        @change="onFilterChange"
      />

      <ToggleButton
        v-model="isSecurity"
        on-label="Nur Sicherheit"
        off-label="Nur Sicherheit"
        @change="onFilterChange"
      />
    </div>

    <Message v-if="error" severity="error" :closable="false" style="margin-bottom: 1rem">
      {{ error }}
    </Message>

    <DataTable
      v-model:expanded-rows="expanded"
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
      @page="onPage"
      @sort="onSort"
      @row-expand="onExpand($event.data as UpdateListItem)"
    >
      <template #empty>Keine Updates gefunden.</template>

      <Column expander style="width: 3rem" />

      <Column field="kbArticle" header="KB" sortable style="width: 8rem">
        <template #body="{ data }">
          <a
            v-if="(data as UpdateListItem).kbArticle"
            :href="`https://support.microsoft.com/help/${(data as UpdateListItem).kbArticle}`"
            target="_blank"
            rel="noreferrer"
          >
            KB{{ (data as UpdateListItem).kbArticle }}
          </a>
          <span v-else class="muted">—</span>
        </template>
      </Column>

      <Column field="title" header="Titel" sortable>
        <template #body="{ data }">
          <div>{{ (data as UpdateListItem).title }}</div>
          <div class="muted" style="font-size: 0.8rem">
            {{ (data as UpdateListItem).categories.join(', ') }}
          </div>
        </template>
      </Column>

      <Column field="severity" header="Einstufung" sortable style="width: 10rem">
        <template #body="{ data }">
          <Tag
            v-if="(data as UpdateListItem).isSecurity"
            :value="(data as UpdateListItem).severity ?? 'Sicherheit'"
            severity="danger"
          />
          <span v-else class="muted">—</span>
        </template>
      </Column>

      <Column header="Grösse" body-class="num" header-class="num" style="width: 7rem">
        <template #body="{ data }">{{ formatBytes((data as UpdateListItem).sizeBytes) }}</template>
      </Column>

      <Column
        field="affectedDevices"
        header="offen auf"
        sortable
        body-class="num"
        header-class="num"
        style="width: 8rem"
      >
        <template #body="{ data }">
          <strong>{{ (data as UpdateListItem).affectedDevices }}</strong>
        </template>
      </Column>

      <Column header="installiert" body-class="num" header-class="num" style="width: 8rem">
        <template #body="{ data }">{{ (data as UpdateListItem).installedDevices }}</template>
      </Column>

      <Column header="gescheitert" body-class="num" header-class="num" style="width: 8rem">
        <template #body="{ data }">
          <span :style="(data as UpdateListItem).failedDevices > 0 ? 'color: var(--p-red-500); font-weight: 600' : ''">
            {{ (data as UpdateListItem).failedDevices }}
          </span>
        </template>
      </Column>

      <Column field="firstSeenAt" header="Erstmals gesehen" sortable style="width: 11rem">
        <template #body="{ data }">{{ formatDate((data as UpdateListItem).firstSeenAt) }}</template>
      </Column>

      <template #expansion="{ data }">
        <div style="padding: 0.5rem 1rem">
          <p v-if="deviceLists[(data as UpdateListItem).id]" class="muted">
            {{ deviceLists[(data as UpdateListItem).id]!.unaffected }} registrierte Geräte haben
            dieses Update nie angeboten bekommen.
          </p>

          <DataTable
            :value="deviceLists[(data as UpdateListItem).id]?.items ?? []"
            size="small"
            data-key="deviceId"
          >
            <template #empty>Kein Gerät kennt dieses Update.</template>

            <Column header="Gerät">
              <template #body="{ data: row }">
                <Button
                  :label="(row as UpdateDevice).hostname"
                  link
                  size="small"
                  @click="router.push({ name: 'device', params: { id: (row as UpdateDevice).deviceId } })"
                />
              </template>
            </Column>

            <Column header="Zustand">
              <template #body="{ data: row }">
                <Tag
                  :value="UPDATE_STATE_LABELS[(row as UpdateDevice).state]"
                  :severity="stateSeverity((row as UpdateDevice).state)"
                />
              </template>
            </Column>

            <Column header="Offen seit">
              <template #body="{ data: row }">
                {{ formatDate((row as UpdateDevice).firstAvailableAt) }}
              </template>
            </Column>

            <Column header="Installiert">
              <template #body="{ data: row }">
                {{ formatDate((row as UpdateDevice).installedAt) }}
              </template>
            </Column>

            <Column header="Fehlercode">
              <template #body="{ data: row }">
                <code v-if="(row as UpdateDevice).hresult">
                  {{ formatHresult((row as UpdateDevice).hresult) }}
                </code>
                <span v-else class="muted">—</span>
              </template>
            </Column>
          </DataTable>
        </div>
      </template>
    </DataTable>
  </div>
</template>
