<script setup lang="ts">
import { ChevronDown, ChevronRight, Loader2, RotateCw, XCircle } from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { toast } from 'vue-sonner';
import { get, post } from '@/api/client';
import type { InstallJob, Installation, InstallJobsSkipped, Paged } from '@/api/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import InstallResultList from '@/components/InstallResultList.vue';
import TablePager from '@/components/TablePager.vue';
import InstallationProgress from '@/components/updates/InstallationProgress.vue';
import {
  INSTALL_JOB_STATE_LABELS,
  formatDateTime,
  installJobBadgeClass,
  installScopeLabel,
  installSummary,
} from '@/format';

/**
 * Was in einem Zug angelegt wurde, je Installation eine Zeile; aufgeklappt
 * stehen darunter die Geräte mit ihrem Auftrag.
 *
 * Solange etwas läuft oder wartet, lädt die Liste alle 30 Sekunden nach —
 * wer eine Installation gestartet hat, sieht ihr hier zu.
 */
const route = useRoute();

const REFRESH_MS = 30_000;

const rows = ref<Installation[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref<string | null>(null);

const page = ref(1);
const limit = ref(25);

const expanded = ref(new Set<string>());
const jobs = ref<Record<string, InstallJob[] | undefined>>({});
const expandedJobs = ref(new Set<string>());

const confirmCancel = ref<Installation | null>(null);
const cancelling = ref(false);

/** Noch nicht gestartete Aufträge — nur sie lassen sich abbrechen. */
function cancellable(installation: Installation): number {
  return installation.states.pending + installation.states.delivered;
}

function isOpen(installation: Installation): boolean {
  return cancellable(installation) + installation.states.running > 0;
}

const anyOpen = computed(() => rows.value.some(isOpen));

async function load(quiet = false): Promise<void> {
  if (!quiet) loading.value = true;
  error.value = null;

  try {
    const result = await get<Paged<Installation>>('/api/installations', {
      page: page.value,
      limit: limit.value,
    });
    rows.value = result.items;
    total.value = result.total;

    // Aufgeklappte Installationen gleich mit, sonst passen Kopf und Geräte nicht zusammen.
    await Promise.all([...expanded.value].map((id) => loadJobs(id)));
  } catch (e) {
    if (!quiet) {
      error.value = e instanceof Error ? e.message : 'Die Installationen konnten nicht geladen werden.';
    }
  } finally {
    loading.value = false;
  }
}

async function loadJobs(id: string): Promise<void> {
  jobs.value = { ...jobs.value, [id]: await get<InstallJob[]>(`/api/installations/${id}/jobs`) };
}

async function toggle(installation: Installation): Promise<void> {
  const next = new Set(expanded.value);
  if (next.delete(installation.id)) {
    expanded.value = next;
    return;
  }

  next.add(installation.id);
  expanded.value = next;
  if (!jobs.value[installation.id]) {
    await loadJobs(installation.id);
  }
}

function toggleJob(jobId: string): void {
  const next = new Set(expandedJobs.value);
  if (!next.delete(jobId)) next.add(jobId);
  expandedJobs.value = next;
}

async function cancelInstallation(): Promise<void> {
  const installation = confirmCancel.value;
  if (!installation) return;

  cancelling.value = true;
  try {
    const result = await post<{ cancelled: number }>(`/api/installations/${installation.id}/cancel`);
    toast.success(
      result.cancelled > 0
        ? `${result.cancelled} Auftrag/Aufträge abgebrochen.`
        : 'Nichts mehr abzubrechen — die Aufträge laufen bereits oder sind abgeschlossen.',
    );
    confirmCancel.value = null;
    await load(true);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Die Installation konnte nicht abgebrochen werden.';
  } finally {
    cancelling.value = false;
  }
}

function skippedText(skipped: InstallJobsSkipped): string {
  return [
    skipped.agentTooOld > 0 ? `${skipped.agentTooOld} mit zu altem Agent` : '',
    skipped.openJob > 0 ? `${skipped.openJob} mit bereits offenem Auftrag` : '',
    skipped.nothingOpen > 0 ? `${skipped.nothingOpen} ohne passendes installierbares Update` : '',
    skipped.notEligible > 0 ? `${skipped.notEligible} archiviert oder ohne Agent` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

let timer: ReturnType<typeof setInterval> | undefined;

onMounted(async () => {
  // Aus dem Installationsdialog oder vom Gerät: die gemeinte Installation gleich offen.
  const wanted = route.query.installation;
  if (typeof wanted === 'string' && wanted) {
    expanded.value = new Set([wanted]);
  }

  await load();

  timer = setInterval(() => {
    if (anyOpen.value && document.visibilityState === 'visible') {
      void load(true);
    }
  }, REFRESH_MS);
});

onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div>
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <p class="text-muted-foreground text-sm">
        Jede gestartete Installation, neueste zuerst. Angelegt wird bei den Geräten — in der Liste
        über die Auswahl oder auf der Seite eines Geräts.
      </p>
      <span class="text-muted-foreground tabular ml-auto text-sm">{{ total }} {{ total === 1 ? 'Installation' : 'Installationen' }}</span>
      <Button variant="outline" size="sm" :disabled="loading" @click="load()">
        <RotateCw class="size-4" :class="loading ? 'animate-spin' : ''" />
        Aktualisieren
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
            <TableHead class="w-40">Angelegt</TableHead>
            <TableHead>Umfang</TableHead>
            <TableHead class="w-44">Start</TableHead>
            <TableHead class="w-24 text-right">Geräte</TableHead>
            <TableHead class="w-72">Fortschritt</TableHead>
            <TableHead class="w-56">Ergebnis</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          <template v-if="loading && rows.length === 0">
            <TableRow v-for="n in 4" :key="n">
              <TableCell v-for="column in 7" :key="column">
                <Skeleton class="h-4 w-full" />
              </TableCell>
            </TableRow>
          </template>

          <TableRow v-else-if="rows.length === 0">
            <TableCell :colspan="7" class="text-muted-foreground py-8 text-center">
              Noch keine Installation gestartet.
            </TableCell>
          </TableRow>

          <template v-for="installation in rows" :key="installation.id">
            <TableRow
              class="cursor-pointer"
              :aria-expanded="expanded.has(installation.id)"
              @click="toggle(installation)"
            >
              <TableCell>
                <ChevronDown v-if="expanded.has(installation.id)" class="text-muted-foreground size-4" />
                <ChevronRight v-else class="text-muted-foreground size-4" />
              </TableCell>

              <TableCell>
                <div>{{ formatDateTime(installation.createdAt) }}</div>
                <div class="text-muted-foreground text-xs">{{ installation.createdBy }}</div>
              </TableCell>

              <TableCell>{{ installScopeLabel(installation) }}</TableCell>

              <TableCell>
                <div>{{ formatDateTime(installation.notBefore) }}</div>
                <div v-if="installation.spreadMinutes > 0" class="text-muted-foreground text-xs">
                  gestreut über {{ installation.spreadMinutes }} min
                </div>
              </TableCell>

              <TableCell class="tabular text-right">
                <div class="font-semibold">{{ installation.devices }}</div>
                <div
                  v-if="installation.requestedDevices > installation.devices"
                  class="text-muted-foreground text-xs"
                >
                  von {{ installation.requestedDevices }} gewählt
                </div>
              </TableCell>

              <TableCell><InstallationProgress :states="installation.states" /></TableCell>

              <TableCell class="text-sm">
                <div v-if="installation.installedUpdates > 0">
                  {{ installation.installedUpdates }}
                  {{ installation.installedUpdates === 1 ? 'Update' : 'Updates' }} installiert
                </div>
                <div v-if="installation.failedUpdates > 0" class="text-destructive">
                  {{ installation.failedUpdates }} gescheitert
                </div>
                <div v-if="installation.rebootDevices > 0" class="text-warning-foreground dark:text-warning">
                  Neustart nötig auf {{ installation.rebootDevices }}
                  {{ installation.rebootDevices === 1 ? 'Gerät' : 'Geräten' }}
                </div>
                <span
                  v-if="installation.installedUpdates + installation.failedUpdates + installation.rebootDevices === 0"
                  class="text-muted-foreground"
                >
                  —
                </span>
              </TableCell>
            </TableRow>

            <TableRow v-if="expanded.has(installation.id)" class="hover:bg-transparent">
              <TableCell :colspan="7" class="bg-muted/30 p-4">
                <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p class="text-muted-foreground text-xs">
                    <template v-if="installation.skipped && skippedText(installation.skipped)">
                      Übergangen: {{ skippedText(installation.skipped) }}.
                    </template>
                    <template v-else-if="installation.skipped">Kein gewähltes Gerät wurde übergangen.</template>
                  </p>
                  <Button
                    v-if="cancellable(installation) > 0"
                    size="sm"
                    variant="outline"
                    @click="confirmCancel = installation"
                  >
                    <XCircle class="size-4" />
                    Noch nicht gestartete abbrechen ({{ cancellable(installation) }})
                  </Button>
                </div>

                <p v-if="!jobs[installation.id]" class="text-muted-foreground text-xs">Wird geladen …</p>

                <div v-else class="rounded-md border bg-background">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Gerät</TableHead>
                        <TableHead class="w-32">Status</TableHead>
                        <TableHead class="w-40">Ab</TableHead>
                        <TableHead class="w-40">Abgeschlossen</TableHead>
                        <TableHead>Ergebnis</TableHead>
                      </TableRow>
                    </TableHeader>

                    <TableBody>
                      <TableRow v-if="jobs[installation.id]!.length === 0">
                        <TableCell :colspan="5" class="text-muted-foreground py-6 text-center">
                          Die Geräte dieser Installation gibt es nicht mehr.
                        </TableCell>
                      </TableRow>

                      <template v-for="job in jobs[installation.id]" :key="job.id">
                        <TableRow>
                          <TableCell class="font-medium">
                            <RouterLink
                              :to="{ name: 'device', params: { id: job.deviceId } }"
                              class="hover:underline"
                            >
                              {{ job.hostname }}
                            </RouterLink>
                          </TableCell>
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
                              :aria-expanded="expandedJobs.has(job.id)"
                              @click="toggleJob(job.id)"
                            >
                              <ChevronRight
                                class="size-4 transition-transform"
                                :class="expandedJobs.has(job.id) ? 'rotate-90' : ''"
                              />
                              {{ installSummary(job) }}
                            </button>
                            <span v-else-if="job.results" class="text-muted-foreground text-sm">
                              {{ installSummary(job) }}
                            </span>
                            <span v-else-if="!job.error" class="text-muted-foreground">—</span>
                            <span
                              v-if="job.error && job.results?.length !== 0"
                              class="block text-xs"
                              :class="job.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'"
                            >
                              {{ job.error }}
                            </span>
                          </TableCell>
                        </TableRow>

                        <TableRow v-if="expandedJobs.has(job.id)" class="bg-muted/30 hover:bg-muted/30">
                          <TableCell :colspan="5" class="py-2">
                            <InstallResultList :results="job.results ?? []" />
                          </TableCell>
                        </TableRow>
                      </template>
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
      @update:page="load()"
      @update:limit="
        page = 1;
        load();
      "
    />

    <Dialog :open="confirmCancel !== null" @update:open="confirmCancel = null">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Noch nicht gestartete Aufträge abbrechen?</DialogTitle>
          <DialogDescription v-if="confirmCancel">
            {{ cancellable(confirmCancel) }} Geräte dieser Installation haben noch nicht begonnen und
            bekommen ihren Auftrag dann nicht mehr. Was bereits läuft, läuft zu Ende; Abgeschlossenes
            bleibt, wie es ist.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="confirmCancel = null">Zurück</Button>
          <Button variant="destructive" :disabled="cancelling" @click="cancelInstallation">
            <Loader2 v-if="cancelling" class="size-4 animate-spin" />
            Abbrechen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
