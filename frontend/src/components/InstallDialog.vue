<script setup lang="ts">
import { Loader2 } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import { toast } from 'vue-sonner';
import { get, post } from '@/api/client';
import type {
  CreateInstallJobsResult,
  InstallJobScope,
  InstallPreview,
  SettingsView,
  UpdateClassification,
} from '@/api/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { UPDATE_CLASSIFICATION_LABELS } from '@/format';

/**
 * Legt Installationsaufträge an — für ein Gerät aus dem Gerätedetail oder für
 * eine Auswahl aus der Geräteliste.
 *
 * Ausgeführt wird erst vom Agent ab 0.7.0; ältere übergeht das Backend und
 * zählt sie in der Antwort. Ein Neustart folgt nie von selbst.
 */
const props = defineProps<{
  open: boolean;
  deviceIds: string[];
  /** Katalog-IDs aus dem Gerätedetail; ohne sie gibt es den Umfang „ausgewählte" nicht. */
  selectedUpdateIds?: string[];
  /** Für den Titel, wenn es um ein einzelnes Gerät geht. */
  hostname?: string;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  created: [result: CreateInstallJobsResult];
}>();

const ALL_TYPES = Object.keys(UPDATE_CLASSIFICATION_LABELS) as UpdateClassification[];

const scope = ref<InstallJobScope>('types');
const types = ref(new Set<UpdateClassification>(ALL_TYPES));
const preview = ref<InstallPreview['classifications'] | null>(null);
const timing = ref<'now' | 'later'>('now');
const notBeforeLocal = ref('');
const spreadMinutes = ref(15);
const expiryDays = ref<number | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);

const selectedCount = computed(() => props.selectedUpdateIds?.length ?? 0);
const multiple = computed(() => props.deviceIds.length > 1);

/** Bis die Vorschau da ist, stehen die Typen ohne Zahlen da. */
const rows = computed(() =>
  ALL_TYPES.map((classification) => {
    const counts = preview.value?.find((row) => row.classification === classification);
    return { classification, updates: counts?.updates ?? null, devices: counts?.devices ?? null };
  }),
);

const allTypesState = computed<boolean | 'indeterminate'>(() => {
  if (types.value.size === 0) return false;
  return types.value.size === ALL_TYPES.length ? true : 'indeterminate';
});

function toggleType(type: UpdateClassification, checked: boolean): void {
  const next = new Set(types.value);
  if (checked) next.add(type);
  else next.delete(type);
  types.value = next;
}

function toggleAllTypes(checked: boolean): void {
  types.value = new Set(checked ? ALL_TYPES : []);
}

function countLabel(row: { updates: number | null; devices: number | null }): string {
  if (row.updates === null) return '';
  if (row.updates === 0) return '—';
  return multiple.value ? `${row.updates} auf ${row.devices} Geräten` : `${row.updates} offen`;
}

const canSubmit = computed(() => (scope.value === 'selected' ? selectedCount.value > 0 : types.value.size > 0));

/** Für das Eingabefeld: lokale Zeit ohne Sekunden, eine Stunde voraus, auf die volle Viertelstunde. */
function defaultLater(): string {
  const date = new Date(Date.now() + 3_600_000);
  date.setMinutes(Math.ceil(date.getMinutes() / 15) * 15, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    scope.value = selectedCount.value > 0 ? 'selected' : 'types';
    types.value = new Set(ALL_TYPES);
    preview.value = null;
    timing.value = 'now';
    notBeforeLocal.value = defaultLater();
    spreadMinutes.value = 15;
    error.value = null;

    // Beides nur zur Anzeige; fehlt es, lässt sich trotzdem anlegen.
    const [previewResult, settings] = await Promise.allSettled([
      post<InstallPreview>('/api/install-jobs/preview', { deviceIds: props.deviceIds }),
      get<SettingsView>('/api/settings'),
    ]);
    preview.value = previewResult.status === 'fulfilled' ? previewResult.value.classifications : null;
    expiryDays.value = settings.status === 'fulfilled' ? settings.value.install.expiryDays : null;
  },
);

function close(): void {
  emit('update:open', false);
}

