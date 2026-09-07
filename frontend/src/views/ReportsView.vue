<script setup lang="ts">
import { AlertTriangle } from '@lucide/vue';
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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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
  UPDATE_SOURCE_LABELS,
  formatDateTime,
  formatHresult,
  formatRelative,
  sourceBadgeClass,
} from '@/format';
import { usePagedList } from '@/paged';

const router = useRouter();

const compliance = ref<ComplianceDevice[]>([]);
const patchAge = ref<PatchAgeReport | null>(null);
const osBuilds = ref<PatchAgeReport['osBuilds']>([]);
const sources = ref<UpdateSourcesReport | null>(null);
const changes = ref<SourceChange[]>([]);
const stale = ref<StaleAgent[]>([]);
const missing = ref<MissingAgent[]>([]);
const timeToPatch = ref<TimeToPatch[]>([]);
const failures = ref<FailureGroup[]>([]);

const loading = ref(true);
const error = ref<string | null>(null);

const compliancePage = usePagedList(compliance);
const buildsPage = usePagedList(osBuilds, 15);
const changesPage = usePagedList(changes, 15);
const stalePage = usePagedList(stale);
const missingPage = usePagedList(missing);
const failuresPage = usePagedList(failures);

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
    osBuilds.value = p.osBuilds;
    sources.value = s;
    changes.value = s.changes;
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

/** Die OU als Pfad, wie überall sonst — der DN bleibt als Hinweistext. */
function ouPath(dn: string | null): string {
  return dn ? formatDnPath(dn) : '—';
}

onMounted(load);
</script>

