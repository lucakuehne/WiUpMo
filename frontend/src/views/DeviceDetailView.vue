<script setup lang="ts">
import { AlertTriangle, Archive, ArrowLeft, ArrowUpCircle, Loader2 } from '@lucide/vue';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import { get, post } from '@/api/client';
import type {
  CreateUpdateJobsResult,
  DeviceDetail,
  Timeline,
  TimelineEntry,
} from '@/api/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import SourceLegend from '@/components/SourceLegend.vue';
import TablePager from '@/components/TablePager.vue';
import { formatDnPath } from '@/dn';
import {
  EVENT_TYPE_LABELS,
  UPDATE_SOURCE_LABELS,
  UPDATE_STATE_LABELS,
  eventBadgeClass,
  formatBytes,
  formatDateTime,
  formatHresult,
  formatRelative,
  sourceBadgeClass,
  stateBadgeClass,
} from '@/format';

const props = defineProps<{ id: string }>();

const router = useRouter();

const device = ref<DeviceDetail | null>(null);
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

const pagedUpdates = computed(() =>
  (device.value?.updates ?? []).slice(
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
        <AlertDescription>
          {{ device.archivedReason ?? 'Von Hand archiviert.' }}
          <span v-if="device.archivedAt" class="text-muted-foreground">
            ({{ formatDateTime(device.archivedAt) }})
          </span>
        </AlertDescription>
      </Alert>

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
          </dl>
        </CardContent>
      </Card>

      <Tabs default-value="updates">
        <TabsList>
          <TabsTrigger value="updates">Updates ({{ device.updates.length }})</TabsTrigger>
          <TabsTrigger value="timeline">Verlauf ({{ timelineTotal }})</TabsTrigger>
          <TabsTrigger value="checkins">Check-ins ({{ device.checkins.length }})</TabsTrigger>
        </TabsList>

        <!-- ===================== Updates ===================== -->
        <TabsContent value="updates">
          <div class="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead class="w-28">Status</TableHead>
                  <TableHead class="w-28">KB</TableHead>
                  <TableHead>Titel</TableHead>
                  <TableHead class="w-32">Einstufung</TableHead>
                  <TableHead class="w-24 text-right">Grösse</TableHead>
                  <TableHead class="w-40">Offen seit</TableHead>
                  <TableHead class="w-32">Fehlercode</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                <TableRow v-if="device.updates.length === 0">
                  <TableCell :colspan="7" class="text-muted-foreground py-8 text-center">
                    Für dieses Gerät sind keine Updates bekannt.
                  </TableCell>
                </TableRow>

                <TableRow v-for="update in pagedUpdates" :key="update.updateId">
                  <TableCell>
                    <Badge variant="outline" :class="stateBadgeClass(update.state)">
                      {{ UPDATE_STATE_LABELS[update.state] }}
                    </Badge>
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
                    <div>{{ update.title }}</div>
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
                    <code v-if="update.hresult" class="text-xs">
                      {{ formatHresult(update.hresult) }}
                    </code>
                    <span v-else class="text-muted-foreground">—</span>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          <TablePager
            v-model:page="updatePage"
            v-model:limit="updateLimit"
            :total="device.updates.length"
          />
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
      </Tabs>
    </template>
  </div>
</template>
