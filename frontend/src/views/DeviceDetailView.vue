<script setup lang="ts">
import Button from 'primevue/button';
import Card from 'primevue/card';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Message from 'primevue/message';
import Tab from 'primevue/tab';
import TabList from 'primevue/tablist';
import TabPanel from 'primevue/tabpanel';
import TabPanels from 'primevue/tabpanels';
import Tabs from 'primevue/tabs';
import Tag from 'primevue/tag';
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { get, post } from '@/api/client';
import type {
  CreateUpdateJobsResult,
  DeviceCheckin,
  DeviceDetail,
  DeviceUpdate,
  Timeline,
  TimelineEntry,
} from '@/api/types';
import {
  EVENT_TYPE_LABELS,
  UPDATE_SOURCE_LABELS,
  UPDATE_STATE_LABELS,
  eventSeverity,
  formatBytes,
  formatDateTime,
  formatHresult,
  formatRelative,
  sourceSeverity,
  stateSeverity,
} from '@/format';

const props = defineProps<{ id: string }>();

const router = useRouter();

const device = ref<DeviceDetail | null>(null);
const timeline = ref<TimelineEntry[]>([]);
const timelineTotal = ref(0);
const loading = ref(true);
const error = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    const [detail, events] = await Promise.all([
      get<DeviceDetail>(`/api/devices/${props.id}`),
      get<Timeline>(`/api/devices/${props.id}/timeline`, { limit: 100 }),
    ]);

    device.value = detail;
    timeline.value = events.items;
    timelineTotal.value = events.total;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Das Gerät konnte nicht geladen werden.';
  } finally {
    loading.value = false;
  }
}

const updating = ref(false);
const notice = ref<string | null>(null);

/**
 * Legt einen Auftrag auf die als aktuell markierte Version. Ohne eine solche
 * antwortet das Backend mit einem Konflikt — die Meldung sagt dann, was fehlt.
 */
