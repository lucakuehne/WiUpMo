<script setup lang="ts">
import { ChevronDown, ChevronRight, Loader2, RotateCw, XCircle } from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { toast } from 'vue-sonner';
import { get, post } from '@/api/client';
import type { Paged, RestartJob, RestartJobState, RestartJobsSkipped, RestartRequestView } from '@/api/types';
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
import JobProgress from '@/components/JobProgress.vue';
import RestartEvents from '@/components/RestartEvents.vue';
import TablePager from '@/components/TablePager.vue';
import { RESTART_JOB_STATE_LABELS, formatDateTime, restartJobBadgeClass } from '@/format';

/**
 * Angeforderte Neustarts, je Anfrage eine Zeile; aufgeklappt die Geräte mit
 * ihrem Stand — gemeldet, wie oft verschoben, von wem, bis wann.
 *
 * Angefordert wird bei den Geräten, aus der Liste oder auf der Seite eines
 * Geräts. Solange etwas offen ist, lädt die Liste alle 30 Sekunden nach.
 */
const route = useRoute();

const REFRESH_MS = 30_000;

/** Abgeschlossenes zuerst, dann was läuft, dann was wartet; Verfallenes und Abgebrochenes zuletzt. */
const ORDER: RestartJobState[] = [
  'done',
  'failed',
  'restarting',
  'deferred',
  'notified',
  'delivered',
  'pending',
  'expired',
  'cancelled',
];

const SEGMENT_CLASS: Record<RestartJobState, string> = {
  done: 'bg-success',
  failed: 'bg-destructive',
  restarting: 'bg-warning',
  deferred: 'bg-chart-5',
  notified: 'bg-chart-2',
  delivered: 'bg-chart-4',
  pending: 'bg-chart-1',
  expired: 'bg-muted-foreground/40',
  cancelled: 'bg-muted-foreground/25',
};

