/**
 * Smoke-Test gegen eine laufende Instanz im Test-Stack (deploy/test-stack.ps1).
 * Legt das Administratorkonto an, falls die Instanz leer ist, registriert ein
 * Geraet, schickt Check-ins und prueft danach jede Ansicht der API.
 *
 *   node test/smoke.mjs [Basis-URL] [--nur-daten]
 *
 * --nur-daten legt nur das Geraet mit seinen Check-ins an. Der Migrationstest
 * benutzt das gegen das alte Image: Dessen API kennt womoeglich noch nicht
 * alles, was hier sonst geprueft wird, der Agent-Vertrag aber bleibt stabil.
 *
 * Schreibt Daten und aendert Einstellungen — nie gegen die Produktion.
 */
import assert from 'node:assert/strict';
import {
  ADMIN,
  AGENT_VERSION,
  Client,
  UUID,
  assertTestTarget,
  checkin,
  createRunner,
  enroll,
  history,
  host,
  minutesAgo,
  signIn,
  snapshot,
  update,
} from './smoke-lib.mjs';

const base = process.argv.find((arg, i) => i >= 2 && !arg.startsWith('--')) ?? 'http://backend:3000';
const dataOnly = process.argv.includes('--nur-daten');
assertTestTarget(base);

const RUN = Date.now().toString(36).toUpperCase();
const HOST = `SMOKE-${RUN}`;
const hostInfo = host(HOST);

const api = new Client(base);
const agent = new Client(base);
const { step, finish } = createRunner(dataOnly ? 'Testdaten' : 'Smoke-Test');

const U = {
  critical: update({ title: `Smoke ${RUN}: Kumulatives Sicherheitsupdate`, security: true, severity: 'Critical', categories: ['Security Updates'], rebootRequired: true }),
  quality: update({ title: `Smoke ${RUN}: Qualitaetsupdate`, categories: ['Updates'] }),
  dotnet: update({ title: `Smoke ${RUN}: Sicherheitsupdate .NET`, security: true, severity: 'Important', categories: ['Security Updates'] }),
  defender: update({ title: `Smoke ${RUN}: Definitionsupdate`, categories: ['Definition Updates'] }),
  late: update({ title: `Smoke ${RUN}: Spaetes Sicherheitsupdate`, security: true, severity: 'Moderate', categories: ['Security Updates'] }),
};

/** WU_E_UH_POSTREBOOTSTILLPENDING waere ein Erfolg; das hier ist ein echter Fehler (0x80240017). */
const HRESULT_FAILED = -2145124329;

let enrollmentToken = '';
let device = null;

// Erster Durchlauf: drei offene Updates, nichts installiert.
const first = snapshot({ hostInfo, collectedAt: minutesAgo(120), available: [U.critical, U.quality, U.dotnet] });

// Zweiter: Das kritische Update ist installiert, das Qualitaetsupdate gescheitert.
const second = snapshot({
  hostInfo,
  collectedAt: minutesAgo(60),
  available: [U.dotnet],
  entries: [
    history(U.critical, { resultCode: 2, occurredAt: minutesAgo(90) }),
    history(U.quality, { resultCode: 4, hresult: HRESULT_FAILED, occurredAt: minutesAgo(80) }),
  ],
  pendingReboot: true,
});

// Nachgereicht aus der Warteschlange: zwei neue Updates, .NET installiert.
const queued = [
  snapshot({ hostInfo, collectedAt: minutesAgo(30), available: [U.dotnet, U.defender, U.late], pendingReboot: true }),
  snapshot({
    hostInfo,
    collectedAt: minutesAgo(10),
    available: [U.defender, U.late],
    entries: [history(U.dotnet, { resultCode: 2, occurredAt: minutesAgo(20) })],
    pendingReboot: true,
  }),
];

await step('Healthcheck', async () => {
  const health = await api.get('/health');
  assert.equal(health.status, 'ok');
  assert.equal(health.database, 'ok');
});

await step('Einrichtung oder Anmeldung', async () => {
  await signIn(api);
  assert.equal((await api.get('/api/auth/me')).username, ADMIN.username);
});

