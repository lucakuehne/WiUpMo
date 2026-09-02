<script setup lang="ts">
import Button from 'primevue/button';
import Card from 'primevue/card';
import InputNumber from 'primevue/inputnumber';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Password from 'primevue/password';
import ToggleSwitch from 'primevue/toggleswitch';
import { onMounted, reactive, ref, type Ref } from 'vue';
import { get, put } from '@/api/client';
import type {
  AdSettingsView,
  RetentionSettings,
  SettingsView,
  ThresholdSettings,
} from '@/api/types';

const loading = ref(true);
const error = ref<string | null>(null);
const saved = ref<string | null>(null);

const ad = reactive<AdSettingsView>({
  url: '',
  baseDn: '',
  bindDn: '',
  bindPasswordSet: false,
  filter: '',
  pageSize: 500,
  intervalMinutes: 360,
  startupDelaySeconds: 60,
  tlsRejectUnauthorized: true,
  timeoutSeconds: 60,
  configured: false,
});

/**
 * Getrennt vom übrigen Zustand: Das Backend liefert das Passwort nie aus.
 * Leer bedeutet beim Speichern „unverändert" — sonst müsste man es bei jeder
 * Änderung an einem anderen Feld erneut eintippen.
 */
const bindPassword = ref('');

const thresholds = reactive<ThresholdSettings>({
  staleAgentDays: 14,
  criticalOpenDays: 30,
  pendingRebootDays: 7,
});

const retention = reactive<RetentionSettings>({
  eventDays: 90,
  checkinDays: 90,
});

const savingAd = ref(false);
const savingThresholds = ref(false);
const savingRetention = ref(false);

async function load(): Promise<void> {
  error.value = null;
  try {
    const settings = await get<SettingsView>('/api/settings');
    Object.assign(ad, settings.ad);
    Object.assign(thresholds, settings.thresholds);
    Object.assign(retention, settings.retention);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Die Einstellungen konnten nicht geladen werden.';
  } finally {
    loading.value = false;
  }
}

// Die Speicherfunktionen bleiben im Skriptteil, statt den Ref aus der Vorlage
// heraus zu uebergeben: dort werden Refs automatisch entpackt, es kaeme also
// ein boolean statt des Ref an.
async function save(
  section: 'ad' | 'thresholds' | 'retention',
  busy: Ref<boolean>,
  payload: unknown,
): Promise<void> {
  busy.value = true;
  error.value = null;
  saved.value = null;

  try {
    const result = await put<unknown>(`/api/settings/${section}`, payload);

    if (section === 'ad') {
      Object.assign(ad, result as AdSettingsView);
      bindPassword.value = '';
    }

    saved.value = 'Gespeichert.';
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Speichern fehlgeschlagen.';
  } finally {
    busy.value = false;
  }
}

function saveAd(): void {
  void save('ad', savingAd, {
    url: ad.url,
    baseDn: ad.baseDn,
    bindDn: ad.bindDn,
    // Nur mitschicken, wenn tatsächlich etwas eingegeben wurde.
    ...(bindPassword.value ? { bindPassword: bindPassword.value } : {}),
    filter: ad.filter,
    pageSize: ad.pageSize,
    intervalMinutes: ad.intervalMinutes,
    startupDelaySeconds: ad.startupDelaySeconds,
    tlsRejectUnauthorized: ad.tlsRejectUnauthorized,
    timeoutSeconds: ad.timeoutSeconds,
  });
}

function saveThresholds(): void {
  void save('thresholds', savingThresholds, { ...thresholds });
}