async function submit(): Promise<void> {
  busy.value = true;
  error.value = null;

  try {
    const result = await post<CreateInstallJobsResult>('/api/install-jobs', {
      deviceIds: props.deviceIds,
      scope: scope.value,
      updateIds: scope.value === 'selected' ? props.selectedUpdateIds : undefined,
      classifications: scope.value === 'types' ? [...types.value] : undefined,
      notBefore: timing.value === 'later' ? new Date(notBeforeLocal.value).toISOString() : undefined,
      spreadMinutes: multiple.value ? spreadMinutes.value : undefined,
    });

    const skipped = [
      result.skipped.agentTooOld > 0 ? `${result.skipped.agentTooOld} mit Agent älter als ${result.minimumAgentVersion}` : '',
      result.skipped.openJob > 0 ? `${result.skipped.openJob} mit bereits offenem Auftrag` : '',
      result.skipped.nothingOpen > 0 ? `${result.skipped.nothingOpen} ohne passendes installierbares Update` : '',
      result.skipped.notEligible > 0 ? `${result.skipped.notEligible} archiviert oder ohne Agent` : '',
    ].filter(Boolean);

    if (result.created > 0) {
      toast.success(`${result.created} Installationsauftrag/-aufträge angelegt.`, {
        description: skipped.length > 0 ? `Übergangen: ${skipped.join(', ')}.` : undefined,
      });
    } else {
      toast.info('Kein Auftrag angelegt.', { description: `Übergangen: ${skipped.join(', ')}.` });
    }

    emit('created', result);
    close();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Die Aufträge konnten nicht angelegt werden.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="(value: boolean) => emit('update:open', value)">
    <DialogContent class="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>
          Offene Updates installieren
          <template v-if="hostname"> — {{ hostname }}</template>
          <template v-else-if="multiple"> — {{ deviceIds.length }} Geräte</template>
        </DialogTitle>
        <DialogDescription>
          Der Agent installiert über Windows Update aus der Quelle des Geräts — am WSUS also nur,
          was dort freigegeben ist. Neu gestartet wird nie; das Gerät meldet danach „Neustart
          ausstehend".
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-5 text-sm">
        <fieldset class="space-y-2">
          <legend class="mb-1 font-medium">Umfang</legend>
          <template v-if="selectedCount > 0">
            <label class="flex items-center gap-2">
              <input v-model="scope" type="radio" name="scope" value="selected" class="accent-primary" />
              Ausgewählte Updates ({{ selectedCount }})
            </label>
            <label class="flex items-center gap-2">
              <input v-model="scope" type="radio" name="scope" value="types" class="accent-primary" />
              Nach Update-Typ
            </label>
          </template>

          <!-- Alle Typen stehen da, auch ohne Treffer: So springt die Liste
               nicht, und die Zahlen zeigen, was tatsächlich offen ist. -->
          <div v-if="scope === 'types'" class="rounded-md border">
            <label class="flex items-center gap-2 border-b px-3 py-2 font-medium">
              <Checkbox :model-value="allTypesState" @update:model-value="toggleAllTypes($event === true)" />
              Alle Typen
            </label>
            <div class="grid gap-x-4 px-3 py-1.5 sm:grid-cols-2">
              <label
                v-for="row in rows"
                :key="row.classification"
                class="flex items-center gap-2 py-1"
              >
                <Checkbox
                  :model-value="types.has(row.classification)"
                  @update:model-value="toggleType(row.classification, $event === true)"
                />
                <span class="flex-1 truncate" :class="row.updates === 0 ? 'text-muted-foreground' : ''">
                  {{ UPDATE_CLASSIFICATION_LABELS[row.classification] }}
                </span>
                <span class="text-muted-foreground tabular shrink-0 text-xs">{{ countLabel(row) }}</span>
              </label>
            </div>
          </div>
          <p v-if="scope === 'types' && types.has('upgrades')" class="text-muted-foreground text-xs">
            Upgrades heben Windows auf eine neue Version. Sie sind gross und dauern lange.
          </p>
        </fieldset>

        <fieldset class="space-y-2">
          <legend class="mb-1 font-medium">Zeitpunkt</legend>
          <label class="flex items-center gap-2">
            <input v-model="timing" type="radio" name="timing" value="now" class="accent-primary" />
            Beim nächsten Check-in
          </label>
          <label class="flex flex-wrap items-center gap-2">
            <input v-model="timing" type="radio" name="timing" value="later" class="accent-primary" />
            Ab
            <Input
              v-model="notBeforeLocal"
              type="datetime-local"
              class="w-56"
              :disabled="timing !== 'later'"
              aria-label="Zeitpunkt"
            />
          </label>
        </fieldset>

        <div v-if="multiple" class="space-y-1.5">
          <Label for="spread">Start verteilen über … Minuten</Label>
          <Input id="spread" v-model.number="spreadMinutes" type="number" min="0" max="240" class="w-32" />
          <p class="text-muted-foreground text-xs">
            Jedes Gerät beginnt zufällig innerhalb dieser Spanne, damit nicht alle gleichzeitig
            herunterladen. 0 heisst: alle zur selben Zeit.
          </p>
        </div>

        <p class="text-muted-foreground text-xs">
          Ausgeführt von Agents ab 0.7.0; ältere werden übergangen.
          <template v-if="expiryDays">
            Holt ein Gerät den Auftrag nicht innerhalb von {{ expiryDays }} Tagen ab, verfällt er.
          </template>
        </p>

        <Alert v-if="error" variant="destructive">
          <AlertDescription>{{ error }}</AlertDescription>
        </Alert>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="close">Abbrechen</Button>
        <Button :disabled="busy || !canSubmit" @click="submit">
          <Loader2 v-if="busy" class="size-4 animate-spin" />
          Aufträge anlegen
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