await step('Enrollment-Token aus den Einstellungen', async () => {
  enrollmentToken = (await api.get('/api/settings')).agent.enrollmentToken;
  assert.ok(enrollmentToken.length >= 16, 'Token zu kurz oder leer');
});

await step('Registrierung', async () => {
  device = await enroll(agent, enrollmentToken, hostInfo);
  assert.match(device.deviceId, UUID);
  assert.equal(device.token, `${device.deviceId}.${device.deviceSecret}`);
});

await step('Check-in mit drei offenen Updates', async () => {
  const res = await checkin(agent, device.token, first);
  assert.deepEqual(res.results.map((r) => r.outcome), ['accepted']);
  assert.equal(typeof res.checkIntervalMinutes, 'number');
});

await step('Check-in mit Installation und Fehlschlag', async () => {
  const res = await checkin(agent, device.token, second);
  assert.deepEqual(res.results.map((r) => r.outcome), ['accepted']);
});

await step('Nachreichung aus der Warteschlange', async () => {
  // Absichtlich in falscher Reihenfolge: Das Backend sortiert nach collectedAt.
  const res = await agent.post('/api/agent/v1/checkin/batch', { snapshots: [queued[1], queued[0]] }, { token: device.token });
  assert.deepEqual(res.results.map((r) => r.outcome), ['accepted', 'accepted']);
});

if (dataOnly) {
  finish();
  console.log(`Geraet ${HOST} (${device?.deviceId ?? 'nicht angelegt'}) mit vier Check-ins.`);
  process.exit();
}

// --- Anmeldung -----------------------------------------------------------------

await step('Einrichtung ist geschlossen', async () => {
  const status = await new Client(base).get('/api/auth/status');
  assert.equal(status.setupRequired, false);
  await new Client(base).request('POST', '/api/auth/setup', { body: { username: 'zweiter', password: 'noch-ein-langes-passwort' }, expect: 409 });
});

await step('Falsches Passwort und fehlende Sitzung', async () => {
  await new Client(base).request('POST', '/api/auth/login', { body: { ...ADMIN, password: 'falsch' }, expect: 401 });
  await new Client(base).request('GET', '/api/devices', { expect: 401 });
  await new Client(base).request('GET', '/api/settings', { expect: 401 });
});

// --- Agent-Schnittstelle --------------------------------------------------------

await step('Derselbe Snapshot zweimal: duplicate', async () => {
  const res = await checkin(agent, device.token, first);
  assert.deepEqual(res.results.map((r) => r.outcome), ['duplicate']);
});

await step('Agent ohne oder mit falschem Token', async () => {
  await checkin(agent, undefined, snapshot({ hostInfo, collectedAt: minutesAgo(1) }), 401);
  await checkin(agent, `${device.deviceId}.falsch`, snapshot({ hostInfo, collectedAt: minutesAgo(1) }), 401);
  await enroll(agent, 'falsches-token-0123456789', host(`FREMD-${RUN}`), 401);
});

await step('Unbekanntes Feld im Snapshot wird abgelehnt', async () => {
  await checkin(agent, device.token, { ...snapshot({ hostInfo, collectedAt: minutesAgo(1) }), unbekannt: true }, 400);
});

// --- Auswertung -----------------------------------------------------------------

await step('Geraeteliste', async () => {
  const list = await api.get(`/api/devices?search=${HOST}`);
  assert.equal(list.total, 1);
  const item = list.items[0];
  assert.equal(item.id, device.deviceId);
  assert.equal(item.openUpdates, 2);
  assert.equal(item.openSecurityUpdates, 1);
  assert.equal(item.pendingReboot, true);
  assert.equal(item.updateSource, 'wsus');
  assert.equal(item.agentVersion, AGENT_VERSION);
});

