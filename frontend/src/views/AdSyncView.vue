<script setup lang="ts">
import Button from 'primevue/button';
import Card from 'primevue/card';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Message from 'primevue/message';
import Tag from 'primevue/tag';
import { onMounted, ref } from 'vue';
import { get, post } from '@/api/client';
import type { AdStatus, AdSyncResult, AdSyncRun } from '@/api/types';
import { formatDateTime } from '@/format';

const status = ref<AdStatus | null>(null);
const runs = ref<AdSyncRun[]>([]);
const loading = ref(true);
const syncing = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

async function load(): Promise<void> {
  error.value = null;
  try {
    const [current, history] = await Promise.all([
      get<AdStatus>('/api/ad/status'),
      get<AdSyncRun[]>('/api/ad/sync-runs', { limit: 25 }),
    ]);
    status.value = current;
    runs.value = history;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Der AD-Status konnte nicht geladen werden.';
  } finally {
    loading.value = false;
  }
}

async function runSync(): Promise<void> {
  syncing.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await post<AdSyncResult>('/api/ad/sync');

    // Der Endpunkt antwortet auch bei einem gescheiterten Abgleich mit 200 —
    // der Lauf ist protokolliert, das ist kein Fehler der Anfrage.
    if (result.status === 'failed') {
      error.value = result.error ?? 'Der Abgleich ist fehlgeschlagen.';
    } else {
      notice.value =
        `${result.devicesFound} Konten gelesen, ${result.devicesCreated} neu angelegt, ` +
        `${result.devicesReactivated} reaktiviert, ${result.devicesArchived} archiviert.`;
    }

    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Der Abgleich konnte nicht gestartet werden.';
  } finally {
    syncing.value = false;
  }
}

function statusSeverity(value: string): 'success' | 'danger' | 'info' {
  if (value === 'success') return 'success';
  if (value === 'failed') return 'danger';
  return 'info';
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h1>AD-Abgleich</h1>
      <Button
        label="Jetzt abgleichen"
        icon="pi pi-refresh"
        :loading="syncing"
        :disabled="!status?.enabled || status?.running"
        @click="runSync"
      />
    </div>

    <Message v-if="error" severity="error" :closable="false" style="margin-bottom: 1rem">
      {{ error }}
    </Message>

    <Message v-if="notice" severity="success" :closable="false" style="margin-bottom: 1rem">
      {{ notice }}
    </Message>

    <Message
      v-if="status && !status.enabled"
      severity="warn"
      :closable="false"
      style="margin-bottom: 1rem"
    >
      Die AD-Anbindung ist nicht konfiguriert. Erwartet werden mindestens
      <code>AD_URL</code> und <code>AD_BASE_DN</code> in den Umgebungsvariablen des Stacks.
    </Message>

    <Card v-if="status?.enabled" style="margin-bottom: 1rem">
      <template #content>
        <dl class="detail-grid">
          <div>
            <dt>Server</dt>
            <dd>{{ status.url }}</dd>
          </div>
          <div>
            <dt>Suchwurzel</dt>
            <dd>{{ status.baseDn }}</dd>
          </div>
          <div>
            <dt>Dienstkonto</dt>
            <dd>
              {{ status.bindDn || '—' }}
              <Tag
                v-if="!status.bindPasswordSet"
                value="ohne Passwort"
                severity="warn"
                style="margin-left: 0.5rem"
              />
            </dd>
          </div>
          <div>
            <dt>Filter</dt>
            <dd><code>{{ status.filter }}</code></dd>
          </div>
          <div>
            <dt>Intervall</dt>
            <dd>{{ status.intervalMinutes }} Minuten</dd>
          </div>
        </dl>
      </template>
    </Card>

    <DataTable :value="runs" :loading="loading" size="small" striped-rows data-key="id">
      <template #empty>Noch kein Abgleich gelaufen.</template>

      <Column header="Start" style="width: 12rem">
        <template #body="{ data }">{{ formatDateTime((data as AdSyncRun).startedAt) }}</template>
      </Column>

      <Column header="Ende" style="width: 12rem">
        <template #body="{ data }">{{ formatDateTime((data as AdSyncRun).finishedAt) }}</template>
      </Column>

      <Column header="Auslöser" style="width: 8rem">
        <template #body="{ data }">
          {{ (data as AdSyncRun).trigger === 'manual' ? 'von Hand' : 'geplant' }}
        </template>
      </Column>

      <Column header="Status" style="width: 8rem">
        <template #body="{ data }">
          <Tag
            :value="(data as AdSyncRun).status"
            :severity="statusSeverity((data as AdSyncRun).status)"
          />
        </template>
      </Column>

      <Column header="Gefunden" body-class="num" header-class="num" style="width: 7rem">
        <template #body="{ data }">{{ (data as AdSyncRun).devicesFound }}</template>
      </Column>

      <Column header="Neu" body-class="num" header-class="num" style="width: 6rem">
        <template #body="{ data }">{{ (data as AdSyncRun).devicesCreated }}</template>
      </Column>

      <Column header="Archiviert" body-class="num" header-class="num" style="width: 7rem">
        <template #body="{ data }">{{ (data as AdSyncRun).devicesArchived }}</template>
      </Column>

      <Column header="Fehler">
        <template #body="{ data }">
          <span v-if="(data as AdSyncRun).error" style="color: var(--p-red-500)">
            {{ (data as AdSyncRun).error }}
          </span>
          <span v-else class="muted">—</span>
        </template>
      </Column>
    </DataTable>
  </div>
</template>
