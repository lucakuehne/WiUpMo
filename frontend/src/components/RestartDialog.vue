<script setup lang="ts">
import { Loader2 } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import { get, post } from '@/api/client';
import type { CreateRestartJobsResult, RestartSettings, SettingsView } from '@/api/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
import { durationLabel } from '@/format';

/**
 * Fordert einen Neustart an — für ein Gerät aus dem Gerätedetail oder für eine
 * Auswahl aus der Geräteliste.
 *
 * Ausgeführt wird erst vom Agent ab 0.9.0, und nie auf Servern; beides
 * übergeht das Backend und zählt es in der Antwort. Wie der Benutzer
 * verschieben darf, steht unter Einstellungen → Betrieb und wird hier nur
 * erklärt.
 */
const props = defineProps<{
  open: boolean;
  deviceIds: string[];
  /** Für den Titel, wenn es um ein einzelnes Gerät geht. */
  hostname?: string;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  created: [result: CreateRestartJobsResult];
}>();

const router = useRouter();

const reason = ref('');
const rules = ref<RestartSettings | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    reason.value = '';
    error.value = null;
    try {
      rules.value = (await get<SettingsView>('/api/settings')).restart;
    } catch {
      rules.value = null;
    }
  },
);

/** Die Regeln in einem Satz, wie sie der Benutzer erlebt. */
const rulesText = computed(() => {
  const r = rules.value;
  if (!r) return null;

  const choices = [
    ...r.deferralMinutes.map((minutes) => `um ${durationLabel(minutes)}`),
    ...(r.nextMorningHour === null ? [] : [`bis morgen ${String(r.nextMorningHour).padStart(2, '0')}:00 Uhr`]),
  ];
  const defer =
    r.maxDeferrals === 0 || choices.length === 0
      ? 'Verschieben ist nicht möglich'
      : `Der Benutzer kann ${r.maxDeferrals === 1 ? 'einmal' : `bis zu ${r.maxDeferrals}-mal`} verschieben (${choices.join(', ')})`;

  return (
    `${defer}; spätestens ${r.deadlineHours} Stunden nach der ersten Meldung startet das Gerät neu, ` +
    `zuletzt nach einem Countdown von ${r.countdownMinutes} Minuten.`
  );
});

async function submit(): Promise<void> {
  busy.value = true;
  error.value = null;

  try {
    const result = await post<CreateRestartJobsResult>('/api/restart-jobs', {
      deviceIds: props.deviceIds,
      reason: reason.value.trim() || undefined,
    });

    const skipped = [
      result.skipped.server > 0 ? `${result.skipped.server} Server` : '',
      result.skipped.agentTooOld > 0 ? `${result.skipped.agentTooOld} mit Agent älter als ${result.minimumAgentVersion}` : '',
      result.skipped.openJob > 0 ? `${result.skipped.openJob} mit bereits angefordertem Neustart` : '',
      result.skipped.notEligible > 0 ? `${result.skipped.notEligible} archiviert oder ohne Agent` : '',
    ].filter(Boolean);

    const requestId = result.requestId;
    if (result.created > 0 && requestId) {
      toast.success(`Neustart für ${result.created} ${result.created === 1 ? 'Gerät' : 'Geräte'} angefordert.`, {
        description: skipped.length > 0 ? `Übergangen: ${skipped.join(', ')}.` : 'Die Geräte holen den Auftrag beim nächsten Check-in ab.',
        action: {
          label: 'Anzeigen',
          onClick: () => void router.push({ name: 'restarts', query: { request: requestId } }),
        },
      });
    } else {
      toast.info('Kein Neustart angefordert.', { description: `Übergangen: ${skipped.join(', ')}.` });
    }

    emit('created', result);
    emit('update:open', false);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Der Neustart konnte nicht angefordert werden.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="(value: boolean) => emit('update:open', value)">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>
          Neustart anfordern
          <template v-if="hostname"> — {{ hostname }}</template>
          <template v-else-if="deviceIds.length > 1"> — {{ deviceIds.length }} Geräte</template>
        </DialogTitle>
        <DialogDescription>
          Ist niemand angemeldet, startet das Gerät gleich neu. Sonst erscheint beim Benutzer eine
          Meldung mit „Jetzt neu starten" und der Möglichkeit zu verschieben. Server werden nicht neu
          gestartet.
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-4 text-sm">
        <p v-if="rulesText" class="text-muted-foreground">{{ rulesText }}</p>

        <div class="space-y-1.5">
          <Label for="restart-reason">Grund (erscheint in der Meldung, optional)</Label>
          <Input
            id="restart-reason"
            v-model="reason"
            maxlength="200"
            placeholder="z. B. Updates abschliessen"
          />
        </div>

        <Alert v-if="error" variant="destructive">
          <AlertDescription>{{ error }}</AlertDescription>
        </Alert>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="emit('update:open', false)">Abbrechen</Button>
        <Button :disabled="busy || deviceIds.length === 0" @click="submit">
          <Loader2 v-if="busy" class="size-4 animate-spin" />
          Neustart anfordern
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