await step('Geraetedetail mit Update-Zustaenden', async () => {
  const detail = await api.get(`/api/devices/${device.deviceId}`);
  const state = Object.fromEntries(detail.updates.map((u) => [u.kbArticle, u.state]));
  assert.equal(state[U.critical.kbArticle], 'installed');
  assert.equal(state[U.quality.kbArticle], 'failed');
  assert.equal(state[U.dotnet.kbArticle], 'installed');
  assert.equal(state[U.defender.kbArticle], 'available');
  assert.equal(state[U.late.kbArticle], 'available');
  const failed = detail.updates.find((u) => u.kbArticle === U.quality.kbArticle);
  assert.equal(failed.hresult, HRESULT_FAILED);
  assert.equal(detail.checkins.length, 4);
  assert.equal(detail.agentDiagnostics?.queuedSnapshots, 0);
});

await step('Zeitreihe', async () => {
  const timeline = await api.get(`/api/devices/${device.deviceId}/timeline`);
  const types = new Set(timeline.items.map((e) => e.eventType));
  for (const type of ['appeared', 'installed', 'failed']) assert.ok(types.has(type), `Ereignis ${type} fehlt`);
});

await step('CSV-Export', async () => {
  const res = await api.request('GET', `/api/devices/export?search=${HOST}`, { raw: true });
  assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
  assert.ok(res.data.includes(HOST));
});

await step('OU-Navigation', async () => {
  assert.ok(Array.isArray(await api.get('/api/devices/organizational-units')));
});

await step('Update-Katalog und Betroffene', async () => {
  const list = await api.get(`/api/updates?search=${U.late.kbArticle}`);
  assert.equal(list.total, 1);
  assert.equal(list.items[0].isSecurity, true);
  const affected = await api.get(`/api/updates/${list.items[0].id}/devices`);
  assert.ok(affected.items.some((d) => d.hostname === HOST && d.state === 'available'));
});

await step('Berichte', async () => {
  const summary = await api.get('/api/reports/summary');
  assert.ok(summary.devicesEnrolled >= 1);
  assert.ok(summary.openUpdatesTotal >= 2);
  for (const path of ['compliance', 'patch-age', 'stale-agents', 'missing-agents', 'time-to-patch', 'failures', 'trend?days=30', 'agent-versions', 'agent-trend?days=30']) {
    await api.get(`/api/reports/${path}`);
  }
  const sources = await api.get('/api/reports/update-sources');
  assert.ok(sources.distribution.some((d) => d.source === 'wsus'));
});

// --- Einstellungen --------------------------------------------------------------

await step('Melde-Intervall geht mit dem Check-in an den Agent', async () => {
  await api.put('/api/settings/agent', { checkIntervalMinutes: 45 });
  const res = await checkin(agent, device.token, snapshot({ hostInfo, collectedAt: minutesAgo(5), available: [U.defender, U.late], pendingReboot: true }));
  assert.equal(res.checkIntervalMinutes, 45);
  await api.put('/api/settings/agent', { checkIntervalMinutes: 60 });
  await api.request('PUT', '/api/settings/agent', { body: { checkIntervalMinutes: 1 }, expect: 400 });
});

await step('Schwellwerte und Aufbewahrung', async () => {
  const settings = await api.get('/api/settings');
  await api.put('/api/settings/thresholds', settings.thresholds);
  await api.put('/api/settings/retention', settings.retention);
  await api.request('PUT', '/api/settings/retention', { body: { eventDays: 1 }, expect: 400 });
  // Alles von heute - innerhalb jeder Frist, also nichts zu loeschen.
  const run = await api.post('/api/maintenance/retention');
  assert.equal(run.eventsDeleted, 0);
  assert.equal(run.checkinsDeleted, 0);
});

await step('Neues Enrollment-Token: das alte gilt nicht mehr', async () => {
  const renewed = await api.put('/api/settings/agent/enrollment-token', {});
  assert.notEqual(renewed.enrollmentToken, enrollmentToken);
  await enroll(agent, enrollmentToken, host(`ALT-${RUN}`), 401);
  enrollmentToken = renewed.enrollmentToken;
});

await step('Erneute Registrierung: gleiche Geraete-ID, altes Secret gesperrt', async () => {
  const again = await enroll(agent, enrollmentToken, hostInfo);
  assert.equal(again.deviceId, device.deviceId);
  await checkin(agent, device.token, snapshot({ hostInfo, collectedAt: minutesAgo(4) }), 401);
  device = again;
});

