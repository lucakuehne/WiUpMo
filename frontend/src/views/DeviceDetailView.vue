<script setup lang="ts">
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowUpCircle,
  ChevronRight,
  Loader2,
  MonitorDown,
  Trash2,
} from '@lucide/vue';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import { del, get, post } from '@/api/client';
import type {
  AgentUpdateJobView,
  CreateUpdateJobsResult,
  DeviceDetail,
  DeviceUpdate,
  InstallJob,
  InstallJobUpdateResult,
  Timeline,
  TimelineEntry,
} from '@/api/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import HresultCell from '@/components/HresultCell.vue';
import InstallDialog from '@/components/InstallDialog.vue';
import JobStateLegend from '@/components/JobStateLegend.vue';
import SourceLegend from '@/components/SourceLegend.vue';
import TablePager from '@/components/TablePager.vue';
import { formatDnPath } from '@/dn';
import {
  EVENT_TYPE_LABELS,
  INSTALL_JOB_STATE_LABELS,
  JOB_STATE_LABELS,
  UPDATE_SOURCE_LABELS,
  eventBadgeClass,
  formatBytes,
  formatDateTime,
  formatRelative,
  installJobBadgeClass,
  installScopeLabel,
  jobBadgeClass,
  sourceBadgeClass,
} from '@/format';

const props = defineProps<{ id: string }>();

const router = useRouter();

const device = ref<DeviceDetail | null>(null);
const jobs = ref<AgentUpdateJobView[]>([]);
const timeline = ref<TimelineEntry[]>([]);
const timelineTotal = ref(0);
const loading = ref(true);
const error = ref<string | null>(null);
const updating = ref(false);

/**
 * Beide Listen kommen vollständig vom Server — die eine als aktueller Stand,
 * die andere gedeckelt auf die letzten hundert Ereignisse. Geblättert wird
 * deshalb hier im Browser; ein zweiter Endpunkt je Seite wäre Aufwand ohne
 * Gegenwert.
 */
const updatePage = ref(1);
const updateLimit = ref(25);
const timelinePage = ref(1);
const timelineLimit = ref(25);

/**
 * Nur, was Windows dem Gerät gerade anbietet.
 *
 * Installierte, abgelöste und gescheiterte Updates, die nicht mehr angeboten
 * werden, sind erledigt — sie stehen im Verlauf. Hier mitgelistet sahen sie
 * aus wie Arbeit, die noch ansteht; bei den gescheiterten waren das fast nur
 * Store-Apps, deren Download einmal fehlschlug.
 */
const openUpdates = computed(() =>
  (device.value?.updates ?? []).filter((update) => update.state === 'available'),
);

/**
 * Was sich installieren laesst. Eingespielte Updates, die nur auf den
 * Neustart warten, bietet Windows bis dahin weiter an — ein Auftrag dafuer
 * braechte nichts, das Backend laesst sie ohnehin aus.
 */
const installableUpdates = computed(() => openUpdates.value.filter((update) => !update.awaitingReboot));

/** Aufgeklappte Updates, deren Installationsversuche darunter stehen. */
const expandedUpdates = ref(new Set<string>());

function toggleAttempts(updateId: string): void {
  const next = new Set(expandedUpdates.value);
  if (!next.delete(updateId)) next.add(updateId);
  expandedUpdates.value = next;
}

function attemptSummary(update: DeviceUpdate): string {
  const failed = update.attempts.filter((attempt) => !attempt.succeeded).length;
  const count = update.attempts.length;
  const noun = count === 1 ? 'Versuch' : 'Versuche';
  return failed === count ? `${count} ${noun} gescheitert` : `${count} ${noun}, ${failed} gescheitert`;
}

const pagedUpdates = computed(() =>
  openUpdates.value.slice(
    (updatePage.value - 1) * updateLimit.value,
    updatePage.value * updateLimit.value,
  ),
);

const pagedTimeline = computed(() =>
  timeline.value.slice(
    (timelinePage.value - 1) * timelineLimit.value,
    timelinePage.value * timelineLimit.value,
  ),
);

const latestCheckin = computed(() => device.value?.checkins[0] ?? null);

/**
 * Was am Agent nicht rund läuft, in Sätzen statt als Feldliste.
 *
 * Die Selbstauskunft trägt fünf Werte; vier davon sind im Normalfall
 * unauffällig und sagen dann nichts. Interessant ist nur die Abweichung —
 * deshalb wird hier ausgewertet statt angezeigt.
 */
