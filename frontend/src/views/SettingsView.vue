<script setup lang="ts">
import Button from 'primevue/button';
import Card from 'primevue/card';
import InputNumber from 'primevue/inputnumber';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Password from 'primevue/password';
import Select from 'primevue/select';
import Tag from 'primevue/tag';
import ToggleSwitch from 'primevue/toggleswitch';
import Tree from 'primevue/tree';
import Checkbox from 'primevue/checkbox';
import { computed, onMounted, reactive, ref, watch, type Ref } from 'vue';
import { get, post, put } from '@/api/client';
import type {
  AdProbeResult,
  AdSettingsView,
  AgentSettingsView,
  AuthSettings,
  OrganizationalUnit,
  RetentionResult,
  RetentionSettings,
  SettingsView,
  ThresholdSettings,
} from '@/api/types';
import {
  adjustPortForScheme,
  buildLdapUrl,
  LDAPS_PORT,
  parseLdapUrl,
  type LdapUrlParts,
} from '@/ldap-url';

const loading = ref(true);
const error = ref<string | null>(null);
const saved = ref<string | null>(null);

const ad = reactive<AdSettingsView>({
  url: '',
  baseDn: '',
  searchBases: [],
  effectiveSearchBases: [],
  caCertificate: '',
  bindDn: '',
  bindPasswordSet: false,
  filterMode: 'guided',
  excludeDisabled: true,
  excludeServers: false,
  filter: '',
  effectiveFilter: '',
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

const agent = reactive<AgentSettingsView>({ enrollmentToken: '' });
const rotating = ref(false);
const copied = ref(false);

/** Die Adresse, unter der das Frontend erreichbar ist, ist auch die des Backends. */
const backendUrl = window.location.origin;

/** Die Adresse getrennt nach Host, Port und TLS — siehe ldap-url.ts. */
const url = reactive<LdapUrlParts>({ host: '', port: LDAPS_PORT, secure: true });

const probe = ref<AdProbeResult | null>(null);
const probing = ref(false);
const loadingOus = ref(false);

interface OuNode {
  key: string;
  label: string;
  children: OuNode[];
}

const ouTree = ref<OuNode[]>([]);

/** Von PrimeVue erwartetes Format: Schlüssel → `{ checked, partialChecked }`. */
const selectedOus = ref<Record<string, { checked: boolean; partialChecked: boolean }>>({});

/**
 * Baut aus der flachen Liste der DNs einen Baum.
 *
 * Der übergeordnete Knoten eines DN ist alles nach dem ersten Komma. Einträge,
 * deren Elternteil nicht in der Liste steht — etwa weil ein Container
 * dazwischen kein OU ist —, hängen an der Wurzel, statt verlorenzugehen.
 */
function buildOuTree(units: OrganizationalUnit[]): OuNode[] {
  const nodes = new Map<string, OuNode>();

  for (const unit of units) {
    nodes.set(unit.dn, { key: unit.dn, label: unit.depth === 0 ? unit.dn : unit.name, children: [] });
  }

  const roots: OuNode[] = [];

  for (const unit of units) {
    const node = nodes.get(unit.dn)!;
    const parentDn = unit.dn.slice(unit.dn.indexOf(',') + 1);
    const parent = unit.dn.includes(',') ? nodes.get(parentDn) : undefined;

    if (parent && parent !== node) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

/**
 * Nur die obersten angekreuzten Knoten. PrimeVue markiert beim Ankreuzen eines
 * Elternteils sämtliche Kinder mit; die Suche läuft ohnehin über den gesamten
 * Unterbaum, alles Untergeordnete wäre also nur Ballast in der Konfiguration.
 */
function collectSelectedBases(): string[] {
  const checked = Object.entries(selectedOus.value)
    .filter(([, state]) => state.checked)
    .map(([key]) => key);

  return checked.filter(
    (candidate) =>
      !checked.some(
        (other) => other !== candidate && candidate.toLowerCase().endsWith(`,${other.toLowerCase()}`),
      ),
  );
}

/** Nur fuer die Anzeige — die Abfrage selbst nimmt collectSelectedBases(). */
const selectedBases = computed(() =>
  Object.entries(selectedOus.value)
    .filter(([, state]) => state.checked)
    .map(([key]) => key),
);

function applySelection(bases: string[]): void {
  selectedOus.value = Object.fromEntries(
    bases.map((base) => [base, { checked: true, partialChecked: false }]),
  );
}

/** Lädt das Zertifikat aus einer Datei ins Textfeld. */
async function onCertificateFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) {
    return;
  }

  const text = await file.text();

  if (!text.includes('-----BEGIN CERTIFICATE-----')) {
    error.value =
      'Die Datei ist kein PEM-Zertifikat. Eine DER-kodierte .cer-Datei lässt sich mit ' +
      '"certutil -encode" umwandeln.';
    input.value = '';
    return;
  }

  ad.caCertificate = text.trim();
  error.value = null;
  input.value = '';
}
const customFilter = ref(false);
const filterText = ref('');

function onSchemeChange(secure: boolean): void {
  url.port = adjustPortForScheme({ ...url, secure: !secure }, secure);
}

function onFilterModeChange(custom: boolean): void {
  ad.filterMode = custom ? 'custom' : 'guided';

  if (custom) {
    // Den zusammengesetzten Ausdruck als Ausgangspunkt übernehmen, statt ein
    // leeres Feld zu hinterlassen.
    ad.filter = filterText.value;
  }
}

/** Die aktuell zusammengesetzte Fassung, solange nicht von Hand geschrieben. */
watch(
  () => [ad.filterMode, ad.excludeDisabled, ad.excludeServers, ad.filter] as const,
  () => {
    if (ad.filterMode === 'custom') {
      filterText.value = ad.filter;
      return;
    }

    const clauses = ['(objectClass=computer)'];
    if (ad.excludeDisabled) {
      clauses.push('(!(userAccountControl:1.2.840.113556.1.4.803:=2))');
    }
    if (ad.excludeServers) {
      clauses.push('(!(operatingSystem=*Server*))');
    }
    filterText.value = clauses.length === 1 ? clauses[0] : `(&${clauses.join('')})`;
  },
  { immediate: true },
);

/** Die noch nicht gespeicherten Werte, wie sie das Backend zum Prüfen braucht. */
function currentAdPayload(): Record<string, unknown> {
  return {
    url: buildLdapUrl(url),
    baseDn: ad.baseDn,
    searchBases: collectSelectedBases(),
    caCertificate: ad.caCertificate,
    bindDn: ad.bindDn,
    ...(bindPassword.value ? { bindPassword: bindPassword.value } : {}),
    filterMode: ad.filterMode,
    excludeDisabled: ad.excludeDisabled,
    excludeServers: ad.excludeServers,
    filter: ad.filterMode === 'custom' ? filterText.value : ad.filter,
    pageSize: ad.pageSize,
    intervalMinutes: ad.intervalMinutes,
    startupDelaySeconds: ad.startupDelaySeconds,
    tlsRejectUnauthorized: ad.tlsRejectUnauthorized,
    timeoutSeconds: ad.timeoutSeconds,
  };
}

async function runProbe(): Promise<void> {
  probing.value = true;
  error.value = null;
  saved.value = null;

  try {
    probe.value = await post<AdProbeResult>('/api/ad/probe', currentAdPayload());

    if (probe.value.defaultNamingContext) {
      // Die Domänenwurzel ist der Ausgangspunkt fürs Durchsuchen — und der
      // Rückfallwert, solange keine Bereiche angekreuzt sind.
      ad.baseDn = probe.value.defaultNamingContext;
      await loadOrganizationalUnits();
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Die Prüfung ist fehlgeschlagen.';
  } finally {
    probing.value = false;
  }
}

async function loadOrganizationalUnits(): Promise<void> {
  loadingOus.value = true;

  try {
    const units = await post<OrganizationalUnit[]>('/api/ad/organizational-units', {
      ...currentAdPayload(),
      base: probe.value?.defaultNamingContext,
    });

    ouTree.value = buildOuTree(units);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Die Organisationseinheiten konnten nicht gelesen werden.';
  } finally {
    loadingOus.value = false;
  }
}

const authSettings = reactive<AuthSettings>({
  provider: 'local',
  userDnTemplate: '{username}',
  allowLocalFallback: true,
});

const savingAd = ref(false);
const savingAuth = ref(false);
const savingThresholds = ref(false);
const savingRetention = ref(false);
const cleaning = ref(false);

async function copyToken(): Promise<void> {
  try {
    await navigator.clipboard.writeText(agent.enrollmentToken);
    copied.value = true;
  } catch {
    // Die Zwischenablage ist ohne HTTPS je nach Browser gesperrt. Kein Grund
    // fuer eine Fehlermeldung — das Feld laesst sich von Hand markieren.
    copied.value = false;
  }
}

async function rotateToken(): Promise<void> {
  rotating.value = true;
  error.value = null;
  saved.value = null;

  try {
    const result = await put<AgentSettingsView>('/api/settings/agent/enrollment-token', {});
    Object.assign(agent, result);
    saved.value = 'Neues Enrollment-Token erzeugt. Bereits registrierte Geräte sind nicht betroffen.';
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Das Token konnte nicht erneuert werden.';
  } finally {
    rotating.value = false;
  }
}

async function load(): Promise<void> {
  error.value = null;
  try {
    const settings = await get<SettingsView>('/api/settings');
    Object.assign(agent, settings.agent);
    Object.assign(ad, settings.ad);
    Object.assign(url, parseLdapUrl(settings.ad.url));
    applySelection(settings.ad.searchBases);
    customFilter.value = settings.ad.filterMode === 'custom';
    filterText.value = settings.ad.effectiveFilter;
    Object.assign(authSettings, settings.auth);
    dnMode.value = detectDnMode(settings.auth.userDnTemplate);
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
  section: 'ad' | 'auth' | 'thresholds' | 'retention',
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
  void save('ad', savingAd, currentAdPayload());
}

function saveThresholds(): void {
  void save('thresholds', savingThresholds, { ...thresholds });
}

function saveRetention(): void {
  void save('retention', savingRetention, { ...retention });
}

/**
 * Die drei Formen, die ein Active Directory beim Bind akzeptiert. Statt eine
 * Vorlage zu tippen, wählt man die Form — der Domänenname kommt aus der
 * Verbindungsprüfung.
 */
type DnMode = 'upn' | 'netbios' | 'custom';

const dnMode = ref<DnMode>('upn');

const dnModeOptions = computed(() => {
  const dns = probe.value?.domainDnsName ?? 'firma.local';
  const netbios = probe.value?.domainNetbiosName ?? 'FIRMA';

  return [
    { value: 'upn', label: `Benutzerprinzipalname (benutzer@${dns})` },
    { value: 'netbios', label: `Vorangestellte Domäne (${netbios}\\benutzer)` },
    { value: 'custom', label: 'Eigene Vorlage' },
  ];
});

function applyDnMode(mode: DnMode): void {
  if (mode === 'upn') {
    authSettings.userDnTemplate = `{username}@${probe.value?.domainDnsName ?? 'firma.local'}`;
  } else if (mode === 'netbios') {
    authSettings.userDnTemplate = `${probe.value?.domainNetbiosName ?? 'FIRMA'}\\{username}`;
  }
}

/** Aus einer gespeicherten Vorlage die passende Form erkennen. */
function detectDnMode(template: string): DnMode {
  if (/^\{username\}@.+/.test(template)) return 'upn';
  if (/^[^\\]+\\\{username\}$/.test(template)) return 'netbios';
  return 'custom';
}

function saveAuth(): void {
  void save('auth', savingAuth, { ...authSettings });
}

async function runRetention(): Promise<void> {
  cleaning.value = true;
  error.value = null;
  saved.value = null;

  try {
    const result = await post<RetentionResult>('/api/maintenance/retention');
    saved.value =
      `${result.eventsDeleted} Ereignisse und ${result.checkinsDeleted} Check-ins entfernt ` +
      `(älter als ${result.eventDays} bzw. ${result.checkinDays} Tage).`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Das Aufräumen ist fehlgeschlagen.';
  } finally {
    cleaning.value = false;
  }
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
      <template #title>Agent-Registrierung</template>
      <template #subtitle>
        Dieses Token legt ein Agent beim erstmaligen Start vor. Danach arbeitet jedes Gerät mit
        einem eigenen, serverseitig erzeugten Secret.
      </template>

      <template #content>
        <div class="field" style="max-width: 40rem">
          <label for="token">Enrollment-Token</label>
          <div style="display: flex; gap: 0.5rem">
            <InputText id="token" :value="agent.enrollmentToken" readonly fluid />
            <Button
              icon="pi pi-copy"
              severity="secondary"
              :title="copied ? 'Kopiert' : 'In die Zwischenablage kopieren'"
              @click="copyToken"
            />
          </div>
          <small class="muted">
            Ein neues Token betrifft nur Neuinstallationen — bereits registrierte Geräte laufen
            unverändert weiter. Rotieren ist deshalb billig.
          </small>
        </div>

        <Message severity="secondary" :closable="false" style="margin-top: 0.5rem">
          <div style="font-family: monospace; font-size: 0.85rem; overflow-x: auto">
            wiupmo-agent.exe --install --backend-url {{ backendUrl }} --enrollment-token
            {{ agent.enrollmentToken }}
          </div>
        </Message>
      </template>

      <template #footer>
        <Button
          label="Neues Token erzeugen"
          icon="pi pi-refresh"
          severity="secondary"
          :loading="rotating"
          @click="rotateToken"
        />
      </template>
    </Card>

    <Card v-if="!loading" style="margin-bottom: 1rem">
      <template #title>Active Directory</template>
      <template #subtitle>
        Ohne Server und Suchwurzel bleibt der Abgleich aus. Änderungen wirken sofort, ein
        Neustart ist nicht nötig.
      </template>

      <template #content>
        <!--
          Zwei Spalten: Verbindung links, Auswahl rechts. Der Ablauf ist von
          links nach rechts — erst steht die Verbindung, dann sieht man, was
          sie hergibt. Untereinander war die Karte so hoch, dass die
          Verbindungsprüfung beim Wählen der Bereiche nicht mehr sichtbar war.
        -->
        <div class="ad-columns">
          <section>
        <h3 class="section">1 · Verbindung</h3>

        <div class="settings-grid one-column">
          <div class="field">
            <label for="ad-host">Domänencontroller</label>
            <InputText id="ad-host" v-model="url.host" placeholder="dc01.firma.local" />
            <small class="muted">Nur der Name, ohne Schema und Port.</small>
          </div>

          <div class="field">
            <label for="ad-secure">Verschlüsselt (LDAPS)</label>
            <ToggleSwitch id="ad-secure" v-model="url.secure" @update:model-value="onSchemeChange" />
            <small class="muted">
              Ohne LDAPS geht das Passwort des Dienstkontos im Klartext durchs Netz.
            </small>
          </div>

          <div class="field">
            <label for="ad-port">Port</label>
            <InputNumber id="ad-port" v-model="url.port" :min="1" :max="65535" :use-grouping="false" />
          </div>

          <div class="field">
            <label for="ad-bind">Dienstkonto</label>
            <InputText
              id="ad-bind"
              v-model="ad.bindDn"
              :placeholder="probe?.domainDnsName ? `wiupmo@${probe.domainDnsName}` : 'wiupmo@firma.local'"
            />
            <small class="muted">
              Als <code>konto@domäne</code> oder <code>DOMÄNE\konto</code> — ein vollständiger DN ist
              nicht nötig. Leserecht auf die Computerobjekte genügt.
            </small>
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
        </div>

        <h4 class="subsection">Zertifikat des Domänencontrollers</h4>

        <div class="field">
          <div style="display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap">
            <label
              class="p-button p-button-secondary p-button-outlined p-button-sm"
              style="cursor: pointer; margin: 0"
            >
              <span class="pi pi-upload" style="margin-right: 0.4rem" />
              CA-Zertifikat wählen
              <input type="file" accept=".pem,.crt,.cer" hidden @change="onCertificateFile" />
            </label>

            <Tag
              v-if="ad.caCertificate"
              value="hinterlegt"
              severity="success"
              icon="pi pi-shield"
            />
            <Button
              v-if="ad.caCertificate"
              label="Entfernen"
              severity="danger"
              text
              size="small"
              @click="ad.caCertificate = ''"
            />

            <div v-if="!ad.caCertificate" style="display: flex; align-items: center; gap: 0.5rem">
              <ToggleSwitch id="ad-tls" v-model="ad.tlsRejectUnauthorized" />
              <label for="ad-tls">Zertifikat prüfen</label>
            </div>
          </div>

          <small class="muted">
            <template v-if="ad.caCertificate">
              Die Gegenstelle wird gegen dieses Zertifikat geprüft. Das ist der richtige Weg bei
              einer internen PKI — im Gegensatz zum Abschalten der Prüfung fällt ein
              untergeschobener Server weiterhin auf.
            </template>
            <template v-else>
              Bei einem selbstsignierten oder intern ausgestellten Zertifikat hier das Zertifikat
              der ausstellenden Stelle hinterlegen (PEM). Nur wenn das nicht möglich ist, die
              Prüfung abschalten — dann ist die Verbindung zwar verschlüsselt, aber nicht mehr
              gegen einen untergeschobenen Server geschützt.
            </template>
          </small>
        </div>

        <Button
          label="Verbindung prüfen"
          icon="pi pi-link"
          severity="secondary"
          :loading="probing"
          :disabled="!url.host"
          @click="runProbe"
        />

        <Message
          v-if="probe"
          :severity="probe.ok ? 'success' : 'error'"
          :closable="false"
          style="margin-top: 0.75rem"
        >
          <div>{{ probe.message }}</div>
          <div v-if="probe.dnsHostName" class="muted" style="font-size: 0.8rem; margin-top: 0.25rem">
            {{ probe.dnsHostName }} · Domäne {{ probe.domainDnsName }}
            <template v-if="probe.domainNetbiosName">({{ probe.domainNetbiosName }})</template>
          </div>
        </Message>
          </section>

          <section>
        <h3 class="section">2 · Was abgeglichen wird</h3>

        <div class="field">
          <label>Bereiche im Verzeichnis</label>

          <Tree
            v-if="ouTree.length > 0"
            v-model:selection-keys="selectedOus"
            :value="ouTree"
            selection-mode="checkbox"
            :loading="loadingOus"
            filter
            filter-mode="lenient"
            filter-placeholder="Suchen"
            class="ou-tree"
          />

          <Message v-else severity="secondary" :closable="false">
            Nach erfolgreicher Verbindungsprüfung erscheint hier die Struktur des Verzeichnisses
            zum Ankreuzen.
          </Message>

          <small class="muted">
            Mehrere Bereiche sind möglich; jeder wird samt allem darunter abgeglichen.
            <template v-if="selectedBases.length === 0">
              Ohne Auswahl wird die gesamte Domäne abgeglichen.
            </template>
            <template v-else>
              Gewählt: {{ selectedBases.length }} Bereich(e).
            </template>
          </small>
        </div>

        <div class="settings-grid">
          <div class="field" style="grid-column: 1 / -1">
            <label>Auswahl der Konten</label>
            <div style="display: flex; flex-wrap: wrap; gap: 1rem; align-items: center">
              <div style="display: flex; gap: 0.5rem; align-items: center">
                <Checkbox
                  v-model="ad.excludeDisabled"
                  input-id="excl-disabled"
                  binary
                  :disabled="ad.filterMode === 'custom'"
                />
                <label for="excl-disabled">Deaktivierte Konten überspringen</label>
              </div>

              <div style="display: flex; gap: 0.5rem; align-items: center">
                <Checkbox
                  v-model="ad.excludeServers"
                  input-id="excl-servers"
                  binary
                  :disabled="ad.filterMode === 'custom'"
                />
                <label for="excl-servers">Server überspringen</label>
              </div>

              <div style="display: flex; gap: 0.5rem; align-items: center">
                <Checkbox v-model="customFilter" input-id="custom-filter" binary @update:model-value="onFilterModeChange" />
                <label for="custom-filter">Eigener LDAP-Filter</label>
              </div>
            </div>
          </div>

          <div class="field" style="grid-column: 1 / -1">
            <label for="ad-filter">Wirksamer Filter</label>
            <InputText
              id="ad-filter"
              v-model="filterText"
              :readonly="ad.filterMode !== 'custom'"
              :class="ad.filterMode !== 'custom' ? 'readonly-field' : ''"
            />
            <small class="muted">
              <template v-if="ad.filterMode === 'custom'">
                Eigener Ausdruck. Die Verbindungsprüfung zeigt, wie viele Konten er trifft.
              </template>
              <template v-else>
                Aus den Ankreuzfeldern zusammengesetzt — hier nur zur Ansicht.
              </template>
            </small>
          </div>
        </div>

          </section>
        </div>

        <h3 class="section">3 · Ablauf</h3>

        <div class="settings-grid">
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

    <Card v-if="!loading" style="margin-bottom: 1rem">
      <template #title>Anmeldung</template>
      <template #subtitle>
        Lokale Benutzer oder ein Bind gegen das Verzeichnis. Die Verbindungsdaten kommen aus der
        AD-Konfiguration oben — gebunden wird aber mit den Zugangsdaten des jeweiligen Benutzers,
        nicht mit dem Dienstkonto.
      </template>

      <template #content>
        <div class="settings-grid">
          <div class="field">
            <label for="provider">Anmeldeweg</label>
            <Select
              id="provider"
              v-model="authSettings.provider"
              :options="[
                { value: 'local', label: 'Lokale Benutzer' },
                { value: 'ldap', label: 'LDAP-Bind gegen das Verzeichnis' },
              ]"
              option-label="label"
              option-value="value"
            />
          </div>

          <div class="field">
            <label for="dn-mode">Namensform bei der Anmeldung</label>
            <Select
              id="dn-mode"
              v-model="dnMode"
              :options="dnModeOptions"
              option-label="label"
              option-value="value"
              @update:model-value="applyDnMode"
            />
            <small class="muted">
              <template v-if="dnMode === 'custom'">Eigene Vorlage, muss <code>{username}</code> enthalten.</template>
              <template v-else>Ergibt: <code>{{ authSettings.userDnTemplate }}</code></template>
            </small>
          </div>

          <div v-if="dnMode === 'custom'" class="field">
            <label for="dn">Vorlage</label>
            <InputText id="dn" v-model="authSettings.userDnTemplate" />
          </div>

          <div class="field">
            <label for="fallback">Lokale Anmeldung weiterhin zulassen</label>
            <ToggleSwitch id="fallback" v-model="authSettings.allowLocalFallback" />
            <small class="muted">
              Dringend empfohlen. Ohne diesen Weg sperrt ein ausgefallener Domänencontroller oder
              eine falsche Vorlage jeden aus — genau dann, wenn man hineinsehen will.
            </small>
          </div>
        </div>

        <Message
          v-if="authSettings.provider === 'ldap' && !ad.configured"
          severity="warn"
          :closable="false"
          style="margin-top: 0.5rem"
        >
          Es ist kein Verzeichnis konfiguriert. Die LDAP-Anmeldung kann so nicht funktionieren.
        </Message>
      </template>

      <template #footer>
        <Button label="Speichern" :loading="savingAuth" @click="saveAuth" />
      </template>
    </Card>

    <Card v-if="!loading">
      <template #title>Aufbewahrung</template>
      <template #subtitle>
        Ein Job räumt nachts um 03:15 auf: Ereignisse und Check-ins, die älter sind als die
        Fristen. Die aktuellen Update-Zustände bleiben unberührt.
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
        <div style="display: flex; gap: 0.5rem; align-items: center">
          <Button label="Speichern" :loading="savingRetention" @click="saveRetention" />
          <Button
            label="Jetzt aufräumen"
            icon="pi pi-trash"
            severity="secondary"
            outlined
            :loading="cleaning"
            @click="runRetention"
          />
          <small class="muted">
            Löscht endgültig. Sinnvoll, um zu sehen, was eine geänderte Frist tatsächlich trifft.
          </small>
        </div>
      </template>
    </Card>
  </div>
</template>

<style scoped>
.section {
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--p-text-muted-color);
  margin: 1.25rem 0 0.5rem;
}

.section:first-child {
  margin-top: 0;
}

/* Der zusammengesetzte Filter ist Anzeige, kein Eingabefeld — das soll man
   sehen, bevor man hineinklickt. */
.readonly-field {
  background: var(--p-content-hover-background);
  font-family: monospace;
  font-size: 0.85rem;
}

.subsection {
  font-size: 0.8rem;
  font-weight: 600;
  margin: 0.75rem 0 0.5rem;
}

.settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
  gap: 0 1.5rem;
}

/* Innerhalb einer Spalte bleibt es einspaltig — sonst waeren die Felder
   schmaler als ihre Beschriftungen. */
.settings-grid.one-column {
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
}

.ad-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 2rem;
  align-items: start;
}

/* Unterhalb dieser Breite stehen die Spalten wieder untereinander; zwei
   halbe Spalten waeren dann schmaler als die Eingabefelder brauchen. */
@media (max-width: 72rem) {
  .ad-columns {
    grid-template-columns: 1fr;
  }
}

/* Begrenzte Hoehe mit eigenem Rollbereich: Ein Verzeichnis mit hundert
   Einheiten wuerde die Seite sonst unbenutzbar lang machen. */
.ou-tree {
  max-height: 22rem;
  overflow: auto;
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-content-border-radius);
}
</style>
