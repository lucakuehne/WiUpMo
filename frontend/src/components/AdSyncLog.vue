<script setup lang="ts">
import { RefreshCw } from '@lucide/vue';
import { onMounted, ref } from 'vue';
import { toast } from 'vue-sonner';
import { get, post } from '@/api/client';
import type { AdStatus, AdSyncResult, AdSyncRun, Paged } from '@/api/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import TablePager from '@/components/TablePager.vue';
import { formatDateTime } from '@/format';

/**
 * Der Abgleich mitsamt Protokoll — direkt bei den Einstellungen, die ihn
 * steuern.
 *
 * Früher eine eigene Seite unter /ad. Sie zeigte zur Hälfte dieselben Werte
 * noch einmal an (Server, Suchwurzel, Filter, Intervall), die man einen Klick
 * weiter ohnehin bearbeitet — und wer eine Organisationseinheit ändert, will
 * unmittelbar sehen, was der nächste Lauf daraus macht.
 */
const status = ref<AdStatus | null>(null);
const runs = ref<AdSyncRun[]>([]);
const total = ref(0);
const page = ref(1);

// Zehn statt der üblichen fünfundzwanzig: Das Protokoll steht unter den
// Einstellungen, nicht auf einer eigenen Seite — es soll den Blick auf die
// letzten Läufe geben, ohne das Formular darüber wegzuschieben.
const limit = ref(10);
const loading = ref(true);
const syncing = ref(false);
const error = ref<string | null>(null);

async function load(): Promise<void> {
  error.value = null;

  try {
    const [current, history] = await Promise.all([
      get<AdStatus>('/api/ad/status'),
      get<Paged<AdSyncRun>>('/api/ad/sync-runs', { page: page.value, limit: limit.value }),
    ]);

    status.value = current;
    runs.value = history.items;
    total.value = history.total;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Der Stand des Abgleichs ist nicht abrufbar.';
  } finally {
    loading.value = false;
  }
}

/** Ein neuer Lauf steht oben — nach dem Abgleich gehört die erste Seite gezeigt. */
function reset(): Promise<void> {
  page.value = 1;
  return load();
}

async function runSync(): Promise<void> {
  syncing.value = true;
  error.value = null;

  try {
    const result = await post<AdSyncResult>('/api/ad/sync');

    // Der Endpunkt antwortet auch bei einem gescheiterten Abgleich mit 200 —
    // der Lauf ist protokolliert, das ist kein Fehler der Anfrage.
    if (result.status === 'failed') {
      error.value = result.error ?? 'Der Abgleich ist fehlgeschlagen.';
    } else {
      toast.success(`${result.devicesFound} Konten gelesen.`, {
        description:
          `${result.devicesCreated} neu angelegt, ${result.devicesReactivated} reaktiviert, ` +
          `${result.devicesArchived} archiviert.`,
      });
    }

    await reset();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Der Abgleich konnte nicht gestartet werden.';
  } finally {
    syncing.value = false;
  }
}

function statusClass(value: AdSyncRun['status']): string {
  switch (value) {
    case 'success':
      return 'bg-success/15 text-success border-success/30';
    case 'failed':
      return 'bg-destructive/15 text-destructive border-destructive/30';
    default:
      return 'bg-muted text-muted-foreground border-transparent';
  }
}

const STATUS_LABELS: Record<AdSyncRun['status'], string> = {
  running: 'läuft',
  success: 'erfolgreich',
  failed: 'fehlgeschlagen',
};

onMounted(load);

// Die Einstellungen laden das Protokoll nach dem Speichern neu: Ein geänderter
// Suchbereich stösst serverseitig sofort einen Lauf an, der dann hier steht.
defineExpose({ reload: reset });
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>Abgleich</CardTitle>
      <CardDescription>
        Die letzten Läufe. Ein geänderter Suchbereich läuft von selbst an, das Intervall steht
        oben.
      </CardDescription>

      <CardAction>
        <Button
          variant="outline"
          size="sm"
          :disabled="syncing || !status?.enabled || status?.running"
          @click="runSync"
        >
          <RefreshCw class="size-4" :class="syncing ? 'animate-spin' : ''" />
          Jetzt abgleichen
        </Button>
      </CardAction>
    </CardHeader>

    <CardContent class="space-y-4">
      <Alert v-if="error" variant="destructive">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <Alert v-if="status && !status.enabled">
        <AlertDescription>
          Die Anbindung ist noch nicht vollständig: Ohne Domänencontroller und ohne einen Bereich
          im Verzeichnis gibt es nichts abzugleichen.
        </AlertDescription>
      </Alert>

      <div class="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead class="w-40">Start</TableHead>
              <TableHead class="w-40">Ende</TableHead>
              <TableHead class="w-28">Auslöser</TableHead>
              <TableHead class="w-32">Status</TableHead>
              <TableHead class="w-24 text-right">Gefunden</TableHead>
              <TableHead class="w-20 text-right">Neu</TableHead>
              <TableHead class="w-24 text-right">Archiviert</TableHead>
              <TableHead>Fehler</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            <TableRow v-if="!loading && runs.length === 0">
              <TableCell :colspan="8" class="text-muted-foreground py-8 text-center">
                Noch kein Abgleich gelaufen.
              </TableCell>
            </TableRow>

            <TableRow v-for="run in runs" :key="run.id">
              <TableCell>{{ formatDateTime(run.startedAt) }}</TableCell>
              <TableCell>{{ formatDateTime(run.finishedAt) }}</TableCell>
              <TableCell>{{ run.trigger === 'manual' ? 'von Hand' : 'geplant' }}</TableCell>
              <TableCell>
                <Badge variant="outline" :class="statusClass(run.status)">
                  {{ STATUS_LABELS[run.status] }}
                </Badge>
              </TableCell>
              <TableCell class="tabular text-right">{{ run.devicesFound }}</TableCell>
              <TableCell class="tabular text-right">{{ run.devicesCreated }}</TableCell>
              <TableCell class="tabular text-right">{{ run.devicesArchived }}</TableCell>
              <TableCell class="text-destructive text-xs">{{ run.error ?? '' }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <TablePager
        v-model:page="page"
        v-model:limit="limit"
        :total="total"
        :page-sizes="[10, 25, 50]"
        @update:page="load"
        @update:limit="
          page = 1;
          load();
        "
      />
    </CardContent>
  </Card>
</template>