/** Neueste zuerst — der Agent liefert sie in zeitlicher Reihenfolge. */
const agentLogs = computed(() => [...(device.value?.agentDiagnostics?.recentLogs ?? [])].reverse());

const agentIssues = computed<string[]>(() => {
  const d = device.value?.agentDiagnostics;
  if (!d) {
    return [];
  }

  const issues: string[] = [];

  if (d.queuedSnapshots > 1) {
    issues.push(
      `${d.queuedSnapshots} Meldungen warten in der Warteschlange — das Gerät erreicht das ` +
        'Backend nicht zuverlässig.',
    );
  }

  if (d.selfUpdateState) {
    const seit = d.selfUpdateStartedAt ? ` (seit ${formatRelative(d.selfUpdateStartedAt)})` : '';
    issues.push(
      `Ein Selbst-Update auf ${d.selfUpdateTarget ?? 'unbekannt'} steht im Zustand ` +
        `${d.selfUpdateState}${seit}.`,
    );
  }

  if (!d.updaterTaskRegistered) {
    issues.push(
      'Der geplante Task „WiUpMo Agent Updater" fehlt. Ohne ihn kann sich der Agent nicht ' +
        'selbst aktualisieren — eine Neuinstallation mit --install legt ihn an.',
    );
  }

  if (d.lastError) {
    const wann = d.lastErrorAt ? `${formatRelative(d.lastErrorAt)}: ` : '';
    issues.push(`${wann}${d.lastError}`);
  }

  return issues;
});

// --- Installationsaufträge --------------------------------------------------------

const installJobs = ref<InstallJob[]>([]);

/** Höchstens einer je Gerät; er steht als Hinweis über den offenen Updates. */
const openInstallJob = computed(() =>
  installJobs.value.find((job) => ['pending', 'delivered', 'running'].includes(job.state)),
);

/** Zum Installieren ausgewählte Updates (Katalog-IDs). */
const selectedUpdates = ref(new Set<string>());

function toggleUpdate(updateId: string, checked: boolean): void {
  const next = new Set(selectedUpdates.value);
  if (checked) next.add(updateId);
  else next.delete(updateId);
  selectedUpdates.value = next;
}

const selectableOnPage = computed(() => pagedUpdates.value.filter((update) => !update.awaitingReboot));

const pageUpdateSelection = computed<boolean | 'indeterminate'>(() => {
  const onPage = selectableOnPage.value.filter((update) => selectedUpdates.value.has(update.updateId)).length;
  if (onPage === 0) return false;
  return onPage === selectableOnPage.value.length ? true : 'indeterminate';
});

function togglePageUpdates(checked: boolean): void {
  const next = new Set(selectedUpdates.value);
  for (const update of selectableOnPage.value) {
    if (checked) next.add(update.updateId);
    else next.delete(update.updateId);
  }
  selectedUpdates.value = next;
}

const installDialog = ref(false);

function onInstallCreated(): void {
  selectedUpdates.value = new Set();
  void load();
}

async function cancelInstall(job: InstallJob): Promise<void> {
  try {
    await post(`/api/install-jobs/${job.id}/cancel`);
    toast.success('Installationsauftrag abgebrochen.');
    void load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Der Auftrag konnte nicht abgebrochen werden.';
  }
}