await step('Archiviert: Check-in abgewiesen; wiederhergestellt: angenommen', async () => {
  const archived = await api.post(`/api/devices/${device.deviceId}/archive`, { reason: 'Smoke-Test' });
  assert.equal(archived.status, 'archived');
  assert.equal(archived.archivedReason, 'Smoke-Test');
  await checkin(agent, device.token, snapshot({ hostInfo, collectedAt: minutesAgo(3) }), 403);
  const restored = await api.post(`/api/devices/${device.deviceId}/restore`);
  assert.equal(restored.status, 'active');
  assert.equal(restored.archivedReason, null);
  await checkin(agent, device.token, snapshot({ hostInfo, collectedAt: minutesAgo(2), available: [U.defender, U.late], pendingReboot: true }));
  await api.request('POST', '/api/devices/00000000-0000-4000-8000-000000000000/archive', { body: {}, expect: 404 });
});

await step('AD-Abgleich ohne Konfiguration: 409', async () => {
  const status = await api.get('/api/ad/status');
  if (!status.enabled) await api.request('POST', '/api/ad/sync', { expect: 409 });
});

// --- Agent-Versionen ------------------------------------------------------------

await step('Mitgelieferter Agent ist hinterlegt und ladbar', async () => {
  const releases = await api.get('/api/agent-releases');
  const current = releases.find((r) => r.isCurrent);
  assert.ok(current, 'keine aktuelle Version - wurde das Agent-Binary beim Start aufgenommen?');
  const res = await fetch(`${base}/api/agent-releases/${current.id}/download`, { headers: { cookie: api.cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String(current.sizeBytes));
  await res.body?.cancel();
  assert.ok(Array.isArray(await api.get('/api/agent-update-jobs')));
});

await step('Selbst-Update: Auftrag, Auslieferung beim Check-in, Download, Rueckmeldung', async () => {
  const current = (await api.get('/api/agent-releases')).find((r) => r.isCurrent);
  const created = await api.post('/api/agent-update-jobs', { deviceIds: [device.deviceId] });
  assert.equal(created.created, 1);
  assert.equal(created.targetVersion, current.version);

  const res = await checkin(agent, device.token, snapshot({ hostInfo, collectedAt: minutesAgo(1), available: [U.defender, U.late], pendingReboot: true }));
  assert.ok(res.agentUpdate, 'der Check-in liefert keinen Auftrag aus');
  assert.equal(res.agentUpdate.targetVersion, current.version);
  assert.match(res.agentUpdate.sha256, /^[0-9a-f]{64}$/);

  const binary = await fetch(base + res.agentUpdate.downloadPath, { headers: { authorization: `Bearer ${device.token}` } });
  assert.equal(binary.status, 200);
  await binary.body?.cancel();

  await agent.post('/api/agent/v1/update-result', { jobId: res.agentUpdate.jobId, state: 'done', agentVersion: current.version }, { token: device.token });
  const jobs = await api.get(`/api/agent-update-jobs?deviceId=${device.deviceId}`);
  assert.equal(jobs.find((j) => j.id === res.agentUpdate.jobId)?.state, 'done');
  assert.equal((await api.get(`/api/devices/${device.deviceId}`)).agentVersion, current.version);
  assert.equal((await api.post('/api/agent-update-jobs/cancel-open')).cancelled, 0);
});

// --- Auslieferung des Frontends -------------------------------------------------

await step('Frontend und API-Grenze', async () => {
  for (const path of ['/', '/devices']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /<div id="app">/, path);
  }
  const missing = await fetch(`${base}/api/gibt-es-nicht`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type') ?? '', /json/, 'unbekannter API-Pfad liefert HTML statt JSON');
});

await step('Abmelden', async () => {
  const res = await api.post('/api/auth/logout');
  assert.equal(res.ok, true);
});

finish();
console.log(`Geraet ${HOST} (${device?.deviceId ?? '-'})`);