async function requestUpdate(): Promise<void> {
  updating.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await post<CreateUpdateJobsResult>('/api/agent-update-jobs', {
      deviceIds: [props.id],
    });

    notice.value =
      result.created > 0
        ? `Auftrag auf ${result.targetVersion} angelegt. Das Gerät holt ihn beim nächsten Check-in ab.`
        : 'Kein Auftrag nötig — das Gerät läuft bereits auf der Zielversion oder hat einen offenen Auftrag.';
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Der Auftrag konnte nicht angelegt werden.';
  } finally {
    updating.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    <Message v-if="notice" severity="success" :closable="false">{{ notice }}</Message>

    <template v-if="device">
      <div class="page-header">
        <div>
          <Button
            icon="pi pi-arrow-left"
            label="Geräte"
            severity="secondary"
            text
            size="small"
            @click="router.push({ name: 'devices' })"
          />
          <h1 style="margin-top: 0.5rem">{{ device.hostname }}</h1>
        </div>

        <div style="display: flex; gap: 0.5rem; align-items: center">
          <Tag v-if="device.status === 'archived'" value="archiviert" severity="secondary" />
          <Tag
            v-if="device.checkins[0]"
            :value="UPDATE_SOURCE_LABELS[device.checkins[0].updateSource]"
            :severity="sourceSeverity(device.checkins[0].updateSource)"
          />
          <Tag
            v-if="device.checkins[0]?.pendingReboot"
            value="Neustart ausstehend"
            severity="warn"
          />
        </div>
      </div>

      <Card style="margin-bottom: 1rem">
        <template #content>
          <dl class="detail-grid">
            <div>
              <dt>Betriebssystem</dt>
              <dd>{{ device.osName ?? '—' }}</dd>
            </div>
            <div>
              <dt>Version / Build</dt>
              <dd>{{ device.osVersion ?? '—' }} · {{ device.osBuild ?? '—' }}</dd>
            </div>
            <div>
              <dt>Agent-Version</dt>
              <dd style="display: flex; align-items: center; gap: 0.5rem">
                {{ device.agentVersion ?? '—' }}
                <Button
                  v-if="device.enrolledAt"
                  label="Aktualisieren"
                  icon="pi pi-arrow-circle-up"
                  size="small"
                  severity="secondary"
                  outlined
                  :loading="updating"
                  @click="requestUpdate"
                />
              </dd>
            </div>
            <div>
              <dt>Registriert</dt>
              <dd>{{ formatDateTime(device.enrolledAt) }}</dd>
            </div>
            <div>
              <dt>Letzter Check-in</dt>
              <dd :title="formatDateTime(device.lastSeenAt)">
                {{ formatRelative(device.lastSeenAt) }}
              </dd>
            </div>
            <div>
              <dt>Organisationseinheit</dt>
              <dd>{{ device.adOu ?? '—' }}</dd>
            </div>
          </dl>
        </template>
      </Card>

      <Tabs value="updates">
        <TabList>
          <Tab value="updates">Updates ({{ device.updates.length }})</Tab>
          <Tab value="timeline">Verlauf ({{ timelineTotal }})</Tab>
          <Tab value="checkins">Check-ins ({{ device.checkins.length }})</Tab>
        </TabList>

        <TabPanels>
          <TabPanel value="updates">
            <DataTable
              :value="device.updates"
              :loading="loading"
              size="small"
              striped-rows
              paginator
              :rows="25"
              data-key="updateId"
            >
              <template #empty>Für dieses Gerät sind keine Updates bekannt.</template>

              <Column header="Status" style="width: 8rem">
                <template #body="{ data }">
                  <Tag
                    :value="UPDATE_STATE_LABELS[(data as DeviceUpdate).state]"
                    :severity="stateSeverity((data as DeviceUpdate).state)"
                  />
                </template>
              </Column>

              <Column field="kbArticle" header="KB" style="width: 8rem">
                <template #body="{ data }">
                  <a
                    v-if="(data as DeviceUpdate).kbArticle"
                    :href="`https://support.microsoft.com/help/${(data as DeviceUpdate).kbArticle}`"
                    target="_blank"
                    rel="noreferrer"
                  >
                    KB{{ (data as DeviceUpdate).kbArticle }}
                  </a>
                  <span v-else class="muted">—</span>
                </template>
              </Column>

              <Column field="title" header="Titel">
                <template #body="{ data }">
                  <div>{{ (data as DeviceUpdate).title }}</div>
                  <div class="muted" style="font-size: 0.8rem">
                    {{ (data as DeviceUpdate).categories.join(', ') }}
                  </div>
                </template>
              </Column>

              <Column header="Einstufung" style="width: 9rem">
                <template #body="{ data }">
                  <Tag
                    v-if="(data as DeviceUpdate).isSecurity"
                    :value="(data as DeviceUpdate).severity ?? 'Sicherheit'"
                    severity="danger"
                  />
                  <span v-else class="muted">—</span>
                </template>
              </Column>

              <Column header="Grösse" body-class="num" header-class="num" style="width: 7rem">
                <template #body="{ data }">{{ formatBytes((data as DeviceUpdate).sizeBytes) }}</template>
              </Column>

              <Column header="Offen seit" style="width: 11rem">
                <template #body="{ data }">
                  {{ formatDateTime((data as DeviceUpdate).firstAvailableAt) }}
                </template>
              </Column>

              <Column header="Fehlercode" style="width: 9rem">
                <template #body="{ data }">
                  <code v-if="(data as DeviceUpdate).hresult">
                    {{ formatHresult((data as DeviceUpdate).hresult) }}
                  </code>
                  <span v-else class="muted">—</span>
                </template>
              </Column>
            </DataTable>
          </TabPanel>

          <TabPanel value="timeline">
            <DataTable
              :value="timeline"
              size="small"
              striped-rows
              paginator
              :rows="25"
              data-key="id"
            >
              <template #empty>Noch keine Ereignisse.</template>

              <Column header="Zeitpunkt" style="width: 12rem">
                <template #body="{ data }">
                  {{ formatDateTime((data as TimelineEntry).occurredAt) }}
                </template>
              </Column>

              <Column header="Ereignis" style="width: 10rem">
                <template #body="{ data }">
                  <Tag
                    :value="EVENT_TYPE_LABELS[(data as TimelineEntry).eventType]"
                    :severity="eventSeverity((data as TimelineEntry).eventType)"
                  />
                </template>
              </Column>

              <Column field="kbArticle" header="KB" style="width: 8rem">
                <template #body="{ data }">
                  <span v-if="(data as TimelineEntry).kbArticle">
                    KB{{ (data as TimelineEntry).kbArticle }}
                  </span>
                  <span v-else class="muted">—</span>
                </template>
              </Column>

              <Column field="title" header="Update" />
            </DataTable>
          </TabPanel>

          <TabPanel value="checkins">
            <DataTable :value="device.checkins" size="small" striped-rows data-key="id">
              <template #empty>Noch keine Check-ins.</template>

              <Column header="Erfasst">
                <template #body="{ data }">
                  {{ formatDateTime((data as DeviceCheckin).collectedAt) }}
                </template>
              </Column>

              <Column header="Eingegangen">
                <template #body="{ data }">
                  {{ formatDateTime((data as DeviceCheckin).reportedAt) }}
                </template>
              </Column>

              <Column header="Quelle">
                <template #body="{ data }">
                  <Tag
                    :value="UPDATE_SOURCE_LABELS[(data as DeviceCheckin).updateSource]"
                    :severity="sourceSeverity((data as DeviceCheckin).updateSource)"
                  />
                </template>
              </Column>

              <Column field="wsusServerUrl" header="WSUS-Server">
                <template #body="{ data }">
                  <span class="muted">{{ (data as DeviceCheckin).wsusServerUrl ?? '—' }}</span>
                </template>
              </Column>

              <Column field="agentVersion" header="Agent" />
            </DataTable>
          </TabPanel>
        </TabPanels>
      </Tabs>
    </template>
  </div>
</template>