/** Eine Zeile je Auftrag: wie viele installiert, wie viele gescheitert, wie viele nicht angeboten. */
function installSummary(job: InstallJob): string {
  if (!job.results) return '—';
  if (job.results.length === 0) return job.error ?? 'nichts installiert';
  const installed = job.results.filter((r) => r.offered && (r.resultCode === 2 || r.resultCode === 3)).length;
  const notOffered = job.results.filter((r) => !r.offered).length;
  const failed = job.results.length - installed - notOffered;
  return [
    installed > 0 ? `${installed} installiert` : '',
    failed > 0 ? `${failed} gescheitert` : '',
    notOffered > 0 ? `${notOffered} nicht angeboten` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** Ergebniscodes von Windows Update: 2 erfolgreich, 3 mit Fehlern, 4 gescheitert, 5 abgebrochen. */
function installResultBadge(result: InstallJobUpdateResult): { label: string; class: string } {
  if (!result.offered) return { label: 'nicht angeboten', class: 'text-muted-foreground' };
  if (result.resultCode === 2 || result.resultCode === 3) {
    return { label: 'installiert', class: 'bg-success/15 text-success border-success/30' };
  }
  if (result.resultCode === 5) return { label: 'abgebrochen', class: 'text-muted-foreground' };
  return { label: 'gescheitert', class: 'bg-destructive/15 text-destructive border-destructive/30' };
}

const expandedInstalls = ref(new Set<string>());

function toggleInstall(jobId: string): void {
  const next = new Set(expandedInstalls.value);
  if (!next.delete(jobId)) next.add(jobId);
  expandedInstalls.value = next;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    const [detail, events, updateJobs, installs] = await Promise.all([
      get<DeviceDetail>(`/api/devices/${props.id}`),
      get<Timeline>(`/api/devices/${props.id}/timeline`, { limit: 100 }),
      get<AgentUpdateJobView[]>('/api/agent-update-jobs', { deviceId: props.id, limit: 50 }),
      get<InstallJob[]>('/api/install-jobs', { deviceId: props.id, limit: 50 }),
    ]);

    device.value = detail;
    timeline.value = events.items;
    timelineTotal.value = events.total;
    jobs.value = updateJobs;
    installJobs.value = installs;

    // Was inzwischen installiert oder zurückgezogen ist, fällt aus der Auswahl.
    const open = new Set(installableUpdates.value.map((update) => update.updateId));
    selectedUpdates.value = new Set([...selectedUpdates.value].filter((id) => open.has(id)));
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Das Gerät konnte nicht geladen werden.';
  } finally {
    loading.value = false;
  }
}

/**
 * Legt einen Auftrag auf die als aktuell markierte Version. Ohne eine solche
 * antwortet das Backend mit einem Konflikt — die Meldung sagt dann, was fehlt.
 */
async function requestUpdate(): Promise<void> {
  updating.value = true;
  error.value = null;

  try {
    const result = await post<CreateUpdateJobsResult>('/api/agent-update-jobs', {
      deviceIds: [props.id],
    });

    if (result.created > 0) {
      toast.success(`Update-Auftrag auf ${result.targetVersion} angelegt.`, {
        description: 'Das Gerät holt ihn beim nächsten Check-in ab.',
      });
    } else {
      toast.info('Kein Auftrag nötig.', {
        description: 'Das Gerät läuft bereits auf der Zielversion oder hat einen offenen Auftrag.',
      });
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Der Auftrag konnte nicht angelegt werden.';
  } finally {
    updating.value = false;
  }
}

/**
 * Nur für archivierte Geräte angeboten — das Backend lehnt die übrigen ab.
 * Archivieren ist damit die erste Stufe und dieser Dialog die Rückfrage.
 */
const confirmDelete = ref(false);
const deleting = ref(false);

async function deleteDevice(): Promise<void> {
  const hostname = device.value?.hostname ?? '';
  deleting.value = true;
  error.value = null;

  try {
    await del(`/api/devices/${props.id}`);
    toast.success(`${hostname} gelöscht.`);
    await router.push({ name: 'devices' });
  } catch (e) {
    confirmDelete.value = false;
    error.value = e instanceof Error ? e.message : 'Das Gerät konnte nicht gelöscht werden.';
  } finally {
    deleting.value = false;
  }
}

function kbUrl(article: string): string {
  return `https://support.microsoft.com/help/${article}`;
}

onMounted(load);
</script>

<template>
  <div class="mx-auto max-w-[1600px] px-5 py-6">
    <Alert v-if="error" variant="destructive" class="mb-4">
      <AlertDescription>{{ error }}</AlertDescription>
    </Alert>

    <div v-if="loading" class="space-y-4">
      <Skeleton class="h-8 w-64" />
      <Skeleton class="h-32 w-full" />
      <Skeleton class="h-64 w-full" />
    </div>

    <template v-else-if="device">
      <div class="mb-4">
        <Button variant="ghost" size="sm" class="-ml-2" @click="router.push({ name: 'devices' })">
          <ArrowLeft class="size-4" />
          Geräte
        </Button>

        <div class="mt-2 flex flex-wrap items-center justify-between gap-3">
          <h1 class="text-xl font-semibold">{{ device.hostname }}</h1>

          <div class="flex flex-wrap items-center gap-2">
            <Badge v-if="device.status === 'archived'" variant="secondary">archiviert</Badge>
            <span v-if="latestCheckin" class="flex items-center gap-1">
              <Badge variant="outline" :class="sourceBadgeClass(latestCheckin.updateSource)">
                {{ UPDATE_SOURCE_LABELS[latestCheckin.updateSource] }}
              </Badge>
              <SourceLegend />
            </span>
            <Badge v-if="latestCheckin?.pendingReboot" variant="outline" class="border-warning/40 text-warning-foreground dark:text-warning">
              <AlertTriangle class="size-3" />
              Neustart ausstehend
            </Badge>
          </div>
        </div>
      </div>

      <!-- Der Grund steht hier, weil er in der Liste nur als Abzeichen
           auftaucht: „archiviert" allein beantwortet nicht, ob das Konto im AD
           gelöscht wurde oder ob nur seine OU aus dem Abgleich fiel. -->
      <Alert v-if="device.status === 'archived'" class="mb-4">
        <Archive class="size-4" />
        <AlertDescription class="flex flex-wrap items-center justify-between gap-3">
          <span>
            {{ device.archivedReason ?? 'Von Hand archiviert.' }}
            <span v-if="device.archivedAt" class="text-muted-foreground">
              ({{ formatDateTime(device.archivedAt) }})
            </span>
          </span>
          <Button variant="outline" size="sm" @click="confirmDelete = true">
            <Trash2 class="size-4" />
            Endgültig löschen
          </Button>
        </AlertDescription>
      </Alert>

      <Dialog :open="confirmDelete" @update:open="confirmDelete = false">
        <DialogContent class="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{{ device.hostname }} endgültig löschen?</DialogTitle>
            <DialogDescription>
              Das Gerät verschwindet samt Check-ins, Update-Historie und Aufträgen; die
              Auswertungen vergangener Zeiträume zählen es danach nicht mehr mit. Das lässt sich
              nicht rückgängig machen. Meldet sich der Agent noch einmal oder taucht das Konto im
              AD wieder auf, entsteht ein neues Gerät ohne Historie.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" @click="confirmDelete = false">Abbrechen</Button>
            <Button variant="destructive" :disabled="deleting" @click="deleteDevice">
              <Loader2 v-if="deleting" class="size-4 animate-spin" />
              Löschen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card class="mb-4">
        <CardContent>
          <dl class="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt class="text-muted-foreground text-xs">Betriebssystem</dt>
              <dd>{{ device.osName ?? '—' }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground text-xs">Version / Build</dt>
              <dd class="tabular">{{ device.osVersion ?? '—' }} · {{ device.osBuild ?? '—' }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground text-xs">Agent-Version</dt>
              <dd class="flex items-center gap-2">
                <span class="tabular">{{ device.agentVersion ?? '—' }}</span>
                <Button
                  v-if="device.enrolledAt"
                  variant="outline"
                  size="sm"
                  class="h-7"
                  :disabled="updating"
                  @click="requestUpdate"
                >
                  <Loader2 v-if="updating" class="size-3.5 animate-spin" />
                  <ArrowUpCircle v-else class="size-3.5" />
                  Aktualisieren
                </Button>
              </dd>
            </div>
            <div>
              <dt class="text-muted-foreground text-xs">Registriert</dt>
              <dd>{{ formatDateTime(device.enrolledAt) }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground text-xs">Letzter Check-in</dt>
              <dd :title="formatDateTime(device.lastSeenAt)">
                {{ formatRelative(device.lastSeenAt) }}
              </dd>
            </div>
            <div>
              <dt class="text-muted-foreground text-xs">Organisationseinheit</dt>
              <!-- Als Pfad, mit dem vollständigen DN als Hinweistext. -->
              <dd class="truncate" :title="device.adOu ?? ''">
                {{ device.adOu ? formatDnPath(device.adOu) : '—' }}
              </dd>
            </div>
            <div>
              <!-- Vom Agent ab 0.7.1; das Verzeichnis kennt die Angabe nicht. -->
              <dt class="text-muted-foreground text-xs">Zuletzt angemeldet</dt>
              <dd v-if="device.lastLogonUser" class="truncate" :title="device.lastLogonUser">
                {{ device.lastLogonDisplayName ?? device.lastLogonUser }}
                <span v-if="device.lastLogonDisplayName" class="text-muted-foreground text-xs">
                  {{ device.lastLogonUser }}
                </span>
              </dd>
              <dd v-else>—</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <!--
        Nur wenn es etwas zu sagen gibt: Läuft alles rund — nichts in der
        Warteschlange, kein Selbst-Update unterwegs, Task da, kein Fehler —,
        wäre der Kasten eine Zeile Bestätigung ohne Erkenntnis.
      -->
      <Card v-if="agentIssues.length > 0" class="mb-4">
        <CardHeader>
          <CardTitle class="text-base">Agent-Zustand</CardTitle>
          <CardDescription>
            Aus dem letzten Check-in, {{ formatRelative(device.lastSeenAt) }}.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <ul class="space-y-1.5 text-sm">
            <li v-for="issue in agentIssues" :key="issue" class="flex items-start gap-2">
              <AlertTriangle class="text-warning mt-0.5 size-4 shrink-0" />
              <span>{{ issue }}</span>
            </li>
          </ul>
        </CardContent>
      </Card>

      <Tabs default-value="updates">
        <TabsList>
          <TabsTrigger value="updates">Offene Updates ({{ openUpdates.length }})</TabsTrigger>
          <TabsTrigger value="installs">Installationen ({{ installJobs.length }})</TabsTrigger>
          <TabsTrigger value="timeline">Verlauf ({{ timelineTotal }})</TabsTrigger>
          <TabsTrigger value="checkins">Check-ins ({{ device.checkins.length }})</TabsTrigger>
          <TabsTrigger value="agent">Agent-Updates ({{ jobs.length }})</TabsTrigger>
          <TabsTrigger value="log">Agent-Protokoll ({{ agentLogs.length }})</TabsTrigger>
        </TabsList>

        <!-- ===================== Updates ===================== -->
        <TabsContent value="updates">
          <!-- Ein offener Auftrag gehört vor die Liste: Wer hier installieren
               will, soll sehen, dass schon etwas unterwegs ist. -->
          <Alert v-if="openInstallJob" class="mb-3">
            <ArrowUpCircle class="size-4" />
            <AlertDescription class="flex flex-wrap items-center justify-between gap-3">
              <span>
                <template v-if="openInstallJob.state === 'running'">
                  Installation läuft seit {{ formatRelative(openInstallJob.startedAt) }}
                </template>
                <template v-else-if="openInstallJob.state === 'delivered'">
                  Installationsauftrag zugestellt {{ formatRelative(openInstallJob.deliveredAt) }}, wartet
                  auf den Start
                </template>
                <template v-else>
                  Installationsauftrag geplant ab {{ formatDateTime(openInstallJob.notBefore) }}
                </template>
                ({{ installScopeLabel(openInstallJob) }}, von {{ openInstallJob.createdBy }})
              </span>
              <Button
                v-if="openInstallJob.state !== 'running'"
                variant="outline"
                size="sm"
                @click="cancelInstall(openInstallJob)"
              >
                Abbrechen
              </Button>
            </AlertDescription>
          </Alert>

          <div class="mb-2 flex flex-wrap items-center justify-between gap-3">
            <p class="text-muted-foreground text-sm">
              Was Windows diesem Gerät gerade anbietet. Installierte, abgelöste und gescheiterte
              Updates, die nicht mehr angeboten werden, stehen im Verlauf.
            </p>
            <Button
              size="sm"
              variant="outline"
              :disabled="installableUpdates.length === 0 || !!openInstallJob || device.status !== 'active'"
              :title="
                openUpdates.length > 0 && installableUpdates.length === 0
                  ? 'Alle offenen Updates sind eingespielt und warten auf den Neustart.'
                  : undefined
              "
              @click="installDialog = true"
            >
              <MonitorDown class="size-4" />
              Installieren …
              <span v-if="selectedUpdates.size > 0" class="tabular">({{ selectedUpdates.size }})</span>
            </Button>
          </div>
          <div class="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead class="w-10">
                    <Checkbox
                      aria-label="Alle Updates dieser Seite auswählen"
                      :model-value="pageUpdateSelection"
                      :disabled="selectableOnPage.length === 0"
                      @update:model-value="togglePageUpdates($event === true)"
                    />
                  </TableHead>
                  <TableHead class="w-28">KB</TableHead>
                  <TableHead>Titel</TableHead>
                  <TableHead class="w-32">Einstufung</TableHead>
                  <TableHead class="w-24 text-right">Grösse</TableHead>
                  <TableHead class="w-40">Offen seit</TableHead>
                  <!-- Gescheitert, aber weiter angeboten: Windows versucht es
                       erneut. Aufgeklappt stehen alle bisherigen Versuche. -->
                  <TableHead class="w-72">Installationsversuche</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                <TableRow v-if="openUpdates.length === 0">
                  <TableCell :colspan="7" class="text-muted-foreground py-8 text-center">
                    Keine offenen Updates.
                  </TableCell>
                </TableRow>

                <template v-for="update in pagedUpdates" :key="update.updateId">
                  <TableRow>
                    <TableCell>
                      <Checkbox
                        :aria-label="`${update.kbArticle ? 'KB' + update.kbArticle : update.title} auswählen`"
                        :model-value="selectedUpdates.has(update.updateId)"
                        :disabled="update.awaitingReboot"
                        :title="update.awaitingReboot ? 'Eingespielt — wartet auf den Neustart.' : undefined"
                        @update:model-value="toggleUpdate(update.updateId, $event === true)"
                      />
                    </TableCell>

                    <TableCell>
                      <a
                        v-if="update.kbArticle"
                        :href="kbUrl(update.kbArticle)"
                        target="_blank"
                        rel="noreferrer"
                        class="text-primary hover:underline"
                      >
                        KB{{ update.kbArticle }}
                      </a>
                      <span v-else class="text-muted-foreground">—</span>
                    </TableCell>

                    <TableCell>
                      <div>
                        {{ update.title }}
                        <Badge
                          v-if="update.awaitingReboot"
                          variant="outline"
                          class="bg-warning/15 text-warning-foreground border-warning/40 dark:text-warning ml-1"
                        >
                          wartet auf Neustart
                        </Badge>
                      </div>
                      <div v-if="update.categories.length" class="text-muted-foreground text-xs">
                        {{ update.categories.join(', ') }}
                      </div>
                    </TableCell>

                    <TableCell>
                      <Badge
                        v-if="update.isSecurity"
                        variant="outline"
                        class="bg-destructive/15 text-destructive border-destructive/30"
                      >
                        {{ update.severity ?? 'Sicherheit' }}
                      </Badge>
                      <span v-else class="text-muted-foreground">—</span>
                    </TableCell>

                    <TableCell class="tabular text-right">
                      {{ formatBytes(update.sizeBytes) }}
                    </TableCell>

                    <TableCell>{{ formatDateTime(update.firstAvailableAt) }}</TableCell>

                    <TableCell>
                      <span v-if="update.attempts.length === 0" class="text-muted-foreground">—</span>
                      <template v-else>
                        <button
                          type="button"
                          class="hover:text-foreground text-muted-foreground flex items-center gap-1 text-sm"
                          :aria-expanded="expandedUpdates.has(update.updateId)"
                          @click="toggleAttempts(update.updateId)"
                        >
                          <ChevronRight
                            class="size-4 transition-transform"
                            :class="expandedUpdates.has(update.updateId) ? 'rotate-90' : ''"
                          />
                          {{ attemptSummary(update) }}
                        </button>
                        <HresultCell :value="update.hresult" />
                      </template>
                    </TableCell>
                  </TableRow>

                  <TableRow
                    v-if="expandedUpdates.has(update.updateId)"
                    class="bg-muted/30 hover:bg-muted/30"
                  >
                    <TableCell :colspan="7" class="py-2">
                      <ul class="space-y-1.5 pl-6 text-sm">
                        <li
                          v-for="attempt in update.attempts"
                          :key="attempt.occurredAt"
                          class="flex flex-wrap items-center gap-x-3 gap-y-1"
                        >
                          <span class="tabular w-40 shrink-0">{{ formatDateTime(attempt.occurredAt) }}</span>
                          <Badge
                            variant="outline"
                            :class="
                              attempt.succeeded
                                ? 'bg-success/15 text-success border-success/30'
                                : 'bg-destructive/15 text-destructive border-destructive/30'
                            "
                          >
                            {{ attempt.succeeded ? 'installiert' : 'gescheitert' }}
                          </Badge>
                          <HresultCell v-if="!attempt.succeeded" :value="attempt.hresult" />
                        </li>
                      </ul>
                    </TableCell>
                  </TableRow>
                </template>
              </TableBody>
            </Table>
          </div>

          <TablePager
            v-model:page="updatePage"
            v-model:limit="updateLimit"
            :total="openUpdates.length"
          />
        </TabsContent>

        <!-- ===================== Installationen ===================== -->
        <TabsContent value="installs">
          <p class="text-muted-foreground mb-3 text-sm">
            Die Installationsaufträge dieses Geräts, neueste zuerst. Angelegt wird unter „Offene
            Updates“; neu gestartet wird nie von selbst.
          </p>

          <div class="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead class="w-40">Angelegt</TableHead>
                  <TableHead class="w-56">Umfang</TableHead>
                  <TableHead class="w-32">Status</TableHead>
                  <TableHead class="w-40">Ab</TableHead>
                  <TableHead class="w-40">Abgeschlossen</TableHead>
                  <TableHead>Ergebnis</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                <TableRow v-if="installJobs.length === 0">
                  <TableCell :colspan="6" class="text-muted-foreground py-8 text-center">
                    Für dieses Gerät wurde noch keine Installation beauftragt.
                  </TableCell>
                </TableRow>

                <template v-for="job in installJobs" :key="job.id">
                  <TableRow>
                    <TableCell>
                      <div>{{ formatDateTime(job.createdAt) }}</div>
                      <div class="text-muted-foreground text-xs">{{ job.createdBy }}</div>
                    </TableCell>
                    <TableCell>{{ installScopeLabel(job) }}</TableCell>
                    <TableCell>
                      <Badge variant="outline" :class="installJobBadgeClass(job.state)">
                        {{ INSTALL_JOB_STATE_LABELS[job.state] }}
                      </Badge>
                    </TableCell>
                    <TableCell>{{ formatDateTime(job.notBefore) }}</TableCell>
                    <TableCell>{{ formatDateTime(job.completedAt) }}</TableCell>
                    <TableCell>
                      <button
                        v-if="job.results && job.results.length > 0"
                        type="button"
                        class="hover:text-foreground text-muted-foreground flex items-center gap-1 text-sm"
                        :aria-expanded="expandedInstalls.has(job.id)"
                        @click="toggleInstall(job.id)"
                      >
                        <ChevronRight
                          class="size-4 transition-transform"
                          :class="expandedInstalls.has(job.id) ? 'rotate-90' : ''"
                        />
                        {{ installSummary(job) }}
                      </button>
                      <span v-else-if="job.results" class="text-muted-foreground text-sm">
                        {{ installSummary(job) }}
                      </span>
                      <span v-else-if="!job.error" class="text-muted-foreground">—</span>
                      <!-- Rot nur, was gescheitert ist; „abgebrochen" ist kein Fehler. -->
                      <span
                        v-if="job.error && job.results?.length !== 0"
                        class="block text-xs"
                        :class="job.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'"
                      >
                        {{ job.error }}
                      </span>
                    </TableCell>
                  </TableRow>

                  <TableRow v-if="expandedInstalls.has(job.id)" class="bg-muted/30 hover:bg-muted/30">
                    <TableCell :colspan="6" class="py-2">
                      <ul class="space-y-1.5 pl-6 text-sm">
                        <li
                          v-for="result in job.results ?? []"
                          :key="result.updateId"
                          class="flex flex-wrap items-center gap-x-3 gap-y-1"
                        >
                          <Badge variant="outline" :class="installResultBadge(result).class">
                            {{ installResultBadge(result).label }}
                          </Badge>
                          <span class="tabular w-24 shrink-0">
                            {{ result.kbArticle ? `KB${result.kbArticle}` : '—' }}
                          </span>
                          <span>{{ result.title ?? result.updateId }}</span>
                          <span v-if="result.rebootRequired" class="text-warning-foreground dark:text-warning text-xs">
                            Neustart nötig
                          </span>
                          <HresultCell v-if="result.hresult" :value="result.hresult" />
                        </li>
                      </ul>
                    </TableCell>
                  </TableRow>
                </template>
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <!-- ===================== Verlauf ===================== -->
        <TabsContent value="timeline">
          <div class="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead class="w-44">Zeitpunkt</TableHead>
                  <TableHead class="w-36">Ereignis</TableHead>
                  <TableHead class="w-28">KB</TableHead>
                  <TableHead>Update</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                <TableRow v-if="timeline.length === 0">
                  <TableCell :colspan="4" class="text-muted-foreground py-8 text-center">
                    Noch keine Ereignisse.
                  </TableCell>
                </TableRow>

                <TableRow v-for="entry in pagedTimeline" :key="entry.id">
                  <TableCell>{{ formatDateTime(entry.occurredAt) }}</TableCell>
                  <TableCell>
                    <Badge variant="outline" :class="eventBadgeClass(entry.eventType)">
                      {{ EVENT_TYPE_LABELS[entry.eventType] }}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span v-if="entry.kbArticle">KB{{ entry.kbArticle }}</span>
                    <span v-else class="text-muted-foreground">—</span>
                  </TableCell>
                  <TableCell>{{ entry.title }}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          <TablePager
            v-model:page="timelinePage"
            v-model:limit="timelineLimit"
            :total="timeline.length"
          />

          <p v-if="timelineTotal > timeline.length" class="text-muted-foreground px-1 text-xs">
            Gezeigt werden die letzten {{ timeline.length }} von {{ timelineTotal }} Ereignissen.
          </p>
        </TabsContent>

        <!-- ===================== Check-ins ===================== -->
        <TabsContent value="checkins">
          <div class="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Erfasst</TableHead>
                  <TableHead>Eingegangen</TableHead>
                  <TableHead>
                    <span class="inline-flex items-center gap-1">Quelle <SourceLegend /></span>
                  </TableHead>
                  <TableHead>WSUS-Server</TableHead>
                  <TableHead class="w-24">Agent</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                <TableRow v-if="device.checkins.length === 0">
                  <TableCell :colspan="5" class="text-muted-foreground py-8 text-center">
                    Noch keine Check-ins.
                  </TableCell>
                </TableRow>

                <TableRow v-for="checkin in device.checkins" :key="checkin.id">
                  <TableCell>{{ formatDateTime(checkin.collectedAt) }}</TableCell>
                  <TableCell>{{ formatDateTime(checkin.reportedAt) }}</TableCell>
                  <TableCell>
                    <Badge variant="outline" :class="sourceBadgeClass(checkin.updateSource)">
                      {{ UPDATE_SOURCE_LABELS[checkin.updateSource] }}
                    </Badge>
                  </TableCell>
                  <TableCell class="text-muted-foreground truncate text-xs">
                    {{ checkin.wsusServerUrl ?? '—' }}
                  </TableCell>
                  <TableCell class="tabular">{{ checkin.agentVersion ?? '—' }}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <!-- ===================== Agent-Updates ===================== -->
        <TabsContent value="agent">
          <p class="text-muted-foreground mb-3 text-sm">
            Die Update-Aufträge dieses Geräts. Ausgerollt wird unter Einstellungen →
            Agent-Versionen; ein offener Auftrag verhindert, dass ein weiterer angelegt wird.
          </p>

          <div class="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
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
                <TableRow v-if="jobs.length === 0">
                  <TableCell :colspan="5" class="text-muted-foreground py-8 text-center">
                    Für dieses Gerät wurde noch kein Agent-Update beauftragt.
                  </TableCell>
                </TableRow>

                <TableRow v-for="job in jobs" :key="job.id">
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
        </TabsContent>

        <!-- ===================== Agent-Protokoll ===================== -->
        <TabsContent value="log">
          <p class="text-muted-foreground mb-3 text-sm">
            Warnungen und Fehler des Agents, wie sie mit dem letzten Check-in eingegangen sind —
            neueste zuerst. Kein vollständiges Protokoll und keine Zeitreihe: Was hier steht, ist
            der jeweils aktuelle Stand, das ganze Protokoll liegt auf dem Gerät unter
            <code>%ProgramData%\WiUpMo\logs\</code>.
          </p>

          <div class="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead class="w-44">Zeitpunkt</TableHead>
                  <TableHead class="w-28">Stufe</TableHead>
                  <TableHead>Meldung</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                <TableRow v-if="agentLogs.length === 0">
                  <TableCell :colspan="3" class="text-muted-foreground py-8 text-center">
                    Nichts zu melden — oder der Agent ist noch zu alt, um sein Protokoll
                    mitzuschicken.
                  </TableCell>
                </TableRow>

                <TableRow v-for="(entry, index) in agentLogs" :key="`${entry.at}-${index}`">
                  <TableCell>{{ formatDateTime(entry.at) }}</TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      :class="
                        entry.level === 'error'
                          ? 'bg-destructive/15 text-destructive border-destructive/30'
                          : 'bg-warning/15 text-warning-foreground border-warning/40 dark:text-warning'
                      "
                    >
                      {{ entry.level === 'error' ? 'Fehler' : 'Warnung' }}
                    </Badge>
                  </TableCell>
                  <TableCell class="text-sm">{{ entry.message }}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </TabsContent>
      </Tabs>

      <InstallDialog
        v-model:open="installDialog"
        :device-ids="[device.id]"
        :selected-update-ids="[...selectedUpdates]"
        :hostname="device.hostname"
        @created="onInstallCreated"
      />
    </template>
  </div>
</template>
