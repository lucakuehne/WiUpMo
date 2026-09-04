<script setup lang="ts">
import Button from 'primevue/button';
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
import { get } from '@/api/client';
import type {
  ComplianceDevice,
  FailureGroup,
  MissingAgent,
  PatchAgeReport,
  SourceChange,
  StaleAgent,
  TimeToPatch,
  UpdateSourcesReport,
} from '@/api/types';
import {
  UPDATE_SOURCE_LABELS,
  formatDateTime,
  formatHresult,
  formatRelative,
  sourceSeverity,
} from '@/format';

const router = useRouter();

const compliance = ref<ComplianceDevice[]>([]);
const patchAge = ref<PatchAgeReport | null>(null);
const sources = ref<UpdateSourcesReport | null>(null);
const stale = ref<StaleAgent[]>([]);
const missing = ref<MissingAgent[]>([]);
const timeToPatch = ref<TimeToPatch[]>([]);
const failures = ref<FailureGroup[]>([]);

const loading = ref(true);
const error = ref<string | null>(null);

async function load(): Promise<void> {
  try {
    // Alle Auswertungen auf einmal: Es sind kleine Abfragen, und ein Wechsel
    // zwischen den Reitern soll nicht jedes Mal nachladen.
    const [c, p, s, st, m, t, f] = await Promise.all([
      get<ComplianceDevice[]>('/api/reports/compliance'),
      get<PatchAgeReport>('/api/reports/patch-age'),
      get<UpdateSourcesReport>('/api/reports/update-sources'),
      get<StaleAgent[]>('/api/reports/stale-agents'),
      get<MissingAgent[]>('/api/reports/missing-agents'),
      get<TimeToPatch[]>('/api/reports/time-to-patch'),
      get<FailureGroup[]>('/api/reports/failures'),
    ]);

    compliance.value = c;
    patchAge.value = p;
    sources.value = s;
    stale.value = st;
    missing.value = m;
    timeToPatch.value = t;
    failures.value = f;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Die Auswertungen konnten nicht geladen werden.';
  } finally {
    loading.value = false;
  }
}

