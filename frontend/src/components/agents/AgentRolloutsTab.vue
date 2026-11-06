<script setup lang="ts">
import { Ban, ChevronDown, ChevronRight, Loader2, RotateCw, XCircle } from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { toast } from 'vue-sonner';
import { get, post } from '@/api/client';
import type { AgentRollout, AgentUpdateJobView, Paged } from '@/api/types';
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
import JobStateLegend from '@/components/JobStateLegend.vue';
import TablePager from '@/components/TablePager.vue';
import { JOB_STATE_LABELS, formatDateTime, jobBadgeClass } from '@/format';

/**
 * Jedes Ausrollen einer Agent-Version, neueste zuerst; aufgeklappt stehen
 * darunter die Geräte mit ihrem Auftrag. Gebaut wie die Installationen bei
 * den Windows-Updates.
 *
 * Solange etwas offen ist, lädt die Liste alle 30 Sekunden nach.
 */
const route = useRoute();

const REFRESH_MS = 30_000;

/** So vermerkt das Backend einen von Hand abgebrochenen Auftrag. */
const CANCELLED_ERROR = 'Von Hand abgebrochen.';

type RolloutState = keyof AgentRollout['states'];

/** Abgeschlossenes zuerst, dann was läuft, dann was noch wartet; Abgebrochenes zuletzt. */
const ORDER: RolloutState[] = ['done', 'failed', 'installing', 'delivered', 'pending', 'cancelled'];

const SEGMENT_CLASS: Record<RolloutState, string> = {
  done: 'bg-success',
  failed: 'bg-destructive',
  installing: 'bg-warning',
  delivered: 'bg-chart-4',
  pending: 'bg-chart-1',
  cancelled: 'bg-muted-foreground/25',
};

