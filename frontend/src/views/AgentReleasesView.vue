<script setup lang="ts">
import Button from 'primevue/button';
import Card from 'primevue/card';
import Column from 'primevue/column';
import ConfirmDialog from 'primevue/confirmdialog';
import DataTable from 'primevue/datatable';
import FileUpload, { type FileUploadSelectEvent } from 'primevue/fileupload';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Tag from 'primevue/tag';
import Textarea from 'primevue/textarea';
import { useConfirm } from 'primevue/useconfirm';
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { del, get, post, upload } from '@/api/client';
import type {
  AgentRelease,
  AgentUpdateJobState,
  AgentUpdateJobView,
  CreateUpdateJobsResult,
} from '@/api/types';
import { formatBytes, formatDateTime } from '@/format';

const router = useRouter();
const confirm = useConfirm();

const releases = ref<AgentRelease[]>([]);
const jobs = ref<AgentUpdateJobView[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const version = ref('');
const notes = ref('');
const file = ref<File | null>(null);

async function load(): Promise<void> {
  error.value = null;
  try {
    const [r, j] = await Promise.all([
      get<AgentRelease[]>('/api/agent-releases'),
      get<AgentUpdateJobView[]>('/api/agent-update-jobs', { limit: 100 }),
    ]);
    releases.value = r;
    jobs.value = j;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Die Releases konnten nicht geladen werden.';
  } finally {
    loading.value = false;
  }
}

function onSelect(event: FileUploadSelectEvent): void {
  const selected = Array.isArray(event.files) ? event.files[0] : event.files;
  file.value = selected ?? null;

  // Die Version aus dem Dateinamen vorschlagen, falls er sie enthält.
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(selected?.name ?? '');
  if (match && !version.value) {
    version.value = match[1];
  }
}

async function publish(): Promise<void> {
  if (!file.value || !version.value) {
    return;
  }

  busy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const form = new FormData();
    form.append('version', version.value);
    if (notes.value) {
      form.append('notes', notes.value);
    }
    form.append('file', file.value);

    const created = await upload<AgentRelease>('/api/agent-releases', form);
    notice.value = `Version ${created.version} aufgenommen (SHA-256 ${created.sha256.slice(0, 16)}…).`;

    version.value = '';
    notes.value = '';
    file.value = null;
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Der Upload ist fehlgeschlagen.';
  } finally {
    busy.value = false;
  }
}

async function setCurrent(release: AgentRelease): Promise<void> {
  busy.value = true;
  try {
    releases.value = await post<AgentRelease[]>(`/api/agent-releases/${release.id}/current`);
    notice.value = `${release.version} ist jetzt die aktuelle Version.`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Änderung fehlgeschlagen.';
  } finally {
    busy.value = false;
  }
}

function remove(release: AgentRelease): void {
  confirm.require({
    header: 'Version entfernen',
    message:
      `${release.version} samt Datei löschen? Geräte, die diese Version melden, bleiben ` +
      'unberührt — nur ein erneutes Ausrollen ist danach nicht mehr möglich.',
    acceptLabel: 'Entfernen',
    rejectLabel: 'Abbrechen',
    acceptProps: { severity: 'danger' },
    accept: async () => {
      try {
        releases.value = await del<AgentRelease[]>(`/api/agent-releases/${release.id}`);
      } catch (e) {
        error.value = e instanceof Error ? e.message : 'Entfernen fehlgeschlagen.';
      }
    },
  });
}

function rollOut(release: AgentRelease): void {
  confirm.require({
    header: 'Ausrollen',
    message:
      `Alle aktiven Geräte, die nicht auf ${release.version} laufen, erhalten einen ` +
      'Update-Auftrag. Sie holen ihn beim nächsten Check-in ab und tauschen sich selbst aus.',
    acceptLabel: 'Aufträge anlegen',
    rejectLabel: 'Abbrechen',
    accept: async () => {
      busy.value = true;
      try {
        const result = await post<CreateUpdateJobsResult>('/api/agent-update-jobs', {
          targetVersion: release.version,
        });
        notice.value =
          `${result.created} Auftrag/Aufträge auf ${result.targetVersion} angelegt` +
          (result.skipped > 0 ? `, ${result.skipped} übersprungen (bereits ein Auftrag offen).` : '.');
        await load();
      } catch (e) {
        error.value = e instanceof Error ? e.message : 'Ausrollen fehlgeschlagen.';
      } finally {
        busy.value = false;
      }
    },
  });
}

const JOB_STATE_LABELS: Record<AgentUpdateJobState, string> = {
  pending: 'offen',
  delivered: 'zugestellt',
  installing: 'wird installiert',
  done: 'erledigt',
  failed: 'gescheitert',
};

function jobSeverity(state: AgentUpdateJobState): 'success' | 'danger' | 'info' | 'warn' {
  if (state === 'done') return 'success';
  if (state === 'failed') return 'danger';
  if (state === 'installing') return 'warn';
  return 'info';
}

onMounted(load);
</script>