function openDevice(id: string): void {
  void router.push({ name: 'device', params: { id } });
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h1>Auswertungen</h1>
    </div>

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <Tabs value="compliance">
      <TabList>
        <Tab value="compliance">Compliance ({{ compliance.length }})</Tab>
        <Tab value="patchage">Patch-Alter</Tab>
        <Tab value="sources">Update-Quellen</Tab>
        <Tab value="stale">Stumme Agents ({{ stale.length }})</Tab>
        <Tab value="missing">Ohne Agent ({{ missing.length }})</Tab>
        <Tab value="ttp">Time-to-Patch</Tab>
        <Tab value="failures">Fehlschläge ({{ failures.length }})</Tab>
      </TabList>

      <TabPanels>
        <TabPanel value="compliance">
          <p class="muted">
            Geräte mit sicherheitsrelevanten Updates, die länger offen sind als der Schwellwert
            aus den Einstellungen. Älteste zuerst.
          </p>

          <DataTable :value="compliance" :loading="loading" size="small" striped-rows paginator :rows="25" row-hover
            data-key="deviceId" @row-click="openDevice(($event.data as ComplianceDevice).deviceId)">
            <template #empty>Kein Gerät überschreitet den Schwellwert.</template>

            <Column field="hostname" header="Gerät" sortable />
            <Column field="adOu" header="OU" sortable />
            <Column field="openSecurityUpdates" header="Offen" sortable body-class="num" header-class="num" />
            <Column field="oldestOpenDays" header="seit (Tage)" sortable body-class="num" header-class="num" />
            <Column header="Letzter Check-in">
              <template #body="{ data }">
                {{ formatRelative((data as ComplianceDevice).lastSeenAt) }}
              </template>
            </Column>
            <Column header="Neustart">
              <template #body="{ data }">
                <i v-if="(data as ComplianceDevice).pendingReboot" class="pi pi-exclamation-triangle"
                  style="color: var(--p-orange-500)" />
                <span v-else class="muted">—</span>
              </template>
            </Column>
          </DataTable>
        </TabPanel>

        <TabPanel value="patchage">
          <p class="muted">
            Verteilung über das Alter des jeweils ältesten offenen Updates, und die OS-Builds
            der Flotte — dort zeigt sich, wer beim monatlichen kumulativen Update hängengeblieben ist.
          </p>

          <div class="two-column">
            <DataTable :value="patchAge?.buckets ?? []" :loading="loading" size="small" data-key="label">
              <Column field="label" header="Patch-Alter" />
              <Column field="devices" header="Geräte" body-class="num" header-class="num" />
            </DataTable>

            <DataTable :value="patchAge?.osBuilds ?? []" :loading="loading" size="small" paginator :rows="15">
              <Column field="osName" header="Betriebssystem" />
              <Column field="osBuild" header="Build" />
              <Column field="devices" header="Geräte" body-class="num" header-class="num" />
            </DataTable>
          </div>
        </TabPanel>

        <TabPanel value="sources">
          <p class="muted">
            Rechts die Geräte, deren Quelle sich beim letzten Check-in geändert hat — das ist der
            Migrationsfortschritt, gemessen am tatsächlichen Verhalten statt an der Richtlinie.
          </p>

          <div class="two-column">
            <DataTable :value="sources?.distribution ?? []" :loading="loading" size="small" data-key="source">
              <Column header="Quelle">
                <template #body="{ data }">
                  <Tag :value="UPDATE_SOURCE_LABELS[(data as { source: keyof typeof UPDATE_SOURCE_LABELS }).source]"
                    :severity="sourceSeverity((data as { source: keyof typeof UPDATE_SOURCE_LABELS }).source)" />
                </template>
              </Column>
              <Column field="devices" header="Geräte" body-class="num" header-class="num" />
              <Column field="medianPatchAgeDays" header="Patch-Alter (Median)" body-class="num" header-class="num">
                <template #body="{ data }">
                  {{ (data as { medianPatchAgeDays: number | null }).medianPatchAgeDays ?? '—' }}
                </template>
              </Column>
            </DataTable>

            <DataTable :value="sources?.changes ?? []" :loading="loading" size="small" paginator :rows="15"
              data-key="deviceId" row-hover @row-click="openDevice(($event.data as SourceChange).deviceId)">
              <template #empty>Kein Quellenwechsel festgestellt.</template>
              <Column field="hostname" header="Gerät" />
              <Column header="von → nach">
                <template #body="{ data }">
                  {{ UPDATE_SOURCE_LABELS[(data as SourceChange).previousSource] }}
                  →
                  <strong>{{ UPDATE_SOURCE_LABELS[(data as SourceChange).currentSource] }}</strong>
                </template>
              </Column>
              <Column header="Wann">
                <template #body="{ data }">{{ formatDateTime((data as SourceChange).changedAt) }}</template>
              </Column>
            </DataTable>
          </div>
        </TabPanel>

        <TabPanel value="stale">
          <p class="muted">
            Registriert, aber seit längerem stumm. Das unterscheidet „ist gepatcht" von
            „meldet sich nicht mehr" — zwei Zustände, die in einer Compliance-Zahl sonst gleich aussehen.
          </p>

          <DataTable :value="stale" :loading="loading" size="small" striped-rows paginator :rows="25" row-hover
            data-key="deviceId" @row-click="openDevice(($event.data as StaleAgent).deviceId)">
            <template #empty>Alle Agents melden sich.</template>
            <Column field="hostname" header="Gerät" sortable />
            <Column field="adOu" header="OU" sortable />
            <Column field="daysSilent" header="Stumm seit (Tage)" sortable body-class="num" header-class="num">
              <template #body="{ data }">{{ (data as StaleAgent).daysSilent ?? 'nie gemeldet' }}</template>
            </Column>
            <Column header="Letzter Check-in">
              <template #body="{ data }">{{ formatDateTime((data as StaleAgent).lastSeenAt) }}</template>
            </Column>
            <Column field="agentVersion" header="Agent" />
          </DataTable>
        </TabPanel>

        <TabPanel value="missing">
          <p class="muted">
            Im AD vorhanden, ohne installierten Agent — die Deployment-Lücke.
          </p>

          <DataTable :value="missing" :loading="loading" size="small" striped-rows paginator :rows="25"
            data-key="deviceId">
            <template #empty>Auf jedem AD-Gerät läuft ein Agent.</template>
            <Column field="hostname" header="Gerät" sortable />
            <Column field="adOu" header="OU" sortable />
            <Column field="osName" header="Betriebssystem (aus dem AD)" />
          </DataTable>
        </TabPanel>

        <TabPanel value="ttp">
          <p class="muted">
            Tage von „erstmals als verfügbar gemeldet" bis „installiert". Nur Zustände, in denen
            beide Zeitpunkte bekannt sind — sonst wäre die Zahl frei erfunden.
          </p>

          <DataTable :value="timeToPatch" :loading="loading" size="small" data-key="severity">
            <template #empty>Noch keine abgeschlossenen Installationen mit bekanntem Startzeitpunkt.</template>
            <Column field="severity" header="Einstufung" />
            <Column field="updates" header="Installationen" body-class="num" header-class="num" />
            <Column field="medianDays" header="Median (Tage)" body-class="num" header-class="num" />
            <Column field="p90Days" header="90. Perzentil" body-class="num" header-class="num" />
          </DataTable>
        </TabPanel>

        <TabPanel value="failures">
          <p class="muted">
            Gescheiterte Installationen, nach Update und Fehlercode gruppiert. Trifft derselbe
            Code viele Geräte, ist es kein Einzelfall.
          </p>

          <DataTable :value="failures" :loading="loading" size="small" striped-rows paginator :rows="25"
            data-key="updateId">
            <template #empty>Keine gescheiterten Installationen.</template>
            <Column header="KB">
              <template #body="{ data }">
                <span v-if="(data as FailureGroup).kbArticle">KB{{ (data as FailureGroup).kbArticle }}</span>
                <span v-else class="muted">—</span>
              </template>
            </Column>
            <Column field="title" header="Update" />
            <Column header="Fehlercode">
              <template #body="{ data }">
                <code>{{ formatHresult((data as FailureGroup).hresult) }}</code>
              </template>
            </Column>
            <Column field="devices" header="Geräte" sortable body-class="num" header-class="num" />
          </DataTable>
        </TabPanel>
      </TabPanels>
    </Tabs>
  </div>
</template>

<style scoped>
.two-column {
  display: grid;
  grid-template-columns: minmax(18rem, 1fr) 2fr;
  gap: 1rem;
  align-items: start;
}

@media (max-width: 60rem) {
  .two-column {
    grid-template-columns: 1fr;
  }
}
</style>