const rows = ref<AgentRollout[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref<string | null>(null);

const page = ref(1);
const limit = ref(25);

const expanded = ref(new Set<string>());
const jobs = ref<Record<string, AgentUpdateJobView[] | undefined>>({});

const confirmCancel = ref<AgentRollout | null>(null);
const confirmCancelAll = ref(false);
const cancelling = ref(false);

function segments(rollout: AgentRollout) {
  return ORDER.map((state) => ({
    key: state,
    count: rollout.states[state],
    label: state === 'cancelled' ? 'abgebrochen' : JOB_STATE_LABELS[state],
    class: SEGMENT_CLASS[state],
  }));
}

/** Offen heisst: noch nicht abgeschlossen. Nur solche lassen sich abbrechen. */
function open(rollout: AgentRollout): number {
  return rollout.states.pending + rollout.states.delivered + rollout.states.installing;
}

const anyOpen = computed(() => rows.value.some((rollout) => open(rollout) > 0));

function scopeLabel(rollout: AgentRollout): string {
  if (rollout.scope === 'outdated') return 'alle mit anderer Version';
  if (rollout.scope === 'selected') return `Auswahl (${rollout.requestedDevices ?? '?'})`;
  return '—';
}

function isCancelled(job: AgentUpdateJobView): boolean {
  return job.state === 'failed' && job.error === CANCELLED_ERROR;
}

async function load(quiet = false): Promise<void> {
  if (!quiet) loading.value = true;
  error.value = null;

  try {
    const result = await get<Paged<AgentRollout>>('/api/agent-rollouts', {
      page: page.value,
      limit: limit.value,
    });
    rows.value = result.items;
    total.value = result.total;

    await Promise.all([...expanded.value].map((id) => loadJobs(id)));
  } catch (e) {
    if (!quiet) {
      error.value = e instanceof Error ? e.message : 'Die Agent-Updates konnten nicht geladen werden.';
    }
  } finally {
    loading.value = false;
  }
}

async function loadJobs(id: string): Promise<void> {
  jobs.value = { ...jobs.value, [id]: await get<AgentUpdateJobView[]>(`/api/agent-rollouts/${id}/jobs`) };
}

async function toggle(rollout: AgentRollout): Promise<void> {
  const next = new Set(expanded.value);
  if (next.delete(rollout.id)) {
    expanded.value = next;
    return;
  }

  next.add(rollout.id);
  expanded.value = next;
  if (!jobs.value[rollout.id]) {
    await loadJobs(rollout.id);
  }
}

async function cancelRollout(): Promise<void> {
  const rollout = confirmCancel.value;
  if (!rollout) return;

  cancelling.value = true;
  try {
    const result = await post<{ cancelled: number }>(`/api/agent-rollouts/${rollout.id}/cancel`);
    toast.success(
      result.cancelled > 0
        ? `${result.cancelled} Auftrag/Aufträge abgebrochen.`
        : 'Nichts mehr abzubrechen — die Aufträge sind abgeschlossen.',
    );
    confirmCancel.value = null;
    await load(true);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Das Ausrollen konnte nicht abgebrochen werden.';
  } finally {
    cancelling.value = false;
  }
}

async function cancelAll(): Promise<void> {
  cancelling.value = true;
  try {
    const result = await post<{ cancelled: number }>('/api/agent-update-jobs/cancel-open');
    toast.success(`${result.cancelled} Auftrag/Aufträge abgebrochen.`, {
      description: 'Die betroffenen Geräte können jetzt wieder beauftragt werden.',
    });
    confirmCancelAll.value = false;
    await load(true);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Abbrechen fehlgeschlagen.';
  } finally {
    cancelling.value = false;
  }
}

let timer: ReturnType<typeof setInterval> | undefined;

onMounted(async () => {
  // Aus der Bestätigung eines Ausrollens: das gemeinte gleich offen.
  const wanted = route.query.rollout;
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
      <p class="text-muted-foreground min-w-0 flex-1 text-sm">
        Jedes Ausrollen einer Agent-Version, neueste zuerst. Ein Gerät holt seinen Auftrag beim
        nächsten Check-in ab; solange einer offen ist, bekommt es keinen neuen.
      </p>
      <span class="text-muted-foreground tabular text-sm">{{ total }} Ausrollen</span>
      <Button variant="outline" size="sm" :disabled="cancelling" @click="confirmCancelAll = true">
        <Ban class="size-4" />
        Alle offenen abbrechen
      </Button>
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
            <TableHead class="w-32">Zielversion</TableHead>
            <TableHead>Umfang</TableHead>
            <TableHead class="w-24 text-right">Geräte</TableHead>
            <TableHead class="w-80">
              <span class="inline-flex items-center gap-1">Fortschritt <JobStateLegend /></span>
            </TableHead>
            <TableHead class="w-40">Zuletzt abgeschlossen</TableHead>
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
              Noch nichts ausgerollt.
            </TableCell>
          </TableRow>

          <template v-for="rollout in rows" :key="rollout.id">
            <TableRow
              class="cursor-pointer"
              :aria-expanded="expanded.has(rollout.id)"
              @click="toggle(rollout)"
            >
              <TableCell>
                <ChevronDown v-if="expanded.has(rollout.id)" class="text-muted-foreground size-4" />
                <ChevronRight v-else class="text-muted-foreground size-4" />
              </TableCell>

              <TableCell>
                <div>{{ formatDateTime(rollout.createdAt) }}</div>
                <div class="text-muted-foreground text-xs">{{ rollout.createdBy ?? '—' }}</div>
              </TableCell>

              <TableCell class="tabular">{{ rollout.targetVersion }}</TableCell>
              <TableCell>{{ scopeLabel(rollout) }}</TableCell>

              <TableCell class="tabular text-right">
                <div class="font-semibold">{{ rollout.devices }}</div>
                <div v-if="rollout.skipped > 0" class="text-muted-foreground text-xs">
                  {{ rollout.skipped }} übergangen
                </div>
              </TableCell>

              <TableCell><JobProgress :segments="segments(rollout)" /></TableCell>
              <TableCell>{{ formatDateTime(rollout.lastCompletedAt) }}</TableCell>
            </TableRow>

            <TableRow v-if="expanded.has(rollout.id)" class="hover:bg-transparent">
              <TableCell :colspan="7" class="bg-muted/30 p-4">
                <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p class="text-muted-foreground text-xs">
                    <template v-if="rollout.skipped > 0">
                      {{ rollout.skipped }} weitere Geräte hatten schon einen offenen Auftrag und
                      wurden übergangen.
                    </template>
                  </p>
                  <Button
                    v-if="open(rollout) > 0"
                    size="sm"
                    variant="outline"
                    @click="confirmCancel = rollout"
                  >
                    <XCircle class="size-4" />
                    Offene abbrechen ({{ open(rollout) }})
                  </Button>
                </div>

                <p v-if="!jobs[rollout.id]" class="text-muted-foreground text-xs">Wird geladen …</p>

                <div v-else class="rounded-md border bg-background">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Gerät</TableHead>
                        <TableHead class="w-40">Status</TableHead>
                        <TableHead class="w-40">Abgeschlossen</TableHead>
                        <TableHead>Fehler</TableHead>
                      </TableRow>
                    </TableHeader>

                    <TableBody>
                      <TableRow v-if="jobs[rollout.id]!.length === 0">
                        <TableCell :colspan="4" class="text-muted-foreground py-6 text-center">
                          Die Geräte dieses Ausrollens gibt es nicht mehr.
                        </TableCell>
                      </TableRow>

                      <TableRow v-for="job in jobs[rollout.id]" :key="job.id">
                        <TableCell class="font-medium">
                          <RouterLink
                            :to="{ name: 'device', params: { id: job.deviceId } }"
                            class="hover:underline"
                          >
                            {{ job.hostname }}
                          </RouterLink>
                        </TableCell>
                        <TableCell>
                          <Badge
                            v-if="isCancelled(job)"
                            variant="outline"
                            class="bg-muted text-muted-foreground border-transparent"
                          >
                            abgebrochen
                          </Badge>
                          <Badge v-else variant="outline" :class="jobBadgeClass(job.state)">
                            {{ JOB_STATE_LABELS[job.state] }}
                          </Badge>
                        </TableCell>
                        <TableCell>{{ formatDateTime(job.completedAt) }}</TableCell>
                        <TableCell
                          class="text-xs"
                          :class="isCancelled(job) ? 'text-muted-foreground' : 'text-destructive'"
                        >
                          {{ isCancelled(job) ? '' : (job.error ?? '') }}
                        </TableCell>
                      </TableRow>
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
          <DialogTitle>Offene Aufträge dieses Ausrollens abbrechen?</DialogTitle>
          <DialogDescription v-if="confirmCancel">
            {{ open(confirmCancel) }} Aufträge auf {{ confirmCancel.targetVersion }} werden als
            abgebrochen vermerkt; die Geräte lassen sich danach wieder beauftragen. Einen Tausch, der
            auf einem Gerät schon läuft, hält das nicht auf.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="confirmCancel = null">Zurück</Button>
          <Button variant="destructive" :disabled="cancelling" @click="cancelRollout">
            <Loader2 v-if="cancelling" class="size-4 animate-spin" />
            Abbrechen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="confirmCancelAll" @update:open="confirmCancelAll = false">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Alle offenen Agent-Updates abbrechen?</DialogTitle>
          <DialogDescription>
            Alle noch nicht abgeschlossenen Aufträge, über alle Ausrollen hinweg, werden als
            abgebrochen vermerkt. Die Geräte lassen sich danach wieder beauftragen. Einen Tausch, der
            auf einem Gerät schon läuft, hält das nicht auf.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="confirmCancelAll = false">Zurück</Button>
          <Button variant="destructive" :disabled="cancelling" @click="cancelAll">
            <Loader2 v-if="cancelling" class="size-4 animate-spin" />
            Alle abbrechen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