<template>
  <div class="mx-auto max-w-[1600px] px-5 py-6">
    <h1 class="mb-4 text-xl font-semibold">Auswertungen</h1>

    <Alert v-if="error" variant="destructive" class="mb-4">
      <AlertDescription>{{ error }}</AlertDescription>
    </Alert>

    <div v-if="loading" class="space-y-3">
      <Skeleton class="h-9 w-full max-w-3xl" />
      <Skeleton class="h-64 w-full" />
    </div>

    <Tabs v-else default-value="compliance">
      <TabsList class="flex-wrap">
        <TabsTrigger value="compliance">Compliance ({{ compliance.length }})</TabsTrigger>
        <TabsTrigger value="patchage">Patch-Alter</TabsTrigger>
        <TabsTrigger value="sources">Update-Quellen</TabsTrigger>
        <TabsTrigger value="stale">Stumme Agents ({{ stale.length }})</TabsTrigger>
        <TabsTrigger value="missing">Ohne Agent ({{ missing.length }})</TabsTrigger>
        <TabsTrigger value="ttp">Time-to-Patch</TabsTrigger>
        <TabsTrigger value="failures">Fehlschläge ({{ failures.length }})</TabsTrigger>
      </TabsList>

      <!-- ===================== Compliance ===================== -->
      <TabsContent value="compliance">
        <p class="text-muted-foreground mb-3 text-sm">
          Geräte mit sicherheitsrelevanten Updates, die länger offen sind als der Schwellwert aus
          den Einstellungen. Älteste zuerst.
        </p>

        <div class="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Gerät</TableHead>
                <TableHead>OU</TableHead>
                <TableHead class="w-24 text-right">Offen</TableHead>
                <TableHead class="w-28 text-right">seit (Tage)</TableHead>
                <TableHead class="w-40">Letzter Check-in</TableHead>
                <TableHead class="w-24">Neustart</TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              <TableRow v-if="compliance.length === 0">
                <TableCell :colspan="6" class="text-muted-foreground py-8 text-center">
                  Kein Gerät überschreitet den Schwellwert.
                </TableCell>
              </TableRow>

              <TableRow
                v-for="row in compliancePage.items"
                :key="row.deviceId"
                class="cursor-pointer"
                @click="openDevice(row.deviceId)"
              >
                <TableCell class="font-medium">{{ row.hostname }}</TableCell>
                <TableCell class="truncate" :title="row.adOu ?? ''">{{ ouPath(row.adOu) }}</TableCell>
                <TableCell class="tabular text-right">{{ row.openSecurityUpdates }}</TableCell>
                <TableCell class="tabular text-destructive text-right font-semibold">
                  {{ row.oldestOpenDays }}
                </TableCell>
                <TableCell>{{ formatRelative(row.lastSeenAt) }}</TableCell>
                <TableCell>
                  <AlertTriangle v-if="row.pendingReboot" class="text-warning size-4" />
                  <span v-else class="text-muted-foreground">—</span>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <TablePager
          v-model:page="compliancePage.page"
          v-model:limit="compliancePage.limit"
          :total="compliancePage.total"
        />
      </TabsContent>

      <!-- ===================== Patch-Alter ===================== -->
      <TabsContent value="patchage">
        <p class="text-muted-foreground mb-3 text-sm">
          Verteilung über das Alter des jeweils ältesten offenen Updates, und die OS-Builds der
          Flotte — dort zeigt sich, wer beim monatlichen kumulativen Update hängengeblieben ist.
        </p>

        <div class="grid items-start gap-4 lg:grid-cols-[minmax(18rem,1fr)_2fr]">
          <div class="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Patch-Alter</TableHead>
                  <TableHead class="w-24 text-right">Geräte</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="bucket in patchAge?.buckets ?? []" :key="bucket.label">
                  <TableCell>{{ bucket.label }}</TableCell>
                  <TableCell class="tabular text-right">{{ bucket.devices }}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          <div>
            <div class="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Betriebssystem</TableHead>
                    <TableHead class="w-32">Build</TableHead>
                    <TableHead class="w-24 text-right">Geräte</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="build in buildsPage.items" :key="`${build.osName}-${build.osBuild}`">
                    <TableCell>{{ build.osName ?? '—' }}</TableCell>
                    <TableCell class="tabular">{{ build.osBuild ?? '—' }}</TableCell>
                    <TableCell class="tabular text-right">{{ build.devices }}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>

            <TablePager
              v-model:page="buildsPage.page"
              v-model:limit="buildsPage.limit"
              :total="buildsPage.total"
              :page-sizes="[15, 30, 60]"
            />
          </div>
        </div>
      </TabsContent>

      <!-- ===================== Update-Quellen ===================== -->
      <TabsContent value="sources">
        <p class="text-muted-foreground mb-3 text-sm">
          Rechts die Geräte, deren Quelle sich beim letzten Check-in geändert hat — das ist der
          Migrationsfortschritt, gemessen am tatsächlichen Verhalten statt an der Richtlinie.
        </p>

        <div class="grid items-start gap-4 lg:grid-cols-[minmax(18rem,1fr)_2fr]">
          <div class="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <span class="inline-flex items-center gap-1">Quelle <SourceLegend /></span>
                  </TableHead>
                  <TableHead class="w-24 text-right">Geräte</TableHead>
                  <TableHead class="w-24 text-right">Median</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="entry in sources?.distribution ?? []" :key="entry.source">
                  <TableCell>
                    <Badge variant="outline" :class="sourceBadgeClass(entry.source)">
                      {{ UPDATE_SOURCE_LABELS[entry.source] }}
                    </Badge>
                  </TableCell>
                  <TableCell class="tabular text-right">{{ entry.devices }}</TableCell>
                  <TableCell class="tabular text-right">
                    {{ entry.medianPatchAgeDays ?? '—' }}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          <div>
            <div class="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Gerät</TableHead>
                    <TableHead>
                      <span class="inline-flex items-center gap-1">von → nach <SourceLegend /></span>
                    </TableHead>
                    <TableHead class="w-40">Wann</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-if="changes.length === 0">
                    <TableCell :colspan="3" class="text-muted-foreground py-8 text-center">
                      Kein Quellenwechsel festgestellt.
                    </TableCell>
                  </TableRow>

                  <TableRow
                    v-for="change in changesPage.items"
                    :key="change.deviceId"
                    class="cursor-pointer"
                    @click="openDevice(change.deviceId)"
                  >
                    <TableCell class="font-medium">{{ change.hostname }}</TableCell>
                    <TableCell>
                      <span class="text-muted-foreground">
                        {{ UPDATE_SOURCE_LABELS[change.previousSource] }}
                      </span>
                      →
                      <Badge variant="outline" :class="sourceBadgeClass(change.currentSource)">
                        {{ UPDATE_SOURCE_LABELS[change.currentSource] }}
                      </Badge>
                    </TableCell>
                    <TableCell>{{ formatDateTime(change.changedAt) }}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>

            <TablePager
              v-model:page="changesPage.page"
              v-model:limit="changesPage.limit"
              :total="changesPage.total"
              :page-sizes="[15, 30, 60]"
            />
          </div>
        </div>
      </TabsContent>

      <!-- ===================== Stumme Agents ===================== -->
      <TabsContent value="stale">
        <p class="text-muted-foreground mb-3 text-sm">
          Registriert, aber seit längerem stumm. Das unterscheidet „ist gepatcht" von „meldet sich
          nicht mehr" — zwei Zustände, die in einer Compliance-Zahl sonst gleich aussehen.
        </p>

        <div class="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Gerät</TableHead>
                <TableHead>OU</TableHead>
                <TableHead class="w-40 text-right">Stumm seit (Tage)</TableHead>
                <TableHead class="w-40">Letzter Check-in</TableHead>
                <TableHead class="w-28">Agent</TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              <TableRow v-if="stale.length === 0">
                <TableCell :colspan="5" class="text-muted-foreground py-8 text-center">
                  Alle Agents melden sich.
                </TableCell>
              </TableRow>

              <TableRow
                v-for="row in stalePage.items"
                :key="row.deviceId"
                class="cursor-pointer"
                @click="openDevice(row.deviceId)"
              >
                <TableCell class="font-medium">{{ row.hostname }}</TableCell>
                <TableCell class="truncate" :title="row.adOu ?? ''">{{ ouPath(row.adOu) }}</TableCell>
                <TableCell class="tabular text-right">
                  {{ row.daysSilent ?? 'nie gemeldet' }}
                </TableCell>
                <TableCell>{{ formatDateTime(row.lastSeenAt) }}</TableCell>
                <TableCell class="tabular">{{ row.agentVersion ?? '—' }}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <TablePager
          v-model:page="stalePage.page"
          v-model:limit="stalePage.limit"
          :total="stalePage.total"
        />
      </TabsContent>

      <!-- ===================== Ohne Agent ===================== -->
      <TabsContent value="missing">
        <p class="text-muted-foreground mb-3 text-sm">
          Im AD vorhanden, ohne installierten Agent — die Deployment-Lücke.
        </p>

        <div class="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Gerät</TableHead>
                <TableHead>OU</TableHead>
                <TableHead>Betriebssystem (aus dem AD)</TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              <TableRow v-if="missing.length === 0">
                <TableCell :colspan="3" class="text-muted-foreground py-8 text-center">
                  Auf jedem AD-Gerät läuft ein Agent.
                </TableCell>
              </TableRow>

              <TableRow v-for="row in missingPage.items" :key="row.deviceId">
                <TableCell class="font-medium">{{ row.hostname }}</TableCell>
                <TableCell class="truncate" :title="row.adOu ?? ''">{{ ouPath(row.adOu) }}</TableCell>
                <TableCell>{{ row.osName ?? '—' }}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <TablePager
          v-model:page="missingPage.page"
          v-model:limit="missingPage.limit"
          :total="missingPage.total"
        />
      </TabsContent>

      <!-- ===================== Time-to-Patch ===================== -->
      <TabsContent value="ttp">
        <p class="text-muted-foreground mb-3 text-sm">
          Tage von „erstmals als verfügbar gemeldet" bis „installiert". Nur Zustände, in denen
          beide Zeitpunkte bekannt sind — sonst wäre die Zahl frei erfunden.
        </p>

        <div class="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Einstufung</TableHead>
                <TableHead class="w-36 text-right">Installationen</TableHead>
                <TableHead class="w-36 text-right">Median (Tage)</TableHead>
                <TableHead class="w-36 text-right">90. Perzentil</TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              <TableRow v-if="timeToPatch.length === 0">
                <TableCell :colspan="4" class="text-muted-foreground py-8 text-center">
                  Noch keine abgeschlossenen Installationen mit bekanntem Startzeitpunkt.
                </TableCell>
              </TableRow>

              <TableRow v-for="row in timeToPatch" :key="row.severity">
                <TableCell>{{ row.severity }}</TableCell>
                <TableCell class="tabular text-right">{{ row.updates }}</TableCell>
                <TableCell class="tabular text-right">{{ row.medianDays }}</TableCell>
                <TableCell class="tabular text-right">{{ row.p90Days }}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </TabsContent>

      <!-- ===================== Fehlschläge ===================== -->
      <TabsContent value="failures">
        <p class="text-muted-foreground mb-3 text-sm">
          Gescheiterte Installationen, nach Update und Fehlercode gruppiert. Trifft derselbe Code
          viele Geräte, ist es kein Einzelfall.
        </p>

        <div class="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead class="w-28">KB</TableHead>
                <TableHead>Update</TableHead>
                <TableHead class="w-36">Fehlercode</TableHead>
                <TableHead class="w-24 text-right">Geräte</TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              <TableRow v-if="failures.length === 0">
                <TableCell :colspan="4" class="text-muted-foreground py-8 text-center">
                  Keine gescheiterten Installationen.
                </TableCell>
              </TableRow>

              <TableRow v-for="row in failuresPage.items" :key="`${row.updateId}-${row.hresult}`">
                <TableCell>
                  <span v-if="row.kbArticle">KB{{ row.kbArticle }}</span>
                  <span v-else class="text-muted-foreground">—</span>
                </TableCell>
                <TableCell>{{ row.title }}</TableCell>
                <TableCell><code class="text-xs">{{ formatHresult(row.hresult) }}</code></TableCell>
                <TableCell class="tabular text-right">{{ row.devices }}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <TablePager
          v-model:page="failuresPage.page"
          v-model:limit="failuresPage.limit"
          :total="failuresPage.total"
        />
      </TabsContent>
    </Tabs>
  </div>
</template>