function saveRetention(): void {
  void save('retention', savingRetention, { ...retention });
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h1>Einstellungen</h1>
    </div>

    <Message v-if="error" severity="error" :closable="false" style="margin-bottom: 1rem">
      {{ error }}
    </Message>

    <Message v-if="saved" severity="success" :closable="false" style="margin-bottom: 1rem">
      {{ saved }}
    </Message>

    <Card v-if="!loading" style="margin-bottom: 1rem">
      <template #title>Active Directory</template>
      <template #subtitle>
        Ohne Server und Suchwurzel bleibt der Abgleich aus. Änderungen wirken sofort, ein
        Neustart ist nicht nötig.
      </template>

      <template #content>
        <div class="settings-grid">
          <div class="field">
            <label for="ad-url">Server</label>
            <InputText id="ad-url" v-model="ad.url" placeholder="ldaps://dc01.firma.local:636" />
            <small class="muted">
              <code>ldaps://</code> bevorzugen — über <code>ldap://</code> geht das Passwort des
              Dienstkontos im Klartext durchs Netz.
            </small>
          </div>

          <div class="field">
            <label for="ad-base">Suchwurzel</label>
            <InputText
              id="ad-base"
              v-model="ad.baseDn"
              placeholder="OU=Computer,DC=firma,DC=local"
            />
          </div>

          <div class="field">
            <label for="ad-bind">Dienstkonto</label>
            <InputText id="ad-bind" v-model="ad.bindDn" placeholder="CN=wiupmo,OU=Dienste,DC=…" />
            <small class="muted">Leserecht auf die Computerobjekte genügt.</small>
          </div>

          <div class="field">
            <label for="ad-password">Passwort</label>
            <Password
              id="ad-password"
              v-model="bindPassword"
              :feedback="false"
              toggle-mask
              fluid
              :placeholder="ad.bindPasswordSet ? 'gesetzt — leer lassen für unverändert' : 'nicht gesetzt'"
            />
          </div>

          <div class="field" style="grid-column: 1 / -1">
            <label for="ad-filter">LDAP-Filter</label>
            <InputText id="ad-filter" v-model="ad.filter" />
            <small class="muted">
              Deaktivierte Konten ausschliessen mit
              <code>(&amp;(objectClass=computer)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))</code>
            </small>
          </div>

          <div class="field">
            <label for="ad-interval">Intervall (Minuten)</label>
            <InputNumber id="ad-interval" v-model="ad.intervalMinutes" :min="5" :max="10080" show-buttons />
          </div>

          <div class="field">
            <label for="ad-page">Seitengrösse</label>
            <InputNumber id="ad-page" v-model="ad.pageSize" :min="1" :max="5000" show-buttons />
            <small class="muted">AD liefert ohne Paging höchstens 1000 Einträge.</small>
          </div>

          <div class="field">
            <label for="ad-timeout">Zeitlimit (Sekunden)</label>
            <InputNumber id="ad-timeout" v-model="ad.timeoutSeconds" :min="5" :max="600" show-buttons />
          </div>

          <div class="field">
            <label for="ad-tls">Zertifikat prüfen</label>
            <ToggleSwitch id="ad-tls" v-model="ad.tlsRejectUnauthorized" />
            <small class="muted">
              Ausschalten nur bei einem selbstsignierten Zertifikat des Domänencontrollers.
            </small>
          </div>
        </div>
      </template>

      <template #footer>
        <Button label="Speichern" :loading="savingAd" @click="saveAd" />
      </template>
    </Card>

    <Card v-if="!loading" style="margin-bottom: 1rem">
      <template #title>Schwellwerte</template>
      <template #subtitle>Ab wann ein Zustand in den Auswertungen auffällig wird.</template>

      <template #content>
        <div class="settings-grid">
          <div class="field">
            <label for="t-stale">Kein Check-in seit (Tage)</label>
            <InputNumber id="t-stale" v-model="thresholds.staleAgentDays" :min="1" :max="365" show-buttons />
            <small class="muted">Unterscheidet „gepatcht" von „meldet sich nicht mehr".</small>
          </div>

          <div class="field">
            <label for="t-critical">Kritisch offen seit (Tage)</label>
            <InputNumber id="t-critical" v-model="thresholds.criticalOpenDays" :min="1" :max="365" show-buttons />
          </div>

          <div class="field">
            <label for="t-reboot">Neustart ausstehend seit (Tage)</label>
            <InputNumber id="t-reboot" v-model="thresholds.pendingRebootDays" :min="1" :max="365" show-buttons />
          </div>
        </div>
      </template>

      <template #footer>
        <Button label="Speichern" :loading="savingThresholds" @click="saveThresholds" />
      </template>
    </Card>

    <Card v-if="!loading">
      <template #title>Aufbewahrung</template>
      <template #subtitle>
        Der nächtliche Aufräumjob folgt in Phase 7. Bis dahin sind das die Werte, mit denen er
        später arbeiten wird.
      </template>

      <template #content>
        <div class="settings-grid">
          <div class="field">
            <label for="r-events">Ereignisse (Tage)</label>
            <InputNumber id="r-events" v-model="retention.eventDays" :min="7" :max="3650" show-buttons />
            <small class="muted">
              Betrifft die Zeitreihe. Der aktuelle Update-Zustand bleibt unberührt.
            </small>
          </div>

          <div class="field">
            <label for="r-checkins">Check-ins (Tage)</label>
            <InputNumber id="r-checkins" v-model="retention.checkinDays" :min="7" :max="3650" show-buttons />
          </div>
        </div>
      </template>

      <template #footer>
        <Button label="Speichern" :loading="savingRetention" @click="saveRetention" />
      </template>
    </Card>
  </div>
</template>

<style scoped>
.settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
  gap: 0 1.5rem;
}
</style>
