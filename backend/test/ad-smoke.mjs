/**
 * AD-Test gegen eine Instanz im Test-Stack und dessen Samba-AD (Domaene
 * test.wiupmo, eingerichtet mit test/ad-setup.sh). Prueft die Verbindungsprobe,
 * den Abgleich der Computerkonten mit Archivierung und Reaktivierung und die
 * LDAP-Anmeldung mit Gruppenfreigabe.
 *
 *   node test/ad-smoke.mjs [Basis-URL] [Pfad zu ca.pem]
 *
 * Speichert AD- und Anmeldeeinstellungen — nie gegen die Produktion.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client, assertTestTarget, checkin, createRunner, enroll, host, minutesAgo, signIn, snapshot } from './smoke-lib.mjs';

const [base = 'http://backend:3000', caPath = '/testfiles/tls/ca.pem'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
assertTestTarget(base);

const BASE_DN = 'DC=test,DC=wiupmo';
const CLIENTS = `OU=Clients,${BASE_DN}`;
const NOTEBOOKS = `OU=Notebooks,${CLIENTS}`;
const SERVER = `OU=Server,${BASE_DN}`;
const ZUGANG = `CN=wiupmo-zugang,CN=Users,${BASE_DN}`;

const connection = {
  url: 'ldaps://samba:636',
  baseDn: BASE_DN,
  bindDn: 'svc-wiupmo@test.wiupmo',
  bindPassword: 'Svc-Passw0rd!',
  caCertificate: readFileSync(caPath, 'utf8'),
  tlsRejectUnauthorized: true,
  filterMode: 'guided',
  excludeDisabled: true,
  excludeServers: false,
};

const api = new Client(base);
const agent = new Client(base);
const { step, finish } = createRunner('AD-Test');

let enrollmentToken = '';
let notebook = null;

// Ohne Bereiche zaehlt die Probe die ganze Domaene, unabhaengig davon, was
// gespeichert ist.
const probe = (overrides = {}) => api.post('/api/ad/probe', { ...connection, searchBases: [], ...overrides });

/** Was gespeichert ist. Gesendet wird immer alles, so wie die Oberflaeche es tut. */
let adState = { ...connection, searchBases: [CLIENTS, SERVER] };

const syncRunCount = async () => (await api.get('/api/ad/sync-runs?limit=1')).total;

/**
 * Wartet auf den Abgleich, den das Backend nach einer Aenderung des Bereichs
 * selbst startet (AdSchedulerService). Ein eigener Aufruf von /api/ad/sync
 * stiesse sonst mit 409 auf den laufenden.
 */
async function waitForRun(before) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const runs = await api.get('/api/ad/sync-runs?limit=1');
    if (runs.total > before && runs.items[0]?.finishedAt) return runs.items[0];
    await sleep(1000);
  }
  throw new Error('Nach dem Speichern lief kein Abgleich, oder er endete nicht.');
}

/**
 * Speichert die AD-Einstellungen. Aendert sich dabei der abgeglichene
 * Bereich (Adresse, Bereiche, Filter), liefert es den dadurch ausgeloesten Lauf.
 */
async function saveAd(changes, { scopeChanges = true } = {}) {
  adState = { ...adState, ...changes };
  const before = await syncRunCount();
  const view = await api.put('/api/settings/ad', adState);
  return { view, run: scopeChanges ? await waitForRun(before) : null };
}

async function deviceByName(hostname) {
  // Ohne Statusfilter, damit auch archivierte Geraete auftauchen.
  const list = await api.get(`/api/devices?search=${hostname}&limit=10`);
  const match = list.items.find((d) => d.hostname.toLowerCase() === hostname.toLowerCase());
  assert.ok(match, `${hostname} nicht in der Geraeteliste`);
  return api.get(`/api/devices/${match.id}`);
}

const login = (username, password, expect = 200) =>
  new Client(base).request('POST', '/api/auth/login', { body: { username, password }, expect });

await step('Anmeldung und Agent von NB-001 vor dem ersten Abgleich', async () => {
  await signIn(api);
  enrollmentToken = (await api.get('/api/settings')).agent.enrollmentToken;
  notebook = await enroll(agent, enrollmentToken, host('NB-001'));
  await checkin(agent, notebook.token, snapshot({ hostInfo: host('NB-001'), collectedAt: minutesAgo(5) }));
});

