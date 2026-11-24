<script setup lang="ts">
import { ChevronDown, ChevronRight, RotateCw } from '@lucide/vue';
import { computed, onMounted, ref } from 'vue';
import { get } from '@/api/client';
import type { AgentProblem } from '@/api/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime, formatRelative } from '@/format';

/**
 * Was die Agents zuletzt an Warnungen und Fehlern gemeldet haben, über alle
 * Geräte zusammengefasst — am häufigsten betroffen zuerst.
 *
 * Am einzelnen Gerät steht das in der Karte „Agent-Zustand". Hier zeigt sich,
 * ob dieselbe Störung auf vielen Geräten auftritt; dann liegt die Ursache
 * selten beim Gerät.
 */
const rows = ref<AgentProblem[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
/** In Stunden: die letzte Stunde zeigt, ob eine Störung gerade noch anhält. */
const hours = ref('24');

const expanded = ref(new Set<string>());

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    rows.value = await get<AgentProblem[]>('/api/agent-problems', { hours: hours.value });
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Die Störungen konnten nicht geladen werden.';
  } finally {
    loading.value = false;
  }
}

/** Dieselbe Meldung kann als Störung und als offline vorkommen; zusammen sind sie eindeutig. */
function groupId(problem: AgentProblem): string {
  return `${problem.offline ? 'offline' : 'stoerung'}|${problem.key}`;
}

function toggle(problem: AgentProblem): void {
  const next = new Set(expanded.value);
  const id = groupId(problem);
  if (!next.delete(id)) next.add(id);
  expanded.value = next;
}

/** Die echten Störungen; die Offline-Gruppen kommen vom Backend zuletzt. */
const problems = computed(() => rows.value.filter((problem) => !problem.offline));
const firstOffline = computed(() => rows.value.find((problem) => problem.offline));

function onRangeChange(value: unknown): void {
  hours.value = String(value);
  void load();
}

onMounted(load);
</script>

<template>
  <div>
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <p class="text-muted-foreground max-w-4xl text-sm">
        Aus der Selbstauskunft im jüngsten Check-in jedes aktiven Geräts. Gleichartige Meldungen
        fallen zusammen; Zahlen wie Anzahlen oder Uhrzeiten zählen dabei nicht, Fehlercodes schon.
        Übermittlungsfehler fehlen: Der Check-in, der sie mitbringt, ist selbst angekommen.
      </p>
      <div class="ml-auto flex items-center gap-2">
        <Select :model-value="hours" @update:model-value="onRangeChange">
          <SelectTrigger class="w-44" aria-label="Zeitraum"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="1">Letzte Stunde</SelectItem>
            <SelectItem value="24">Letzte 24 Stunden</SelectItem>
            <SelectItem value="168">Letzte 7 Tage</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" :disabled="loading" @click="load">
          <RotateCw class="size-4" :class="loading ? 'animate-spin' : ''" />
          Aktualisieren
        </Button>
      </div>
    </div>

    <Alert v-if="error" variant="destructive" class="mb-4">
      <AlertDescription>{{ error }}</AlertDescription>
    </Alert>

    <div class="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="w-10" />
            <TableHead class="w-24">Stufe</TableHead>
            <TableHead>Meldung</TableHead>
            <TableHead class="w-24 text-right">Geräte</TableHead>
            <TableHead class="w-28 text-right">Meldungen</TableHead>
            <TableHead class="w-32">Zuletzt</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          <template v-if="loading && rows.length === 0">
            <TableRow v-for="n in 4" :key="n">
              <TableCell v-for="column in 6" :key="column">
                <Skeleton class="h-4 w-full" />
              </TableCell>
            </TableRow>
          </template>

          <TableRow v-else-if="rows.length === 0">
            <TableCell :colspan="6" class="text-muted-foreground py-8 text-center">
              Keine Störungen gemeldet.
            </TableCell>
          </TableRow>

          <TableRow v-else-if="problems.length === 0" class="hover:bg-transparent">
            <TableCell :colspan="6" class="text-muted-foreground py-6 text-center">
              Keine Störungen — nur Meldungen von Geräten, die offline waren.
            </TableCell>
          </TableRow>

          <template v-for="problem in rows" :key="groupId(problem)">
            <!-- Zwischenüberschrift vor der ersten Offline-Gruppe. -->
            <TableRow v-if="problem === firstOffline" class="bg-muted/40 hover:bg-muted/40">
              <TableCell :colspan="6" class="text-muted-foreground py-2 text-xs whitespace-normal">
                <span class="font-medium">Offline — weder Firmennetz noch VPN.</span>
                Die Update-Suche scheiterte, und im selben Durchlauf erreichte das Gerät auch das
                Backend nicht. Keine Störung, sondern der Normalfall unterwegs; zählt deshalb nicht mit.
              </TableCell>
            </TableRow>

            <TableRow
              class="cursor-pointer"
              :class="problem.offline ? 'text-muted-foreground' : ''"
              :aria-expanded="expanded.has(groupId(problem))"
              @click="toggle(problem)"
            >
              <TableCell>
                <ChevronDown v-if="expanded.has(groupId(problem))" class="text-muted-foreground size-4" />
                <ChevronRight v-else class="text-muted-foreground size-4" />
              </TableCell>
              <TableCell>
                <Badge
                  v-if="problem.offline"
                  variant="outline"
                  class="bg-muted text-muted-foreground border-transparent"
                >
                  offline
                </Badge>
                <Badge
                  v-else-if="problem.level === 'error'"
                  variant="outline"
                  class="bg-destructive/15 text-destructive border-destructive/30"
                >
                  Fehler
                </Badge>
                <Badge
                  v-else
                  variant="outline"
                  class="bg-warning/15 text-warning-foreground border-warning/40 dark:text-warning"
                >
                  Warnung
                </Badge>
              </TableCell>
              <TableCell class="text-sm break-words whitespace-normal">{{ problem.message }}</TableCell>
              <TableCell class="tabular text-right" :class="problem.offline ? '' : 'font-semibold'">
                {{ problem.devices }}
              </TableCell>
              <TableCell class="tabular text-right">{{ problem.occurrences }}</TableCell>
              <TableCell :title="formatDateTime(problem.lastAt)">{{ formatRelative(problem.lastAt) }}</TableCell>
            </TableRow>

            <TableRow v-if="expanded.has(groupId(problem))" class="hover:bg-transparent">
              <TableCell :colspan="6" class="bg-muted/30 p-4">
                <div class="rounded-md border bg-background">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead class="w-56">Gerät</TableHead>
                        <TableHead class="w-32">Zuletzt</TableHead>
                        <TableHead class="w-24 text-right">Meldungen</TableHead>
                        <TableHead>Wortlaut</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow v-for="entry in problem.entries" :key="entry.deviceId">
                        <TableCell class="font-medium">
                          <RouterLink
                            :to="{ name: 'device', params: { id: entry.deviceId } }"
                            class="hover:underline"
                          >
                            {{ entry.hostname }}
                          </RouterLink>
                        </TableCell>
                        <TableCell :title="formatDateTime(entry.lastAt)">{{ formatRelative(entry.lastAt) }}</TableCell>
                        <TableCell class="tabular text-right">{{ entry.occurrences }}</TableCell>
                        <TableCell class="text-muted-foreground text-xs break-words whitespace-normal">
                          {{ entry.message }}
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
  </div>
</template>
