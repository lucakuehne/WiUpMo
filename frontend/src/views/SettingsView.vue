<script setup lang="ts">
import { Check, Loader2, Link2, RefreshCw, Shield, Trash2, Upload } from '@lucide/vue';
import { computed, onMounted, reactive, ref, watch, type Ref } from 'vue';
import { get, post, put } from '@/api/client';
import type {
  AdGroup,
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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import GroupPicker from '@/components/GroupPicker.vue';
import OuPicker from '@/components/OuPicker.vue';
import {
  adjustPortForScheme,
  buildLdapUrl,
  LDAPS_PORT,
  parseLdapUrl,
  type LdapUrlParts,
} from '@/ldap-url';

/**
 * Die Abschnitte liegen hinter einer eigenen Navigation statt untereinander.
 * Untereinander war die Seite so lang, dass beim Wählen der AD-Bereiche die
 * Verbindungsprüfung längst aus dem Bild gescrollt war.
 */
const sections = [
  { id: 'ad', label: 'Active Directory' },
  { id: 'agent', label: 'Agent-Registrierung' },
  { id: 'auth', label: 'Anmeldung' },
  { id: 'thresholds', label: 'Schwellwerte' },
  { id: 'retention', label: 'Aufbewahrung' },
] as const;

type SectionId = (typeof sections)[number]['id'];

const active = ref<SectionId>('ad');

const loading = ref(true);
const error = ref<string | null>(null);
const saved = ref<string | null>(null);

// --- Zustand ---------------------------------------------------------------

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

const url = reactive<LdapUrlParts>({ host: '', port: LDAPS_PORT, secure: true });

const agent = reactive<AgentSettingsView>({ enrollmentToken: '' });
const authSettings = reactive<AuthSettings>({
  localEnabled: true,
  ldapEnabled: false,
  userDnTemplate: '{username}',
  allowedGroups: [],
});

/**
 * Den letzten offenen Weg darf man nicht abschalten. Das Backend weist es
 * ohnehin ab — aber ein Feld, das man anklicken kann und das dann eine
 * Fehlermeldung erzeugt, ist schlechter als eines, das gesperrt ist.
 */
const onlyRemainingWay = computed(
  () =>
    (authSettings.localEnabled && !authSettings.ldapEnabled) ||
    (!authSettings.localEnabled && authSettings.ldapEnabled),
);

const groupSearch = ref('');
const groups = ref<AdGroup[]>([]);
const loadingGroups = ref(false);

/**
 * Die gewählten Gruppen bleiben sichtbar, auch wenn die Suche sie gerade nicht
 * enthält — sonst verschwände die eigene Auswahl beim Tippen aus dem Blick.
 * Die Gliederung übernimmt der GroupPicker anhand der DNs.
 */
const groupRows = computed<AdGroup[]>(() => {
  const known = new Map(groups.value.map((group) => [group.dn, group]));

  for (const dn of authSettings.allowedGroups) {
    if (!known.has(dn)) {
      known.set(dn, { dn, name: dn.split(',')[0].replace(/^CN=/i, ''), accountName: null });
    }
  }

  return [...known.values()];
});

async function loadGroups(): Promise<void> {
  loadingGroups.value = true;
  error.value = null;

  try {
    groups.value = await post<AdGroup[]>('/api/ad/groups', {
      ...currentAdPayload(),
      search: groupSearch.value,
    });
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Die Gruppen konnten nicht gelesen werden.';
  } finally {
    loadingGroups.value = false;
  }
}

const thresholds = reactive<ThresholdSettings>({
  staleAgentDays: 14,
  criticalOpenDays: 30,
  pendingRebootDays: 7,
});
const retention = reactive<RetentionSettings>({ eventDays: 90, checkinDays: 90 });

const probe = ref<AdProbeResult | null>(null);
const probing = ref(false);
const loadingOus = ref(false);
const ouUnits = ref<OrganizationalUnit[]>([]);
const selectedBases = ref<string[]>([]);

const savingAd = ref(false);
const savingAuth = ref(false);
const savingThresholds = ref(false);
const savingRetention = ref(false);
const rotating = ref(false);
const cleaning = ref(false);

const customFilter = ref(false);
const filterText = ref('');
const backendUrl = window.location.origin;

// --- Laden und Speichern ---------------------------------------------------

async function load(): Promise<void> {
  error.value = null;

  try {
    const settings = await get<SettingsView>('/api/settings');
    Object.assign(agent, settings.agent);
    Object.assign(ad, settings.ad);
    Object.assign(url, parseLdapUrl(settings.ad.url));
    selectedBases.value = [...settings.ad.searchBases];
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

/** Die noch nicht gespeicherten Werte, wie sie Prüfung und Speichern brauchen. */
function currentAdPayload(): Record<string, unknown> {
  return {
    url: buildLdapUrl(url),
    baseDn: ad.baseDn,
    searchBases: selectedBases.value,
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

const saveAd = () => void save('ad', savingAd, currentAdPayload());
const saveAuth = () => void save('auth', savingAuth, { ...authSettings });
const saveThresholds = () => void save('thresholds', savingThresholds, { ...thresholds });
const saveRetention = () => void save('retention', savingRetention, { ...retention });

// --- Active Directory ------------------------------------------------------

/**
 * Das Protokoll als Auswahl statt als Schalter: „LDAPS" ist der Name, unter
 * dem es in jeder Anleitung und jeder Firewall-Regel steht — „verschlüsselt:
 * ja" muss man erst übersetzen.
 *
 * Der Standardport zieht beim Wechsel mit, aber nur, wenn er noch der
 * Standard war. Ein von Hand gesetzter Port bleibt stehen.
 */
const protocol = computed<'ldap' | 'ldaps'>({
  get: () => (url.secure ? 'ldaps' : 'ldap'),
  set: (value) => {
    const secure = value === 'ldaps';
    url.port = adjustPortForScheme({ ...url }, secure);
    url.secure = secure;
  },
});

/**
 * Der Wert kommt als `boolean | 'indeterminate'` — der unbestimmte Zustand
 * tritt hier nicht auf, muss aber behandelt werden.
 */
function onFilterModeChange(value: boolean | 'indeterminate'): void {
  const custom = value === true;
  customFilter.value = custom;
  ad.filterMode = custom ? 'custom' : 'guided';

  if (custom) {
    // Den zusammengesetzten Ausdruck als Ausgangspunkt übernehmen, statt ein
    // leeres Feld zu hinterlassen.
    ad.filter = filterText.value;
  }
}

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

async function runProbe(): Promise<void> {
  probing.value = true;
  error.value = null;
  saved.value = null;

  try {
    probe.value = await post<AdProbeResult>('/api/ad/probe', currentAdPayload());

    if (probe.value.defaultNamingContext) {
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
    ouUnits.value = await post<OrganizationalUnit[]>('/api/ad/organizational-units', {
      ...currentAdPayload(),
      base: probe.value?.defaultNamingContext,
    });
  } catch (e) {
    error.value =
      e instanceof Error ? e.message : 'Die Organisationseinheiten konnten nicht gelesen werden.';
  } finally {
    loadingOus.value = false;
  }
}

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

// --- Agent-Registrierung ---------------------------------------------------

const copied = ref(false);

async function copyToken(): Promise<void> {
  try {
    await navigator.clipboard.writeText(agent.enrollmentToken);
    copied.value = true;
  } catch {
    // Die Zwischenablage ist ohne HTTPS je nach Browser gesperrt. Kein Grund
    // für eine Fehlermeldung — das Feld lässt sich von Hand markieren.
    copied.value = false;
  }
}

async function rotateToken(): Promise<void> {
  rotating.value = true;
  error.value = null;
  saved.value = null;

  try {
    Object.assign(agent, await put<AgentSettingsView>('/api/settings/agent/enrollment-token', {}));
    saved.value =
      'Neues Enrollment-Token erzeugt. Bereits registrierte Geräte sind nicht betroffen.';
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Das Token konnte nicht erneuert werden.';
  } finally {
    rotating.value = false;
  }
}

// --- Anmeldung -------------------------------------------------------------

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
  dnMode.value = mode;

  if (mode === 'upn') {
    authSettings.userDnTemplate = `{username}@${probe.value?.domainDnsName ?? 'firma.local'}`;
  } else if (mode === 'netbios') {
    authSettings.userDnTemplate = `${probe.value?.domainNetbiosName ?? 'FIRMA'}\\{username}`;
  }
}

function detectDnMode(template: string): DnMode {
  if (/^\{username\}@.+/.test(template)) return 'upn';
  if (/^[^\\]+\\\{username\}$/.test(template)) return 'netbios';
  return 'custom';
}

// --- Aufbewahrung ----------------------------------------------------------

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
  <div class="mx-auto max-w-[1600px] px-5 py-6">
    <h1 class="mb-5 text-xl font-semibold">Einstellungen</h1>

    <div class="flex flex-col gap-6 lg:flex-row">
      <!-- Linke Navigation: die Abschnitte, nicht die Seite. -->
      <nav class="flex shrink-0 gap-1 overflow-x-auto lg:w-52 lg:flex-col lg:overflow-visible">
        <button
          v-for="section in sections"
          :key="section.id"
          type="button"
          class="rounded-md px-3 py-2 text-left text-sm whitespace-nowrap transition-colors"
          :class="
            active === section.id
              ? 'bg-accent text-accent-foreground font-medium'
              : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
          "
          @click="active = section.id"
        >
          {{ section.label }}
        </button>
      </nav>

      <div class="min-w-0 flex-1">
        <Alert v-if="error" variant="destructive" class="mb-4">
          <AlertDescription>{{ error }}</AlertDescription>
        </Alert>

        <Alert v-if="saved" class="mb-4 border-success/40 text-success">
          <AlertDescription>{{ saved }}</AlertDescription>
        </Alert>

        <!-- ================= Active Directory ================= -->
        <Card v-if="active === 'ad' && !loading">
          <CardHeader>
            <CardTitle>Active Directory</CardTitle>
            <CardDescription>
              Ohne Server und Bereich bleibt der Abgleich aus. Änderungen wirken sofort, ein
              Neustart ist nicht nötig.
            </CardDescription>
          </CardHeader>

          <CardContent class="space-y-6">
            <!--
              Zwei Spalten: Verbindung links, Auswahl rechts. Die Reihenfolge
              entspricht dem Vorgehen — erst steht die Verbindung, dann sieht
              man, was sie hergibt.
            -->
            <div class="grid items-start gap-8 xl:grid-cols-2">
              <section class="space-y-4">
                <h3 class="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                  1 · Verbindung
                </h3>

                <!-- Protokoll, Name und Port gehören zusammen — sie bilden
                     zusammen die Adresse und werden auch zusammen geändert. -->
                <div class="grid gap-3 sm:grid-cols-[8.5rem_1fr_6rem]">
                  <div class="space-y-1.5">
                    <Label>Protokoll</Label>
                    <Select v-model="protocol">
                      <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ldaps">LDAPS</SelectItem>
                        <SelectItem value="ldap">LDAP</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div class="space-y-1.5">
                    <Label for="ad-host">Domänencontroller</Label>
                    <Input id="ad-host" v-model="url.host" placeholder="dc01.firma.local" />
                  </div>

                  <div class="space-y-1.5">
                    <Label for="ad-port">Port</Label>
                    <Input id="ad-port" v-model.number="url.port" type="number" min="1" max="65535" />
                  </div>
                </div>

                <p class="text-muted-foreground -mt-2 text-xs">
                  Der Name ohne Schema und Port; der Standardport folgt dem Protokoll.
                  <template v-if="!url.secure">
                    <strong>Über LDAP geht das Passwort des Dienstkontos im Klartext durchs Netz.</strong>
                  </template>
                </p>

                <div class="grid gap-3 sm:grid-cols-2">
                  <div class="space-y-1.5">
                    <Label for="ad-bind">Dienstkonto</Label>
                    <Input
                      id="ad-bind"
                      v-model="ad.bindDn"
                      :placeholder="
                        probe?.domainDnsName ? `wiupmo@${probe.domainDnsName}` : 'wiupmo@firma.local'
                      "
                    />
                  </div>

                  <div class="space-y-1.5">
                    <Label for="ad-password">Passwort</Label>
                    <Input
                      id="ad-password"
                      v-model="bindPassword"
                      type="password"
                      :placeholder="
                        ad.bindPasswordSet ? 'gesetzt — leer lassen für unverändert' : 'nicht gesetzt'
                      "
                    />
                  </div>
                </div>

                <p class="text-muted-foreground -mt-2 text-xs">
                  Konto als <code>konto@domäne</code> oder <code>DOMÄNE\konto</code> — ein
                  vollständiger DN ist nicht nötig. Leserecht auf die Computerobjekte genügt.
                </p>

                <div class="space-y-2">
                  <Label>Zertifikat des Domänencontrollers</Label>

                  <div class="flex flex-wrap items-center gap-3">
                    <label
                      class="border-input hover:bg-accent inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm"
                    >
                      <Upload class="size-4" />
                      CA-Zertifikat wählen
                      <input type="file" accept=".pem,.crt,.cer" hidden @change="onCertificateFile" />
                    </label>

                    <template v-if="ad.caCertificate">
                      <Badge class="bg-success text-success-foreground gap-1">
                        <Shield class="size-3" />
                        hinterlegt
                      </Badge>
                      <Button variant="ghost" size="sm" @click="ad.caCertificate = ''">
                        <Trash2 class="size-4" />
                        Entfernen
                      </Button>
                    </template>

                    <div v-else class="flex items-center gap-2">
                      <Switch id="ad-tls" v-model="ad.tlsRejectUnauthorized" />
                      <Label for="ad-tls" class="font-normal">Zertifikat prüfen</Label>
                    </div>
                  </div>

                  <p class="text-muted-foreground text-xs">
                    <template v-if="ad.caCertificate">
                      Die Gegenstelle wird gegen dieses Zertifikat geprüft — im Gegensatz zum
                      Abschalten der Prüfung fällt ein untergeschobener Server weiterhin auf.
                    </template>
                    <template v-else>
                      Bei einem Zertifikat aus interner PKI hier das Zertifikat der ausstellenden
                      Stelle hinterlegen (PEM). Nur wenn das nicht möglich ist, die Prüfung
                      abschalten.
                    </template>
                  </p>
                </div>

                <Button variant="secondary" :disabled="!url.host || probing" @click="runProbe">
                  <Loader2 v-if="probing" class="size-4 animate-spin" />
                  <Link2 v-else class="size-4" />
                  Verbindung prüfen
                </Button>

                <Alert
                  v-if="probe"
                  :variant="probe.ok ? 'default' : 'destructive'"
                  :class="probe.ok ? 'border-success/40' : ''"
                >
                  <AlertDescription>
                    <div>{{ probe.message }}</div>
                    <div v-if="probe.dnsHostName" class="mt-1 text-xs opacity-80">
                      {{ probe.dnsHostName }} · Domäne {{ probe.domainDnsName }}
                      <template v-if="probe.domainNetbiosName">
                        ({{ probe.domainNetbiosName }})
                      </template>
                    </div>
                  </AlertDescription>
                </Alert>
              </section>

              <section class="space-y-4">
                <h3 class="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                  2 · Was abgeglichen wird
                </h3>

                <div class="space-y-2">
                  <Label>Bereiche im Verzeichnis</Label>

                  <OuPicker
                    v-model="selectedBases"
                    :units="ouUnits"
                    :loading="loadingOus"
                    empty-hint="Nach erfolgreicher Verbindungsprüfung erscheint hier die Struktur des Verzeichnisses zum Ankreuzen."
                  />

                  <p class="text-muted-foreground text-xs">
                    Mehrere Bereiche sind möglich; jeder wird samt allem darunter abgeglichen.
                    <template v-if="selectedBases.length === 0">
                      Ohne Auswahl wird die gesamte Domäne abgeglichen.
                    </template>
                    <template v-else>Gewählt: {{ selectedBases.length }} Bereich(e).</template>
                  </p>
                </div>

                <div class="space-y-2">
                  <Label>Auswahl der Konten</Label>

                  <div class="flex flex-wrap gap-x-6 gap-y-2">
                    <div class="flex items-center gap-2">
                      <Checkbox
                        id="excl-disabled"
                        v-model="ad.excludeDisabled"
                        :disabled="ad.filterMode === 'custom'"
                      />
                      <Label for="excl-disabled" class="font-normal">
                        Deaktivierte Konten überspringen
                      </Label>
                    </div>

                    <div class="flex items-center gap-2">
                      <Checkbox
                        id="excl-servers"
                        v-model="ad.excludeServers"
                        :disabled="ad.filterMode === 'custom'"
                      />
                      <Label for="excl-servers" class="font-normal">Server überspringen</Label>
                    </div>

                    <div class="flex items-center gap-2">
                      <Checkbox
                        id="custom-filter"
                        :model-value="customFilter"
                        @update:model-value="onFilterModeChange"
                      />
                      <Label for="custom-filter" class="font-normal">Eigener LDAP-Filter</Label>
                    </div>
                  </div>
                </div>

                <div class="space-y-1.5">
                  <Label for="ad-filter">Wirksamer Filter</Label>
                  <Input
                    id="ad-filter"
                    v-model="filterText"
                    :readonly="ad.filterMode !== 'custom'"
                    class="font-mono text-xs"
                    :class="ad.filterMode !== 'custom' ? 'bg-muted' : ''"
                  />
                  <p class="text-muted-foreground text-xs">
                    <template v-if="ad.filterMode === 'custom'">
                      Eigener Ausdruck. Die Verbindungsprüfung zeigt, wie viele Konten er trifft.
                    </template>
                    <template v-else>
                      Aus den Ankreuzfeldern zusammengesetzt — hier nur zur Ansicht.
                    </template>
                  </p>
                </div>
              </section>
            </div>

            <section class="space-y-4">
              <h3 class="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                3 · Ablauf
              </h3>

              <div class="grid gap-4 sm:grid-cols-3">
                <div class="space-y-1.5">
                  <Label for="ad-interval">Intervall (Minuten)</Label>
                  <Input id="ad-interval" v-model.number="ad.intervalMinutes" type="number" min="5" />
                </div>
                <div class="space-y-1.5">
                  <Label for="ad-page">Seitengrösse</Label>
                  <Input id="ad-page" v-model.number="ad.pageSize" type="number" min="1" />
                  <p class="text-muted-foreground text-xs">
                    AD liefert ohne Paging höchstens 1000 Einträge.
                  </p>
                </div>
                <div class="space-y-1.5">
                  <Label for="ad-timeout">Zeitlimit (Sekunden)</Label>
                  <Input id="ad-timeout" v-model.number="ad.timeoutSeconds" type="number" min="5" />
                </div>
              </div>
            </section>
          </CardContent>

          <CardFooter>
            <Button :disabled="savingAd" @click="saveAd">
              <Loader2 v-if="savingAd" class="size-4 animate-spin" />
              Speichern
            </Button>
          </CardFooter>
        </Card>

        <!-- ================= Agent-Registrierung ================= -->
        <Card v-if="active === 'agent' && !loading" class="xl:w-1/2">
          <CardHeader>
            <CardTitle>Agent-Registrierung</CardTitle>
            <CardDescription>
              Dieses Token legt ein Agent beim erstmaligen Start vor. Danach arbeitet jedes Gerät
              mit einem eigenen, serverseitig erzeugten Secret.
            </CardDescription>
          </CardHeader>

          <CardContent class="space-y-4">
            <div class="space-y-1.5">
              <Label for="token">Enrollment-Token</Label>
              <div class="flex gap-2">
                <Input id="token" :model-value="agent.enrollmentToken" readonly class="font-mono" />
                <Button variant="secondary" size="icon" @click="copyToken">
                  <Check v-if="copied" class="size-4" />
                  <span v-else class="i">⧉</span>
                </Button>
              </div>
              <p class="text-muted-foreground text-xs">
                Ein neues Token betrifft nur Neuinstallationen — bereits registrierte Geräte laufen
                unverändert weiter. Rotieren ist deshalb billig.
              </p>
            </div>

            <div class="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs">
              wiupmo-agent.exe --install --backend-url {{ backendUrl }} --enrollment-token
              {{ agent.enrollmentToken }}
            </div>
          </CardContent>

          <CardFooter>
            <Button variant="secondary" :disabled="rotating" @click="rotateToken">
              <RefreshCw class="size-4" :class="rotating ? 'animate-spin' : ''" />
              Neues Token erzeugen
            </Button>
          </CardFooter>
        </Card>

        <!-- ================= Anmeldung ================= -->
        <Card v-if="active === 'auth' && !loading" class="xl:w-1/2">
          <CardHeader>
            <CardTitle>Anmeldung</CardTitle>
            <CardDescription>
              Lokale Benutzer oder ein Bind gegen das Verzeichnis. Die Verbindungsdaten kommen aus
              der AD-Konfiguration — gebunden wird aber mit den Zugangsdaten des jeweiligen
              Benutzers, nicht mit dem Dienstkonto.
            </CardDescription>
          </CardHeader>

          <CardContent class="space-y-4">
            <div class="space-y-2">
              <Label>Zugelassene Anmeldewege</Label>

              <div class="flex items-center gap-2">
                <Checkbox
                  id="auth-local"
                  v-model="authSettings.localEnabled"
                  :disabled="authSettings.localEnabled && onlyRemainingWay"
                />
                <Label for="auth-local" class="font-normal">Lokale Benutzer</Label>
              </div>

              <div class="flex items-center gap-2">
                <Checkbox
                  id="auth-ldap"
                  v-model="authSettings.ldapEnabled"
                  :disabled="authSettings.ldapEnabled && onlyRemainingWay"
                />
                <Label for="auth-ldap" class="font-normal">
                  LDAP-Bind gegen das Verzeichnis
                </Label>
              </div>

              <p class="text-muted-foreground text-xs">
                Beide sind gleichwertig und lassen sich zusammen betreiben; beim Anmelden wird
                zuerst das Verzeichnis gefragt. Mindestens einer muss offen bleiben — deshalb
                lässt sich der letzte nicht abwählen.
                <template v-if="authSettings.ldapEnabled && !authSettings.localEnabled">
                  <strong>
                    Ohne lokale Benutzer sperrt ein ausgefallener Domänencontroller jeden aus.
                  </strong>
                </template>
              </p>
            </div>

            <div v-if="authSettings.ldapEnabled" class="space-y-1.5">
              <Label>Namensform bei der Anmeldung</Label>
              <Select :model-value="dnMode" @update:model-value="applyDnMode($event as DnMode)">
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="option in dnModeOptions" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p class="text-muted-foreground text-xs">
                <template v-if="dnMode === 'custom'">
                  Eigene Vorlage, muss <code>{username}</code> enthalten.
                </template>
                <template v-else>
                  Ergibt: <code>{{ authSettings.userDnTemplate }}</code>
                </template>
              </p>
            </div>

            <div v-if="authSettings.ldapEnabled && dnMode === 'custom'" class="space-y-1.5">
              <Label for="dn">Vorlage</Label>
              <Input id="dn" v-model="authSettings.userDnTemplate" class="font-mono" />
            </div>

            <div v-if="authSettings.ldapEnabled" class="space-y-2">
              <Label>Freigegebene Gruppen</Label>

              <div class="flex gap-2">
                <Input
                  v-model="groupSearch"
                  placeholder="Gruppe suchen"
                  class="h-9"
                  @keyup.enter="loadGroups"
                />
                <Button variant="secondary" :disabled="loadingGroups" @click="loadGroups">
                  <Loader2 v-if="loadingGroups" class="size-4 animate-spin" />
                  Suchen
                </Button>
              </div>

              <GroupPicker
                v-model="authSettings.allowedGroups"
                :groups="groupRows"
                :loading="loadingGroups"
                empty-hint="Noch keine Gruppen geladen. Suchbegriff eingeben und „Suchen“ — oder leer lassen, um die ersten 500 zu sehen."
              />

              <p class="text-muted-foreground text-xs">
                <template v-if="authSettings.allowedGroups.length === 0">
                  Keine Einschränkung: Jedes Konto, das sich am Verzeichnis anmelden kann, kommt
                  auch hier hinein.
                </template>
                <template v-else>
                  {{ authSettings.allowedGroups.length }} Gruppe(n) freigegeben. Verschachtelte
                  Mitgliedschaften zählen mit — wer nur über eine untergeordnete Gruppe drinsteckt,
                  kommt ebenfalls herein.
                </template>
              </p>
            </div>

            <Alert v-if="authSettings.ldapEnabled && !ad.configured" class="border-warning/50">
              <AlertDescription>
                Es ist kein Verzeichnis konfiguriert. Die LDAP-Anmeldung kann so nicht
                funktionieren.
              </AlertDescription>
            </Alert>
          </CardContent>

          <CardFooter>
            <Button :disabled="savingAuth" @click="saveAuth">
              <Loader2 v-if="savingAuth" class="size-4 animate-spin" />
              Speichern
            </Button>
          </CardFooter>
        </Card>

        <!-- ================= Schwellwerte ================= -->
        <Card v-if="active === 'thresholds' && !loading" class="xl:w-1/2">
          <CardHeader>
            <CardTitle>Schwellwerte</CardTitle>
            <CardDescription>
              Ab wann ein Zustand in den Auswertungen auffällig wird.
            </CardDescription>
          </CardHeader>

          <CardContent class="space-y-4">
            <div class="space-y-1.5">
              <Label for="t-stale">Kein Check-in seit (Tage)</Label>
              <Input id="t-stale" v-model.number="thresholds.staleAgentDays" type="number" min="1" />
              <p class="text-muted-foreground text-xs">
                Unterscheidet „gepatcht" von „meldet sich nicht mehr".
              </p>
            </div>

            <div class="space-y-1.5">
              <Label for="t-critical">Kritisch offen seit (Tage)</Label>
              <Input id="t-critical" v-model.number="thresholds.criticalOpenDays" type="number" min="1" />
            </div>

            <div class="space-y-1.5">
              <Label for="t-reboot">Neustart ausstehend seit (Tage)</Label>
              <Input id="t-reboot" v-model.number="thresholds.pendingRebootDays" type="number" min="1" />
            </div>
          </CardContent>

          <CardFooter>
            <Button :disabled="savingThresholds" @click="saveThresholds">
              <Loader2 v-if="savingThresholds" class="size-4 animate-spin" />
              Speichern
            </Button>
          </CardFooter>
        </Card>

        <!-- ================= Aufbewahrung ================= -->
        <Card v-if="active === 'retention' && !loading" class="xl:w-1/2">
          <CardHeader>
            <CardTitle>Aufbewahrung</CardTitle>
            <CardDescription>
              Ein Job räumt nachts um 03:15 auf: Ereignisse und Check-ins, die älter sind als die
              Fristen. Die aktuellen Update-Zustände bleiben unberührt.
            </CardDescription>
          </CardHeader>

          <CardContent class="space-y-4">
            <div class="space-y-1.5">
              <Label for="r-events">Ereignisse (Tage)</Label>
              <Input id="r-events" v-model.number="retention.eventDays" type="number" min="7" />
              <p class="text-muted-foreground text-xs">
                Betrifft die Zeitreihe. Der aktuelle Update-Zustand bleibt unberührt.
              </p>
            </div>

            <div class="space-y-1.5">
              <Label for="r-checkins">Check-ins (Tage)</Label>
              <Input id="r-checkins" v-model.number="retention.checkinDays" type="number" min="7" />
            </div>
          </CardContent>

          <CardFooter class="flex-wrap gap-3">
            <Button :disabled="savingRetention" @click="saveRetention">
              <Loader2 v-if="savingRetention" class="size-4 animate-spin" />
              Speichern
            </Button>
            <Button variant="outline" :disabled="cleaning" @click="runRetention">
              <Trash2 class="size-4" />
              Jetzt aufräumen
            </Button>
            <span class="text-muted-foreground text-xs">
              Löscht endgültig. Sinnvoll, um zu sehen, was eine geänderte Frist tatsächlich trifft.
            </span>
          </CardFooter>
        </Card>
      </div>
    </div>
  </div>
</template>