await step('Probe ueber LDAPS mit CA-Zertifikat', async () => {
  const res = await probe();
  assert.equal(res.ok, true, res.message);
  assert.equal(res.defaultNamingContext, BASE_DN);
  assert.equal(res.domainDnsName, 'test.wiupmo');
  assert.equal(res.domainNetbiosName, 'TESTWIUPMO');
  // Vier Testkonten und der Domaenencontroller selbst; NB-003 ist
  // deaktiviert und zaehlt nicht.
  assert.equal(res.matchedComputers, 5);
  assert.match(res.effectiveFilter, /userAccountControl/);
});

await step('Probe ohne CA-Zertifikat, aber mit Pruefung: abgelehnt', async () => {
  const res = await probe({ caCertificate: '' });
  assert.equal(res.ok, false);
  assert.match(res.message, /Zertifikat/);
});

await step('Probe ohne Zertifikatspruefung', async () => {
  assert.equal((await probe({ caCertificate: '', tlsRejectUnauthorized: false })).ok, true);
});

await step('Probe mit falschem Passwort', async () => {
  const res = await probe({ bindPassword: 'falsch' });
  assert.equal(res.ok, false);
  assert.equal(res.message, 'Benutzername oder Passwort des Dienstkontos ist falsch.');
});

await step('Probe unverschluesselt: Samba verlangt eine gesicherte Verbindung', async () => {
  const res = await probe({ url: 'ldap://samba:389' });
  assert.equal(res.ok, false);
  assert.ok(res.message.length > 0);
});

await step('Organisationseinheiten und Gruppen zur Auswahl', async () => {
  const units = (await api.post('/api/ad/organizational-units', connection)).map((u) => u.dn);
  for (const dn of [CLIENTS, NOTEBOOKS, SERVER]) assert.ok(units.includes(dn), `${dn} fehlt`);
  const groups = await api.post('/api/ad/groups', { ...connection, search: 'wiupmo' });
  assert.ok(groups.some((g) => g.dn === ZUGANG), 'wiupmo-zugang fehlt');
});

await step('Speichern startet den ersten Abgleich: deaktiviertes Konto bleibt draussen', async () => {
  const { view, run } = await saveAd({});
  assert.equal(view.configured, true);
  assert.equal(view.bindPasswordSet, true);
  assert.equal('bindPassword' in view, false);
  assert.equal('bindPassword' in (await api.get('/api/settings')).ad, false);

  assert.equal(run.status, 'success', run.error ?? '');
  // NB-001, NB-002, PC-001, SRV-001 - NB-003 ist deaktiviert.
  assert.equal(run.devicesFound, 4);
  // NB-001 kennt das Backend schon ueber seinen Agent.
  assert.equal(run.devicesCreated, 3);
  assert.equal(run.devicesArchived, 0, 'archiviert gemeldet, obwohl nichts archiviert wurde');
});

await step('NB-001: Agent-Geraet und AD-Konto sind ein Datensatz', async () => {
  const nb = await deviceByName('NB-001');
  assert.equal(nb.id, notebook.deviceId);
  assert.equal(nb.adOu, NOTEBOOKS);
  assert.ok(nb.adObjectGuid, 'keine objectGUID uebernommen');
  assert.ok(nb.enrolledAt);
});

await step('Abgleich von Hand: nichts Neues', async () => {
  const res = await api.post('/api/ad/sync');
  assert.equal(res.status, 'success', res.error ?? '');
  assert.equal(res.devicesFound, 4);
  assert.equal(res.devicesCreated, 0);
  assert.equal(res.devicesReactivated, 0);
  assert.equal(res.devicesArchived, 0, 'archiviert gemeldet, obwohl nichts archiviert wurde');
});

await step('Fehlende Agents und OU-Navigation', async () => {
  const missing = (await api.get('/api/reports/missing-agents')).map((d) => d.hostname);
  for (const name of ['NB-002', 'PC-001', 'SRV-001']) assert.ok(missing.includes(name), `${name} fehlt`);
  assert.ok(!missing.includes('NB-001'));
  const units = (await api.get('/api/devices/organizational-units')).map((u) => u.dn);
  assert.ok(units.includes(NOTEBOOKS));
});