<template>
  <div class="page">
    <ConfirmDialog />

    <div class="page-header">
      <h1>Agent-Versionen</h1>
    </div>

    <Message v-if="error" severity="error" :closable="false" style="margin-bottom: 1rem">
      {{ error }}
    </Message>
    <Message v-if="notice" severity="success" :closable="false" style="margin-bottom: 1rem">
      {{ notice }}
    </Message>

    <Card style="margin-bottom: 1rem">
      <template #title>Neue Version aufnehmen</template>
      <template #subtitle>
        Die mit <code>dotnet publish</code> erzeugte <code>wiupmo-agent.exe</code>. Die Prüfsumme
        wird beim Hochladen gebildet; der Agent vergleicht die heruntergeladene Datei dagegen und
        tauscht nur bei Übereinstimmung.
      </template>

      <template #content>
        <div class="upload-grid">
          <div class="field">
            <label for="version">Version</label>
            <InputText id="version" v-model="version" placeholder="0.2.0" />
            <small class="muted">Form 1.2.3, optional mit Vorab-Kennzeichen.</small>
          </div>

          <div class="field">
            <label for="notes">Anmerkungen</label>
            <Textarea id="notes" v-model="notes" rows="2" auto-resize />
          </div>
        </div>

        <FileUpload
          mode="basic"
          accept=".exe"
          :max-file-size="300000000"
          choose-label="Datei wählen"
          :auto="false"
          custom-upload
          @select="onSelect"
        />

        <p v-if="file" class="muted" style="margin-top: 0.5rem">
          {{ file.name }} · {{ formatBytes(String(file.size)) }}
        </p>
      </template>

      <template #footer>
        <Button
          label="Aufnehmen"
          icon="pi pi-upload"
          :disabled="!file || !version"
          :loading="busy"
          @click="publish"
        />
      </template>
    </Card>

    <DataTable
      :value="releases"
      :loading="loading"
      size="small"
      striped-rows
      data-key="id"
      style="margin-bottom: 1.5rem"
    >
      <template #empty>Noch keine Version hinterlegt.</template>

      <Column header="Version">
        <template #body="{ data }">
          <strong>{{ (data as AgentRelease).version }}</strong>
          <Tag
            v-if="(data as AgentRelease).isCurrent"
            value="aktuell"
            severity="success"
            style="margin-left: 0.5rem"
          />
        </template>
      </Column>

      <Column header="Grösse" body-class="num" header-class="num">
        <template #body="{ data }">{{ formatBytes((data as AgentRelease).sizeBytes) }}</template>
      </Column>

      <Column header="SHA-256">
        <template #body="{ data }">
          <code style="font-size: 0.75rem">{{ (data as AgentRelease).sha256.slice(0, 16) }}…</code>
        </template>
      </Column>

      <Column header="Geräte" body-class="num" header-class="num">
        <template #body="{ data }">{{ (data as AgentRelease).devices }}</template>
      </Column>

      <Column header="Aufgenommen">
        <template #body="{ data }">{{ formatDateTime((data as AgentRelease).releasedAt) }}</template>
      </Column>

      <Column field="notes" header="Anmerkungen" />

      <Column header="" style="width: 1%">
        <template #body="{ data }">
          <div style="display: flex; gap: 0.35rem; white-space: nowrap">
            <Button
              v-if="!(data as AgentRelease).isCurrent"
              label="Als aktuell"
              size="small"
              severity="secondary"
              outlined
              @click="setCurrent(data as AgentRelease)"
            />
            <Button
              label="Ausrollen"
              icon="pi pi-send"
              size="small"
              @click="rollOut(data as AgentRelease)"
            />
            <Button
              icon="pi pi-trash"
              size="small"
              severity="danger"
              text
              @click="remove(data as AgentRelease)"
            />
          </div>
        </template>
      </Column>
    </DataTable>

    <h2 style="font-size: 1.05rem">Update-Aufträge</h2>

    <DataTable :value="jobs" :loading="loading" size="small" striped-rows paginator :rows="25" data-key="id">
      <template #empty>Noch keine Aufträge.</template>

      <Column header="Gerät">
        <template #body="{ data }">
          <Button
            :label="(data as AgentUpdateJobView).hostname"
            link
            size="small"
            @click="router.push({ name: 'device', params: { id: (data as AgentUpdateJobView).deviceId } })"
          />
        </template>
      </Column>

      <Column field="targetVersion" header="Zielversion" />

      <Column header="Zustand">
        <template #body="{ data }">
          <Tag
            :value="JOB_STATE_LABELS[(data as AgentUpdateJobView).state]"
            :severity="jobSeverity((data as AgentUpdateJobView).state)"
          />
        </template>
      </Column>

      <Column header="Angelegt">
        <template #body="{ data }">{{ formatDateTime((data as AgentUpdateJobView).createdAt) }}</template>
      </Column>

      <Column header="Abgeschlossen">
        <template #body="{ data }">
          {{ formatDateTime((data as AgentUpdateJobView).completedAt) }}
        </template>
      </Column>

      <Column header="Fehler">
        <template #body="{ data }">
          <span v-if="(data as AgentUpdateJobView).error" style="color: var(--p-red-500)">
            {{ (data as AgentUpdateJobView).error }}
          </span>
          <span v-else class="muted">—</span>
        </template>
      </Column>
    </DataTable>
  </div>
</template>

<style scoped>
.upload-grid {
  display: grid;
  grid-template-columns: minmax(12rem, 1fr) 2fr;
  gap: 0 1.5rem;
}

@media (max-width: 50rem) {
  .upload-grid {
    grid-template-columns: 1fr;
  }
}
</style>