const rows = ref<RestartRequestView[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref<string | null>(null);

const page = ref(1);
const limit = ref(25);

const expanded = ref(new Set<string>());
const jobs = ref<Record<string, RestartJob[] | undefined>>({});
const expandedJobs = ref(new Set<string>());

const confirmCancel = ref<RestartRequestView | null>(null);
const cancelling = ref(false);

function segments(request: RestartRequestView) {
  return ORDER.map((state) => ({
    key: state,
    count: request.states[state],
    label: RESTART_JOB_STATE_LABELS[state],
    class: SEGMENT_CLASS[state],
  }));
}

/** Was sich abbrechen lässt: alles Offene, nur nicht der eingeleitete Neustart. */
function cancellable(request: RestartRequestView): number {
  return request.states.pending + request.states.delivered + request.states.notified + request.states.deferred;
}

const anyOpen = computed(() => rows.value.some((request) => cancellable(request) + request.states.restarting > 0));

function rulesLabel(request: RestartRequestView): string {
  const r = request.rules;
  const defer = r.maxDeferrals === 0 ? 'nicht verschiebbar' : `${r.maxDeferrals}× verschiebbar`;
  return `${defer}, Frist ${r.deadlineHours} h`;
}

function skippedText(skipped: RestartJobsSkipped): string {
  return [
    skipped.server > 0 ? `${skipped.server} Server` : '',
    skipped.agentTooOld > 0 ? `${skipped.agentTooOld} mit zu altem Agent` : '',
    skipped.openJob > 0 ? `${skipped.openJob} mit bereits angefordertem Neustart` : '',
    skipped.notEligible > 0 ? `${skipped.notEligible} archiviert oder ohne Agent` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

async function load(quiet = false): Promise<void> {
  if (!quiet) loading.value = true;
  error.value = null;

  try {
    const result = await get<Paged<RestartRequestView>>('/api/restart-requests', {
      page: page.value,
      limit: limit.value,
    });
    rows.value = result.items;
    total.value = result.total;

    await Promise.all([...expanded.value].map((id) => loadJobs(id)));
  } catch (e) {
    if (!quiet) {
      error.value = e instanceof Error ? e.message : 'Die Neustarts konnten nicht geladen werden.';
    }
  } finally {
    loading.value = false;
  }
}

async function loadJobs(id: string): Promise<void> {
  jobs.value = { ...jobs.value, [id]: await get<RestartJob[]>(`/api/restart-requests/${id}/jobs`) };
}

async function toggle(request: RestartRequestView): Promise<void> {
  const next = new Set(expanded.value);
  if (next.delete(request.id)) {
    expanded.value = next;
    return;
  }

  next.add(request.id);
  expanded.value = next;
  if (!jobs.value[request.id]) {
    await loadJobs(request.id);
  }
}

function toggleJob(jobId: string): void {
  const next = new Set(expandedJobs.value);
  if (!next.delete(jobId)) next.add(jobId);
  expandedJobs.value = next;
}

async function cancelRequest(): Promise<void> {
  const request = confirmCancel.value;
  if (!request) return;

  cancelling.value = true;
  try {
    const result = await post<{ cancelled: number }>(`/api/restart-requests/${request.id}/cancel`);
    toast.success(
      result.cancelled > 0
        ? `${result.cancelled} Neustart/Neustarts abgebrochen.`
        : 'Nichts mehr abzubrechen — die Neustarts sind eingeleitet oder abgeschlossen.',
    );
    confirmCancel.value = null;
    await load(true);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Die Anfrage konnte nicht abgebrochen werden.';
  } finally {
    cancelling.value = false;
  }
}

let timer: ReturnType<typeof setInterval> | undefined;

onMounted(async () => {
  // Aus der Bestätigung beim Anfordern: die gemeinte Anfrage gleich offen.
  const wanted = route.query.request;
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
  <div class="mx-auto max-w-[1600px] px-5 py-6">
    <h1 class="mb-4 text-xl font-semibold">Neustarts</h1>

    <div class="mb-3 flex flex-wrap items-center gap-2">
      <p class="text-muted-foreground min-w-0 flex-1 text-sm">
        Jede Anforderung, neueste zuerst. Angefordert wird bei den Geräten — in der Liste über die
        Auswahl oder auf der Seite eines Geräts. Erledigt ist ein Neustart, sobald das Gerät ihn
        meldet.
      </p>
      <span class="text-muted-foreground tabular text-sm">{{ total }} Anforderungen</span>
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
            <TableHead>Grund</TableHead>
            <TableHead class="w-48">Regeln</TableHead>
            <TableHead class="w-24 text-right">Geräte</TableHead>
            <TableHead class="w-80">Fortschritt</TableHead>
            <TableHead class="w-28 text-right">Verschoben</TableHead>
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
              Noch kein Neustart angefordert.
            </TableCell>
          </TableRow>

          <template v-for="request in rows" :key="request.id">
            <TableRow
              class="cursor-pointer"
              :aria-expanded="expanded.has(request.id)"
              @click="toggle(request)"
            >
              <TableCell>
                <ChevronDown v-if="expanded.has(request.id)" class="text-muted-foreground size-4" />
                <ChevronRight v-else class="text-muted-foreground size-4" />
              </TableCell>
              <TableCell>
                <div>{{ formatDateTime(request.createdAt) }}</div>
                <div class="text-muted-foreground text-xs">{{ request.createdBy }}</div>
              </TableCell>
              <TableCell>{{ request.reason ?? '—' }}</TableCell>
              <TableCell class="text-muted-foreground text-sm">{{ rulesLabel(request) }}</TableCell>
              <TableCell class="tabular text-right">
                <div class="font-semibold">{{ request.devices }}</div>
                <div v-if="request.requestedDevices > request.devices" class="text-muted-foreground text-xs">
                  von {{ request.requestedDevices }} gewählt
                </div>
              </TableCell>
              <TableCell><JobProgress :segments="segments(request)" /></TableCell>
              <TableCell class="tabular text-right">{{ request.deferrals }}×</TableCell>
            </TableRow>

            <TableRow v-if="expanded.has(request.id)" class="hover:bg-transparent">
              <TableCell :colspan="7" class="bg-muted/30 p-4">
                <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p class="text-muted-foreground text-xs">
                    <template v-if="request.skipped && skippedText(request.skipped)">
                      Übergangen: {{ skippedText(request.skipped) }}.
                    </template>
                  </p>
                  <Button
                    v-if="cancellable(request) > 0"
                    size="sm"
                    variant="outline"
                    @click="confirmCancel = request"
                  >
                    <XCircle class="size-4" />
                    Noch nicht eingeleitete abbrechen ({{ cancellable(request) }})
                  </Button>
                </div>

                <p v-if="!jobs[request.id]" class="text-muted-foreground text-xs">Wird geladen …</p>

                <div v-else class="rounded-md border bg-background">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead class="w-10" />
                        <TableHead>Gerät</TableHead>
                        <TableHead class="w-36">Status</TableHead>
                        <TableHead class="w-48">Benutzer</TableHead>
                        <TableHead class="w-44">Verschoben</TableHead>
                        <TableHead class="w-40">Spätestens</TableHead>
                        <TableHead>Fehler</TableHead>
                      </TableRow>
                    </TableHeader>

                    <TableBody>
                      <TableRow v-if="jobs[request.id]!.length === 0">
                        <TableCell :colspan="7" class="text-muted-foreground py-6 text-center">
                          Die Geräte dieser Anforderung gibt es nicht mehr.
                        </TableCell>
                      </TableRow>

                      <template v-for="job in jobs[request.id]" :key="job.id">
                        <TableRow class="cursor-pointer" @click="toggleJob(job.id)">
                          <TableCell>
                            <ChevronDown v-if="expandedJobs.has(job.id)" class="text-muted-foreground size-4" />
                            <ChevronRight v-else class="text-muted-foreground size-4" />
                          </TableCell>
                          <TableCell class="font-medium">
                            <RouterLink
                              :to="{ name: 'device', params: { id: job.deviceId } }"
                              class="hover:underline"
                              @click.stop
                            >
                              {{ job.hostname }}
                            </RouterLink>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" :class="restartJobBadgeClass(job.state)">
                              {{ RESTART_JOB_STATE_LABELS[job.state] }}
                            </Badge>
                          </TableCell>
                          <TableCell class="text-sm">{{ job.lastUser ?? '—' }}</TableCell>
                          <TableCell class="text-sm">
                            <template v-if="job.deferrals > 0">
                              {{ job.deferrals }}×<template v-if="job.deferredUntil">, bis {{ formatDateTime(job.deferredUntil) }}</template>
                            </template>
                            <span v-else class="text-muted-foreground">—</span>
                          </TableCell>
                          <TableCell>{{ formatDateTime(job.deadlineAt) }}</TableCell>
                          <TableCell class="text-destructive text-xs">{{ job.error ?? '' }}</TableCell>
                        </TableRow>

                        <TableRow v-if="expandedJobs.has(job.id)" class="bg-muted/30 hover:bg-muted/30">
                          <TableCell :colspan="7" class="py-2">
                            <RestartEvents :events="job.events" />
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
          <DialogTitle>Noch nicht eingeleitete Neustarts abbrechen?</DialogTitle>
          <DialogDescription v-if="confirmCancel">
            {{ cancellable(confirmCancel) }} Geräte dieser Anforderung starten dann nicht neu. Eine
            Meldung, die beim Benutzer steht, schliesst sich beim nächsten Check-in. Ein bereits
            eingeleiteter Neustart lässt sich nicht mehr aufhalten.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="confirmCancel = null">Zurück</Button>
          <Button variant="destructive" :disabled="cancelling" @click="cancelRequest">
            <Loader2 v-if="cancelling" class="size-4 animate-spin" />
            Abbrechen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
