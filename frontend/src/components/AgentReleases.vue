<script setup lang="ts">
import { Download, Loader2, Send, Trash2, Upload } from '@lucide/vue';
import { onMounted, ref, useTemplateRef } from 'vue';
import { useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import { del, get, post, upload } from '@/api/client';
import type {
  AgentRelease,
  AgentUpdateJobState,
  AgentUpdateJobView,
  CreateUpdateJobsResult,
} from '@/api/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import JobStateLegend from '@/components/JobStateLegend.vue';
import TablePager from '@/components/TablePager.vue';
import { formatBytes, formatDateTime } from '@/format';
import { usePagedList } from '@/paged';

/**
 * Agent-Versionen und Update-Aufträge.
 *
 * Als Abschnitt der Einstellungen statt als eigene Seite: Das Hinterlegen einer
 * Version ist eine Einrichtungsaufgabe, keine tägliche Arbeit — und sie gehört
 * neben das Enrollment-Token, mit dem sie zusammenspielt.
 */
const router = useRouter();

const releases = ref<AgentRelease[]>([]);
const jobs = ref<AgentUpdateJobView[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref<string | null>(null);

const notes = ref('');
const file = ref<File | null>(null);
const fileInput = useTemplateRef<HTMLInputElement>('fileInput');

// Zehn: Die Auftragsliste steht unter zwei anderen Karten, sie soll die Seite
// nicht in die Länge ziehen.
const jobsPage = usePagedList(jobs, 10);

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

function onSelect(event: Event): void {
  file.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

async function publish(): Promise<void> {
  if (!file.value) {
    return;
  }

  busy.value = true;
  error.value = null;

  try {
    // Ohne Versionsangabe: Das Backend liest sie aus der Programmdatei.
    const form = new FormData();
    if (notes.value) {
      form.append('notes', notes.value);
    }
    form.append('file', file.value);

    const created = await upload<AgentRelease>('/api/agent-releases', form);

    toast.success(`Version ${created.version} aufgenommen.`, {
      description: `SHA-256 ${created.sha256.slice(0, 16)}…`,
    });

    notes.value = '';
    file.value = null;
    if (fileInput.value) {
      fileInput.value.value = '';
    }

    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Der Upload ist fehlgeschlagen.';
  } finally {
    busy.value = false;
  }
}

/**
 * Direkte Navigation statt eines Abrufs über den API-Client: Der Browser soll
 * die Datei speichern, nicht der Code sie im Speicher halten — bei 75 MB ist
 * das der Unterschied zwischen einem Download und einem hängenden Reiter. Das
 * Sitzungscookie geht dabei automatisch mit.
 */
function download(release: AgentRelease): void {
  window.location.href = `/api/agent-releases/${release.id}/download`;
}

async function setCurrent(release: AgentRelease): Promise<void> {
  busy.value = true;

  try {
    releases.value = await post<AgentRelease[]>(`/api/agent-releases/${release.id}/current`);
    toast.success(`${release.version} ist jetzt die aktuelle Version.`);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Änderung fehlgeschlagen.';
  } finally {
    busy.value = false;
  }
}

/**
 * Rückfragen als Dialog auf einem gemerkten Eintrag.
 *
 * Beide Vorgänge sind schwer zurückzunehmen: Das Entfernen löscht die Datei,
 * das Ausrollen setzt eine ganze Flotte in Bewegung.
 */
const pendingRemoval = ref<AgentRelease | null>(null);
const pendingRollOut = ref<AgentRelease | null>(null);

async function remove(): Promise<void> {
  const release = pendingRemoval.value;
  if (!release) {
    return;
  }

  pendingRemoval.value = null;

  try {
    releases.value = await del<AgentRelease[]>(`/api/agent-releases/${release.id}`);
    toast.success(`${release.version} entfernt.`);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Entfernen fehlgeschlagen.';
  }
}

async function rollOut(): Promise<void> {
  const release = pendingRollOut.value;
  if (!release) {
    return;
  }

  pendingRollOut.value = null;
  busy.value = true;

  try {
    const result = await post<CreateUpdateJobsResult>('/api/agent-update-jobs', {
      targetVersion: release.version,
    });

    toast.success(`${result.created} Auftrag/Aufträge auf ${result.targetVersion} angelegt.`, {
      description:
        result.skipped > 0
          ? `${result.skipped} übersprungen — dort ist bereits ein Auftrag offen.`
          : 'Die Geräte holen ihn beim nächsten Check-in ab.',
    });

    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Ausrollen fehlgeschlagen.';
  } finally {
    busy.value = false;
  }
}

const JOB_STATE_LABELS: Record<AgentUpdateJobState, string> = {
  pending: 'offen',
  delivered: 'zugestellt',
  installing: 'wird installiert',
  done: 'erledigt',
  failed: 'gescheitert',
};

/**
 * Jeder Zustand mit eigener Farbe, keiner grau.
 *
 * Zuvor fielen „offen" und „zugestellt" auf denselben neutralen Ton, und weil
 * das die beiden häufigsten sind, sah die Liste farblos aus. Der Fortschritt
 * eines Auftrags läuft von blau über violett und gelb nach grün — beim
 * Überfliegen erkennt man den Stand an der Farbe, nicht erst am Wort.
 */
function jobBadgeClass(state: AgentUpdateJobState): string {
  switch (state) {
    case 'pending':
      return 'bg-chart-1/15 text-chart-1 border-chart-1/30';
    case 'delivered':
      return 'bg-chart-4/15 text-chart-4 border-chart-4/30';
    case 'installing':
      return 'bg-warning/15 text-warning-foreground border-warning/40 dark:text-warning';
    case 'done':
      return 'bg-success/15 text-success border-success/30';
    case 'failed':
      return 'bg-destructive/15 text-destructive border-destructive/30';
    default:
      return 'bg-muted text-muted-foreground border-transparent';
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-4">
    <Alert v-if="error" variant="destructive">
      <AlertDescription>{{ error }}</AlertDescription>
    </Alert>

    <Card>
      <CardHeader>
        <CardTitle>Neue Version aufnehmen</CardTitle>
        <CardDescription>
          Die mit <code>dotnet publish</code> erzeugte <code>wiupmo-agent.exe</code>. Die
          Versionsnummer wird aus der Datei gelesen — sie muss der entsprechen, die der Agent von
          sich meldet. Die Prüfsumme wird beim Hochladen gebildet; der Agent vergleicht die
          heruntergeladene Datei dagegen und tauscht nur bei Übereinstimmung.
        </CardDescription>
      </CardHeader>

      <CardContent class="space-y-4">
        <div class="space-y-1.5">
          <Label for="notes">Anmerkungen</Label>
          <Textarea id="notes" v-model="notes" rows="2" class="max-w-2xl" />
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" @click="fileInput?.click()">Datei wählen</Button>

          <!-- Das eigentliche Feld bleibt verborgen: Sein Aussehen lässt sich
               nicht gestalten, sein Verhalten braucht es aber. -->
          <input ref="fileInput" type="file" accept=".exe" class="hidden" @change="onSelect" />

          <span v-if="file" class="text-muted-foreground text-sm">
            {{ file.name }} · {{ formatBytes(String(file.size)) }}
          </span>
          <span v-else class="text-muted-foreground text-sm">Keine Datei gewählt.</span>
        </div>
      </CardContent>

      <CardFooter>
        <Button :disabled="!file || busy" @click="publish">
          <Loader2 v-if="busy" class="size-4 animate-spin" />
          <Upload v-else class="size-4" />
          Aufnehmen
        </Button>
      </CardFooter>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Hinterlegte Versionen</CardTitle>
        <CardDescription>
          „Aktuell" ist die Version, auf die ein Auftrag ohne ausdrückliche Angabe zielt.
          „Ausrollen" legt Aufträge für alle aktiven Geräte an, die nicht darauf laufen. Das
          Download-Symbol liefert die EXE für eine Installation von Hand mit
          <code>--install</code>.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <div class="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead class="w-28 text-right">Grösse</TableHead>
                <TableHead class="w-44">SHA-256</TableHead>
                <TableHead class="w-24 text-right">Geräte</TableHead>
                <TableHead class="w-40">Aufgenommen</TableHead>
                <TableHead>Anmerkungen</TableHead>
                <TableHead class="w-64" />
              </TableRow>
            </TableHeader>

            <TableBody>
              <TableRow v-if="!loading && releases.length === 0">
                <TableCell :colspan="7" class="text-muted-foreground py-8 text-center">
                  Noch keine Version hinterlegt.
                </TableCell>
              </TableRow>

              <TableRow v-for="release in releases" :key="release.id">
                <TableCell>
                  <span class="tabular font-medium">{{ release.version }}</span>
                  <Badge
                    v-if="release.isCurrent"
                    variant="outline"
                    class="bg-success/15 text-success border-success/30 ml-2"
                  >
                    aktuell
                  </Badge>
                </TableCell>

                <TableCell class="tabular text-right">
                  {{ formatBytes(release.sizeBytes) }}
                </TableCell>
                <TableCell><code class="text-xs">{{ release.sha256.slice(0, 16) }}…</code></TableCell>
                <TableCell class="tabular text-right">{{ release.devices }}</TableCell>
                <TableCell>{{ formatDateTime(release.releasedAt) }}</TableCell>
                <TableCell class="text-muted-foreground text-sm">
                  {{ release.notes ?? '' }}
                </TableCell>

                <TableCell>
                  <div class="flex justify-end gap-1.5 whitespace-nowrap">
                    <Button
                      variant="ghost"
                      size="icon"
                      class="size-8"
                      title="Binary herunterladen"
                      @click="download(release)"
                    >
                      <Download class="size-4" />
                    </Button>
                    <Button
                      v-if="!release.isCurrent"
                      variant="outline"
                      size="sm"
                      :disabled="busy"
                      @click="setCurrent(release)"
                    >
                      Als aktuell
                    </Button>
                    <Button size="sm" :disabled="busy" @click="pendingRollOut = release">
                      <Send class="size-3.5" />
                      Ausrollen
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      class="text-destructive size-8"
                      :disabled="busy"
                      @click="pendingRemoval = release"
                    >
                      <Trash2 class="size-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Update-Aufträge</CardTitle>
        <CardDescription>
          Ein Auftrag wird beim nächsten Check-in des Geräts abgeholt. Bis dahin bleibt er offen.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <div class="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Gerät</TableHead>
                <TableHead class="w-32">Zielversion</TableHead>
                <TableHead class="w-40">
                  <span class="inline-flex items-center gap-1">Status <JobStateLegend /></span>
                </TableHead>
                <TableHead class="w-40">Angelegt</TableHead>
                <TableHead class="w-40">Abgeschlossen</TableHead>
                <TableHead>Fehler</TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              <TableRow v-if="!loading && jobs.length === 0">
                <TableCell :colspan="6" class="text-muted-foreground py-8 text-center">
                  Noch keine Aufträge.
                </TableCell>
              </TableRow>

              <TableRow
                v-for="job in jobsPage.items"
                :key="job.id"
                class="cursor-pointer"
                @click="router.push({ name: 'device', params: { id: job.deviceId } })"
              >
                <TableCell class="font-medium">{{ job.hostname }}</TableCell>
                <TableCell class="tabular">{{ job.targetVersion }}</TableCell>
                <TableCell>
                  <Badge variant="outline" :class="jobBadgeClass(job.state)">
                    {{ JOB_STATE_LABELS[job.state] }}
                  </Badge>
                </TableCell>
                <TableCell>{{ formatDateTime(job.createdAt) }}</TableCell>
                <TableCell>{{ formatDateTime(job.completedAt) }}</TableCell>
                <TableCell class="text-destructive text-xs">{{ job.error ?? '' }}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <TablePager
          v-model:page="jobsPage.page"
          v-model:limit="jobsPage.limit"
          :total="jobsPage.total"
          :page-sizes="[10, 25, 50]"
        />
      </CardContent>
    </Card>

    <!-- ===================== Rückfragen ===================== -->
    <Dialog :open="pendingRemoval !== null" @update:open="pendingRemoval = null">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Version entfernen</DialogTitle>
          <DialogDescription>
            {{ pendingRemoval?.version }} samt Datei löschen? Geräte, die diese Version melden,
            bleiben unberührt — nur ein erneutes Ausrollen ist danach nicht mehr möglich.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="outline" @click="pendingRemoval = null">Abbrechen</Button>
          <Button variant="destructive" @click="remove">Entfernen</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="pendingRollOut !== null" @update:open="pendingRollOut = null">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Ausrollen</DialogTitle>
          <DialogDescription>
            Alle aktiven Geräte, die nicht auf {{ pendingRollOut?.version }} laufen, erhalten einen
            Update-Auftrag. Sie holen ihn beim nächsten Check-in ab und tauschen sich selbst aus.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="outline" @click="pendingRollOut = null">Abbrechen</Button>
          <Button @click="rollOut">Aufträge anlegen</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