await step('Server ausgeblendet: SRV-001 archiviert, danach wieder aktiv', async () => {
  const hidden = await saveAd({ excludeServers: true });
  assert.equal(hidden.run.status, 'success', hidden.run.error ?? '');
  const archived = await deviceByName('SRV-001');
  assert.equal(archived.status, 'archived');
  assert.match(archived.archivedReason ?? '', /nicht mehr vorhanden/);

  const shown = await saveAd({ excludeServers: false });
  assert.equal(shown.run.status, 'success', shown.run.error ?? '');
  assert.equal((await deviceByName('SRV-001')).status, 'active');
  assert.equal(hidden.run.devicesArchived, 1, 'Zahl der archivierten Geraete');
});

await step('Bereich abgewaehlt: SRV-001 liegt ausserhalb, sein Agent holt es nicht zurueck', async () => {
  const narrowed = await saveAd({ searchBases: [CLIENTS] });
  assert.equal(narrowed.run.status, 'success', narrowed.run.error ?? '');
  const server = await deviceByName('SRV-001');
  assert.equal(server.status, 'archived');
  assert.match(server.archivedReason ?? '', /abgeglichenen Bereichen/);

  const enrolled = await enroll(agent, enrollmentToken, host('SRV-001', { osName: 'Windows Server 2022 Standard' }));
  assert.equal(enrolled.deviceId, server.id);
  assert.equal((await deviceByName('SRV-001')).status, 'archived');
  await checkin(agent, enrolled.token, snapshot({ hostInfo: host('SRV-001'), collectedAt: minutesAgo(1) }), 403);

  const widened = await saveAd({ searchBases: [CLIENTS, SERVER] });
  assert.equal(widened.run.status, 'success', widened.run.error ?? '');
  assert.equal((await deviceByName('SRV-001')).status, 'active', 'zurueck im Bereich');
  assert.equal(narrowed.run.devicesArchived, 1, 'Zahl der archivierten Geraete');
});

await step('Protokoll der Abgleiche', async () => {
  const runs = await api.get('/api/ad/sync-runs');
  assert.ok(runs.total >= 6, `${runs.total} Laeufe`);
  assert.ok(runs.items.every((r) => r.status === 'success'), 'nicht jeder Lauf war erfolgreich');
});

const ldapAuth = (overrides = {}) =>
  api.put('/api/settings/auth', {
    ldapEnabled: true,
    localEnabled: true,
    userDnTemplate: '{username}@test.wiupmo',
    allowedGroups: [ZUGANG],
    ...overrides,
  });

await step('LDAP-Anmeldung ohne Zertifikatspruefung: Gruppen greifen, auch verschachtelt', async () => {
  await saveAd({ tlsRejectUnauthorized: false }, { scopeChanges: false });
  await ldapAuth();
  assert.equal((await login('lena', 'Lena-Passw0rd!')).data.username, 'lena');
  assert.equal((await login('nina', 'Nina-Passw0rd!')).data.username, 'nina', 'nina ist ueber it-team freigegeben');
  await login('sam', 'Sam-Passw0rd!', 401);
  await login('lena', 'falsch', 401);
  await login('admin', 'nur-fuer-den-test-stack');
});

// Gleiche Anmeldung, nur jetzt mit geprueftem Zertifikat. Der Abgleich besteht
// das mit derselben Einstellung (siehe oben) - die Anmeldung muss es auch.
await step('LDAP-Anmeldung mit CA-Zertifikat und Pruefung', async () => {
  await saveAd({ tlsRejectUnauthorized: true }, { scopeChanges: false });
  await ldapAuth();
  assert.equal((await login('lena', 'Lena-Passw0rd!')).data.username, 'lena');
});

await step('Nur LDAP: lokales Konto gesperrt, danach wieder offen', async () => {
  await ldapAuth({ localEnabled: false });
  await login('admin', 'nur-fuer-den-test-stack', 401);
  // Die bestehende Sitzung gilt weiter; damit wird zurueckgestellt.
  await ldapAuth({ ldapEnabled: false, localEnabled: true });
  await login('admin', 'nur-fuer-den-test-stack');
});

// Die API verspricht eine teilweise Aktualisierung: Nicht gesendete Felder
// bleiben. Die Oberflaeche schickt immer alles, deshalb steht das einzeln und
// zuletzt - danach wird der vollstaendige Stand wieder hergestellt.
await step('Teilweise Aktualisierung der AD-Einstellungen', async () => {
  try {
    const view = await api.put('/api/settings/ad', { timeoutSeconds: 30 });
    assert.deepEqual(view.searchBases, adState.searchBases);
    assert.equal(view.timeoutSeconds, 30);
  } finally {
    await api.put('/api/settings/ad', adState);
  }
});

finish();
