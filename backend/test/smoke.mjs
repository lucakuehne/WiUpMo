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

/** WU_E_UH_POSTREBOOTSTILLPENDING (0x80242014), vorzeichenbehaftet wie vom Agent. */
const HRESULT_POST_REBOOT = -2145116140;

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

// Nachgereicht aus der Warteschlange: zwei neue Updates, .NET installiert. Das
// spaete Sicherheitsupdate scheitert einmal und bleibt offen — Windows bietet es
// weiter an.
const queued = [
  snapshot({ hostInfo, collectedAt: minutesAgo(30), available: [U.dotnet, U.defender, U.late], pendingReboot: true }),
  snapshot({
    hostInfo,
    collectedAt: minutesAgo(10),
    available: [U.defender, U.late],
    entries: [
      history(U.dotnet, { resultCode: 2, occurredAt: minutesAgo(20) }),
      history(U.late, { resultCode: 4, hresult: HRESULT_FAILED, occurredAt: minutesAgo(15) }),
    ],
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
  assert.deepEqual(failed.attempts, [], 'Versuche nur bei offenen Updates');

  // Offen trotz Fehlversuch: der Versuch steht am Update.
  const late = detail.updates.find((u) => u.kbArticle === U.late.kbArticle);
  assert.equal(late.hresult, HRESULT_FAILED);
  assert.equal(late.attempts.length, 1);
  assert.equal(late.attempts[0].succeeded, false);
  assert.equal(late.attempts[0].hresult, HRESULT_FAILED);
  assert.equal(detail.updates.find((u) => u.kbArticle === U.defender.kbArticle).attempts.length, 0);
  assert.equal(detail.checkins.length, 4);
  assert.equal(detail.agentDiagnostics?.queuedSnapshots, 0);
});

await step('Benutzer und letzter Neustart: neuester Snapshot zaehlt, Suche findet den Benutzer', async () => {
  const name = `USER-${RUN}`;
  const boot = new Date(Date.now() - 3 * 86_400_000).toISOString().replace(/\.\d+Z$/, '.000Z');
  const withUser = (lastLogonUser, lastLogonDisplayName, lastBootAt) =>
    host(name, { lastLogonUser, lastLogonDisplayName, lastBootAt });
  const userDevice = await enroll(agent, enrollmentToken, host(name));
  await checkin(agent, userDevice.token, snapshot({ hostInfo: withUser('TEST\\lena', `Lena ${RUN}`, boot), collectedAt: minutesAgo(3) }));

  // Nachgereicht und aelter: aendert nichts. Ohne Angabe (aelterer Agent): bleibt.
  await checkin(agent, userDevice.token, snapshot({ hostInfo: withUser('TEST\\alt', 'Alt', minutesAgo(600)), collectedAt: minutesAgo(10) }));
  await checkin(agent, userDevice.token, snapshot({ hostInfo: host(name), collectedAt: minutesAgo(2) }));

  const detail = await api.get(`/api/devices/${userDevice.deviceId}`);
  assert.deepEqual([detail.lastLogonUser, detail.lastLogonDisplayName], ['TEST\\lena', `Lena ${RUN}`]);
  assert.equal(detail.lastBootAt, boot);

  const found = await api.get(`/api/devices?search=${encodeURIComponent(`Lena ${RUN}`)}`);
  assert.deepEqual(found.items.map((d) => [d.hostname, d.lastLogonUser]), [[name, 'TEST\\lena']]);

  const csv = await api.request('GET', `/api/devices/export?search=${encodeURIComponent(`Lena ${RUN}`)}`, { raw: true });
  assert.match(csv.data, /Zuletzt angemeldet/);
  assert.ok(csv.data.includes('TEST\\lena'), 'Benutzer fehlt im Export');
});

await step('Zeitreihe', async () => {
  const timeline = await api.get(`/api/devices/${device.deviceId}/timeline`);
  const types = new Set(timeline.items.map((e) => e.eventType));
  for (const type of ['appeared', 'installed', 'failed']) assert.ok(types.has(type), `Ereignis ${type} fehlt`);
});

await step('Historie doppelt gemeldet: jedes Ereignis einmal', async () => {
  // Wie beim Agent, dessen Historienfenster mit dem vorigen ueberlappt: Ein
  // neuer Snapshot bringt die Eintraege des zweiten noch einmal mit.
  const before = (await api.get(`/api/devices/${device.deviceId}/timeline`)).total;
  await checkin(agent, device.token, {
    ...snapshot({ hostInfo, collectedAt: minutesAgo(9), available: [U.defender, U.late], pendingReboot: true }),
    history: second.history,
  });
  assert.equal((await api.get(`/api/devices/${device.deviceId}/timeline`)).total, before);
});

await step('Store-App uebergangen, nebenbei Eingespieltes: keine Installation, Typ aus den installierten', async () => {
  const installedToday = async () =>
    (await api.get('/api/reports/trend?days=1&interval=hour')).reduce((sum, p) => sum + p.installed, 0);
  // Das kritische und das .NET-Update waren offen und wurden installiert.
  const before = await installedToday();
  assert.ok(before >= 2, `${before} Installationen vorher offener Updates`);
  const timeline = (await api.get(`/api/devices/${device.deviceId}/timeline`)).total;

  const storeApp = update({ title: `9NRZT3Q9R3DL-Smoke.${RUN}` });
  const sideways = update({ title: `Nebenbei ${RUN}: Definitionsupdate` });
  await checkin(agent, device.token, {
    ...snapshot({ hostInfo, collectedAt: minutesAgo(8.5), available: [U.defender, U.late], pendingReboot: true }),
    history: [
      history(storeApp, { resultCode: 2, occurredAt: minutesAgo(8.7) }),
      history(sideways, { resultCode: 2, occurredAt: minutesAgo(8.6) }),
    ],
  });

  // Die Store-App kommt weder in den Katalog noch in den Verlauf; das nebenbei
  // eingespielte Update schon, nur ohne Installation im Dashboard.
  assert.equal((await api.get(`/api/updates?search=Smoke.${RUN}`)).total, 0);
  assert.equal((await api.get(`/api/updates?search=${encodeURIComponent(`Nebenbei ${RUN}`)}`)).total, 1);
  assert.equal((await api.get(`/api/devices/${device.deviceId}/timeline`)).total, timeline + 1);
  assert.equal(await installedToday(), before, 'nie offenes Update als Installation gezaehlt');

  // Agents ab 0.8.2 melden die installierten Updates mit Typ: Der Katalog
  // bekommt ihn nachgetragen, Zustand und Verlauf des Geraets bleiben.
  const listed = async () => (await api.get(`/api/updates?search=${encodeURIComponent(`Nebenbei ${RUN}`)}`)).items[0];
  assert.equal((await listed()).classification, 'other');
  await checkin(agent, device.token, {
    ...snapshot({ hostInfo, collectedAt: minutesAgo(8.4), available: [U.defender, U.late], pendingReboot: true }),
    installedUpdates: [{ ...sideways, categories: ['Definition Updates'] }, storeApp],
  });
  assert.equal((await listed()).classification, 'definition');
  assert.equal((await api.get(`/api/updates?search=Smoke.${RUN}`)).total, 0);
  assert.equal((await api.get(`/api/devices/${device.deviceId}/timeline`)).total, timeline + 1);
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

await step('Update-Katalog: Typ, Einstufung, Zustand, Detail, Export', async () => {
  // Die fuenf Updates dieses Laufs: kritisch und .NET installiert, das
  // Qualitaetsupdate gescheitert, Definition und spaetes Sicherheitsupdate offen.
  const search = encodeURIComponent(`Smoke ${RUN}`);
  const titles = (page) => page.items.map((u) => u.title).sort();

  const all = await api.get(`/api/updates?search=${search}&limit=50`);
  assert.equal(all.total, 5);
  const byTitle = Object.fromEntries(all.items.map((u) => [u.title, u]));
  assert.deepEqual(
    [U.critical, U.defender, U.quality].map((u) => byTitle[u.title].classification),
    ['security', 'definition', 'updates'],
  );

  // Je Typ, alle Typen in fester Reihenfolge — der Typfilter selbst zaehlt nicht mit.
  const types = await api.get(`/api/updates/classifications?search=${search}&classification=drivers`);
  assert.equal(types[0].classification, 'security');
  const counts = Object.fromEntries(types.map((t) => [t.classification, t.updates]));
  assert.deepEqual([counts.security, counts.definition, counts.updates, counts.drivers], [3, 1, 1, 0]);

  const security = await api.get(`/api/updates?search=${search}&classification=security&sortBy=classification`);
  assert.equal(security.total, 3);

  assert.deepEqual(titles(await api.get(`/api/updates?search=${search}&state=open`)), [U.defender.title, U.late.title].sort());
  assert.deepEqual(titles(await api.get(`/api/updates?search=${search}&state=failed`)), [U.quality.title]);
  const closed = await api.get(`/api/updates?search=${search}&state=closed`);
  assert.deepEqual(titles(closed), [U.critical.title, U.quality.title, U.dotnet.title].sort());
  const openTypes = await api.get(`/api/updates/classifications?search=${search}&state=open`);
  assert.deepEqual(openTypes.filter((t) => t.updates > 0).map((t) => [t.classification, t.updates]), [['security', 1], ['definition', 1]]);

  assert.deepEqual(titles(await api.get(`/api/updates?search=${search}&severity=critical`)), [U.critical.title]);
  assert.deepEqual(titles(await api.get(`/api/updates?search=${search}&severity=none`)), [U.quality.title, U.defender.title].sort());

  const detail = await api.get(`/api/updates/${byTitle[U.late.title].id}`);
  assert.deepEqual([detail.kbArticle, detail.classification, detail.affectedDevices], [U.late.kbArticle, 'security', 1]);
  await api.request('GET', '/api/updates/00000000-0000-4000-8000-000000000000', { expect: 404 });

  const csv = await api.request('GET', `/api/updates/export?search=${search}&state=open`, { raw: true });
  assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
  assert.ok(csv.data.includes(U.late.title) && csv.data.includes('Sicherheitsupdates'));
  assert.ok(!csv.data.includes(U.critical.title), 'der Export haelt sich nicht an den Filter');

  await api.request('GET', '/api/updates?state=irgendwas', { expect: 400 });
  await api.request('GET', '/api/updates?classification=irgendwas', { expect: 400 });
  await api.request('GET', '/api/updates?onlyOpen=true', { expect: 400 });
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

  const versions = await api.get('/api/reports/agent-version-trend?days=7');
  const today = versions.at(-1)?.date;
  assert.ok(
    versions.some((p) => p.date === today && p.version === AGENT_VERSION && p.devices >= 1),
    'die Version des Testgeraets fehlt im Versionsverlauf',
  );

  const sourceTrend = await api.get('/api/reports/update-source-trend?days=7');
  assert.ok(
    sourceTrend.some((p) => p.date === today && p.source === 'wsus' && p.devices >= 1),
    'die Quelle des Testgeraets fehlt im Quellenverlauf',
  );
});

await step('Verlaeufe stuendlich und woechentlich', async () => {
  // Stuendlich: 24 Abschnitte, als Zeitpunkte, der letzte ist die laufende Stunde.
  const hourly = await api.get('/api/reports/trend?days=1&interval=hour');
  assert.equal(hourly.length, 24);
  assert.match(hourly.at(-1).date, /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/);
  assert.equal(new Date(hourly.at(-1).date).getTime(), new Date().setUTCMinutes(0, 0, 0));

  // Die Versionen der laufenden Stunde enthalten das Testgeraet.
  const versions = await api.get('/api/reports/agent-version-trend?days=1&interval=hour');
  assert.ok(versions.some((p) => p.date === hourly.at(-1).date && p.version === AGENT_VERSION));

  // Woechentlich: Abschnitte beginnen am Montag. Es kommen nur Wochen, in
  // denen es schon Geraete gab — im frischen Test-Stack meist nur die laufende.
  const weekly = await api.get('/api/reports/agent-trend?days=30&interval=week');
  assert.ok(weekly.length >= 1 && weekly.length <= 5, `${weekly.length} Wochen`);
  assert.ok(weekly.every((p) => new Date(`${p.date}T00:00:00Z`).getUTCDay() === 1), 'Woche beginnt nicht am Montag');
  assert.ok(weekly.at(-1).activeAgents >= 1);

  const sourcesWeekly = await api.get('/api/reports/update-source-trend?days=30&interval=week');
  assert.ok(sourcesWeekly.some((p) => p.source === 'wsus'));

  // Stuendlich ueber 14 Tage lehnt das Backend ab.
  await api.request('GET', '/api/reports/trend?days=30&interval=hour', { expect: 400 });
  await api.request('GET', '/api/reports/trend?days=7&interval=monat', { expect: 400 });
});

// --- Einstellungen --------------------------------------------------------------

await step('Melde-Intervall: Vorgabe 5 Minuten, geht mit dem Check-in an den Agent', async () => {
  // Die Instanz im Test-Stack ist frisch, es gilt also die Vorgabe.
  const before = (await api.get('/api/settings')).agent.checkIntervalMinutes;
  assert.equal(before, 5, 'Vorgabe des Melde-Intervalls');
  const current = () => snapshot({ hostInfo, collectedAt: minutesAgo(5), available: [U.defender, U.late], pendingReboot: true });

  await api.put('/api/settings/agent', { checkIntervalMinutes: 45 });
  assert.equal((await checkin(agent, device.token, current())).checkIntervalMinutes, 45);

  // Zwei Minuten bekommen nur Agents ab 0.8.1; aeltere bleiben bei fuenf. Der
  // aeltere Snapshot aendert am Geraet nichts — er ist nicht der juengste.
  await api.put('/api/settings/agent', { checkIntervalMinutes: 2 });
  assert.equal((await checkin(agent, device.token, current())).checkIntervalMinutes, 2);
  const legacy = { ...snapshot({ hostInfo, collectedAt: minutesAgo(6), available: [U.defender, U.late], pendingReboot: true }), agentVersion: '0.8.0' };
  assert.equal((await checkin(agent, device.token, legacy)).checkIntervalMinutes, 5);

  await api.put('/api/settings/agent', { checkIntervalMinutes: before });
  await api.request('PUT', '/api/settings/agent', { body: { checkIntervalMinutes: 1 }, expect: 400 });
});

await step('Gemerkter Zeitraum des Dashboards, je Benutzer', async () => {
  assert.deepEqual(await api.get('/api/preferences'), { dashboard: null });

  const saved = await api.put('/api/preferences', { dashboard: { rangeDays: 30, interval: 'week' } });
  assert.deepEqual(saved.dashboard, { rangeDays: 30, interval: 'week' });
  assert.deepEqual((await api.get('/api/preferences')).dashboard, { rangeDays: 30, interval: 'week' });

  // Ohne Abschnitt bleibt alles, wie es ist; Unbekanntes lehnt das Backend ab.
  assert.deepEqual((await api.put('/api/preferences', {})).dashboard, { rangeDays: 30, interval: 'week' });
  await api.request('PUT', '/api/preferences', { body: { dashboard: { rangeDays: 5, interval: 'day' } }, expect: 400 });
  await api.request('PUT', '/api/preferences', { body: { dashboard: { rangeDays: 7, interval: 'monat' } }, expect: 400 });
  await api.request('PUT', '/api/preferences', { body: { farbe: 'blau' }, expect: 400 });
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

await step('Loeschen: nur archivierte, samt Historie, Agent danach abgemeldet', async () => {
  const name = `DEL-${RUN}`;
  const other = await enroll(agent, enrollmentToken, host(name));
  await checkin(agent, other.token, snapshot({ hostInfo: host(name), collectedAt: minutesAgo(1), available: [U.defender] }));

  await api.request('DELETE', `/api/devices/${other.deviceId}`, { expect: 409 });
  await api.post(`/api/devices/${other.deviceId}/archive`, { reason: 'Smoke-Test' });
  await api.request('DELETE', `/api/devices/${other.deviceId}`);

  await api.request('GET', `/api/devices/${other.deviceId}`, { expect: 404 });
  await api.request('DELETE', `/api/devices/${other.deviceId}`, { expect: 404 });
  assert.equal((await api.get(`/api/devices?search=${name}`)).total, 0);
  await checkin(agent, other.token, snapshot({ hostInfo: host(name), collectedAt: minutesAgo(0.5) }), 401);
});

await step('Auswahl: Export und Loeschen mehrerer Geraete', async () => {
  const names = [`BULK-A-${RUN}`, `BULK-B-${RUN}`];
  const ids = [];
  for (const name of names) {
    const enrolled = await enroll(agent, enrollmentToken, host(name));
    await checkin(agent, enrolled.token, snapshot({ hostInfo: host(name), collectedAt: minutesAgo(1) }));
    ids.push(enrolled.deviceId);
  }

  // Genau die Auswahl, nicht mehr: sep-Zeile, Kopfzeile und drei Geraete.
  const csv = await api.request('POST', '/api/devices/export', { body: { ids: [...ids, device.deviceId] }, raw: true });
  for (const name of [...names, HOST]) assert.ok(csv.data.includes(name), `${name} fehlt im Export`);
  assert.equal(csv.data.trim().split(/\r?\n/).length, 5);

  // Nur das archivierte wird geloescht, das aktive bleibt.
  await api.post(`/api/devices/${ids[0]}/archive`, { reason: 'Smoke-Test' });
  assert.deepEqual(await api.post('/api/devices/delete', { ids }), { deleted: 1, skipped: 1 });
  await api.request('GET', `/api/devices/${ids[0]}`, { expect: 404 });
  await api.get(`/api/devices/${ids[1]}`);
  await api.request('POST', '/api/devices/delete', { body: { ids: [] }, expect: 400 });
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
  assert.equal(created.skipped, 0, 'das gerade beauftragte Geraet zaehlt als uebergangen');
  assert.equal(created.targetVersion, current.version);
  assert.match(created.rolloutId ?? '', UUID);

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

  // Das Ausrollen dazu: eine Auswahl von einem Geraet, erledigt.
  const rollout = (await api.get('/api/agent-rollouts?limit=5')).items.find((r) => r.id === created.rolloutId);
  assert.ok(rollout, 'das Ausrollen fehlt in der Liste');
  assert.deepEqual(
    [rollout.scope, rollout.requestedDevices, rollout.devices, rollout.states.done, rollout.createdBy, rollout.targetVersion],
    ['selected', 1, 1, 1, ADMIN.username, current.version],
  );
  const rolloutJobs = await api.get(`/api/agent-rollouts/${created.rolloutId}/jobs`);
  assert.deepEqual(rolloutJobs.map((j) => [j.hostname, j.rolloutId]), [[HOST, created.rolloutId]]);
});

await step('Ausrollen: uebergangene Geraete, Abbruch zaehlt nicht als gescheitert', async () => {
  // Ein Geraet mit altem Agent; das Testgeraet ist schon aktuell und faellt heraus.
  const old = (
    await agent.request('POST', '/api/agent/v1/enroll', {
      body: { enrollmentToken, host: host(`ROLL-${RUN}`), agentVersion: '0.6.3' },
    })
  ).data;
  const first = await api.post('/api/agent-update-jobs', { deviceIds: [old.deviceId, device.deviceId] });
  assert.deepEqual([first.created, first.skipped], [1, 0]);

  // Ein zweites Mal: schon ein Auftrag offen, also kein neues Ausrollen.
  const again = await api.post('/api/agent-update-jobs', { deviceIds: [old.deviceId] });
  assert.deepEqual([again.created, again.skipped, again.rolloutId], [0, 1, null]);

  assert.deepEqual(await api.post(`/api/agent-rollouts/${first.rolloutId}/cancel`), { cancelled: 1 });
  const rollout = (await api.get('/api/agent-rollouts?limit=5')).items[0];
  assert.equal(rollout.id, first.rolloutId);
  assert.deepEqual([rollout.requestedDevices, rollout.states.cancelled, rollout.states.failed], [2, 1, 0]);

  await api.request('GET', '/api/agent-rollouts/00000000-0000-4000-8000-000000000000/jobs', { expect: 404 });
  await api.request('GET', '/api/agent-rollouts?limit=500', { expect: 400 });
});

// --- Installationsauftraege -----------------------------------------------------
// Der Test spielt den Agent ab 0.7.0: Er holt den Auftrag beim Check-in ab und
// meldet Start und Ergebnis. Eigene Geraete, damit das Selbst-Update oben die
// gemeldete Version nicht verschiebt.

const installHost = host(`INST-${RUN}`);
const secondHost = host(`INST2-${RUN}`);
let installDevice = null;
let secondDevice = null;
let lateCatalogId = '';

const installJobs = async (deviceId) => api.get(`/api/install-jobs?deviceId=${deviceId}`);
let allTypes = [];

await step('Installationsauftrag: angelegt, ausgeliefert, zurueckgemeldet', async () => {
  installDevice = await enroll(agent, enrollmentToken, installHost);
  await checkin(agent, installDevice.token, snapshot({ hostInfo: installHost, collectedAt: minutesAgo(3), available: [U.late, U.defender] }));
  lateCatalogId = (await api.get(`/api/updates?search=${U.late.kbArticle}`)).items[0].id;

  // Vorschau: alle Typen in fester Reihenfolge, gezaehlt wird nur, was offen ist.
  const preview = await api.post('/api/install-jobs/preview', { deviceIds: [installDevice.deviceId] });
  allTypes = preview.classifications.map((c) => c.classification);
  assert.equal(allTypes[0], 'security');
  assert.equal(allTypes.at(-1), 'other');
  const counts = Object.fromEntries(preview.classifications.map((c) => [c.classification, [c.updates, c.devices]]));
  assert.deepEqual([counts.security, counts.definition, counts.drivers], [[1, 1], [1, 1], [0, 0]]);

  const created = await api.post('/api/install-jobs', { deviceIds: [installDevice.deviceId], scope: 'selected', updateIds: [lateCatalogId] });
  assert.equal(created.created, 1);
  assert.match(created.installationId ?? '', UUID);
  assert.equal(created.expiryDays, 14, 'Vorgabe der Frist');
  const again = await api.post('/api/install-jobs', { deviceIds: [installDevice.deviceId], scope: 'types', classifications: allTypes });
  assert.deepEqual([again.created, again.skipped.openJob, again.installationId], [0, 1, null]);

  // Ausgeliefert, und bis zum Start bei jedem Check-in erneut.
  const first = await checkin(agent, installDevice.token, snapshot({ hostInfo: installHost, collectedAt: minutesAgo(2), available: [U.late, U.defender] }));
  assert.deepEqual(first.installRequest?.updateIds, [U.late.updateId]);
  const repeat = await checkin(agent, installDevice.token, snapshot({ hostInfo: installHost, collectedAt: minutesAgo(1.5), available: [U.late, U.defender] }));
  assert.equal(repeat.installRequest?.jobId, first.installRequest.jobId);

  const jobId = first.installRequest.jobId;
  await agent.post('/api/agent/v1/install-result', { jobId, state: 'running' }, { token: installDevice.token });
  const running = await checkin(agent, installDevice.token, snapshot({ hostInfo: installHost, collectedAt: minutesAgo(1), available: [U.late, U.defender] }));
  assert.equal(running.installRequest, null, 'ein laufender Auftrag geht nicht noch einmal hinaus');

  await agent.post(
    '/api/agent/v1/install-result',
    { jobId, state: 'done', results: [{ updateId: U.late.updateId, offered: true, resultCode: 2, hresult: 0, rebootRequired: true }] },
    { token: installDevice.token },
  );
  const [job] = await installJobs(installDevice.deviceId);
  assert.equal(job.state, 'done');
  assert.equal(job.createdBy, ADMIN.username);
  assert.equal(job.selectedCount, 1);
  assert.equal(job.results[0].kbArticle, U.late.kbArticle);
  assert.match(job.results[0].title, /Spaetes Sicherheitsupdate/);
  assert.equal(job.results[0].rebootRequired, true);

  // Fremde Auftraege kann ein Geraet nicht abschliessen.
  await agent.request('POST', '/api/agent/v1/install-result', { body: { jobId, state: 'failed' }, token: device.token, expect: 404 });
});

await step('Installationsauftrag: Zeitpunkt, Frist aus den Einstellungen, Abbruch', async () => {
  await api.put('/api/settings/install', { expiryDays: 3 });
  assert.equal((await api.get('/api/settings')).install.expiryDays, 3);
  await api.request('PUT', '/api/settings/install', { body: { expiryDays: 0 }, expect: 400 });

  const notBefore = new Date(Date.now() + 2 * 3_600_000).toISOString();
  const created = await api.post('/api/install-jobs', { deviceIds: [installDevice.deviceId], scope: 'types', classifications: allTypes, notBefore });
  assert.deepEqual([created.created, created.expiryDays], [1, 3]);

  const early = await checkin(agent, installDevice.token, snapshot({ hostInfo: installHost, collectedAt: minutesAgo(0.8), available: [U.late, U.defender] }));
  assert.equal(early.installRequest, null, 'vor dem Zeitpunkt nicht ausgeliefert');

  const [job] = await installJobs(installDevice.deviceId);
  assert.equal(job.state, 'pending');
  assert.equal(new Date(job.notBefore).toISOString(), notBefore, 'ein einzelnes Geraet wird nicht gestreut');
  assert.equal(new Date(job.expiresAt) - new Date(job.notBefore), 3 * 86_400_000);

  await api.post(`/api/install-jobs/${job.id}/cancel`);
  assert.equal((await installJobs(installDevice.deviceId))[0].state, 'cancelled');
  await api.request('POST', `/api/install-jobs/${job.id}/cancel`, { expect: 409 });
  await api.put('/api/settings/install', { expiryDays: 14 });
});

await step('Installationsauftrag: Streuung, uebergangene Geraete', async () => {
  secondDevice = await enroll(agent, enrollmentToken, secondHost);
  await checkin(agent, secondDevice.token, snapshot({ hostInfo: secondHost, collectedAt: minutesAgo(1), available: [U.defender] }));

  // Ein alter Agent: registriert mit 0.6.3, ohne dass ein Check-in die Version ueberschreibt.
  const old = (
    await agent.request('POST', '/api/agent/v1/enroll', {
      body: { enrollmentToken, host: host(`OLD-${RUN}`), agentVersion: '0.6.3' },
    })
  ).data;

  // Zwei Geraete bekommen einen Auftrag, also wird gestreut; OLD ist zu alt.
  const start = Date.now() + 3_600_000;
  const spread = await api.post('/api/install-jobs', {
    deviceIds: [installDevice.deviceId, secondDevice.deviceId, old.deviceId],
    scope: 'types',
    classifications: allTypes,
    notBefore: new Date(start).toISOString(),
    spreadMinutes: 15,
  });
  assert.equal(spread.created, 2);
  assert.deepEqual(spread.skipped, { openJob: 0, agentTooOld: 1, notEligible: 0, nothingOpen: 0 });
  assert.equal(spread.minimumAgentVersion, '0.7.0');

  for (const id of [installDevice.deviceId, secondDevice.deviceId]) {
    const [job] = await installJobs(id);
    const offset = new Date(job.notBefore).getTime() - start;
    assert.ok(offset >= 0 && offset <= 15 * 60_000, `Start ${offset / 60_000} min nach dem Zeitpunkt`);
    await api.post(`/api/install-jobs/${job.id}/cancel`);
  }

  // Nur Sicherheitsupdates: INST hat eines offen, INST2 nur eine Definition.
  const security = await api.post('/api/install-jobs', {
    deviceIds: [installDevice.deviceId, secondDevice.deviceId],
    scope: 'types',
    classifications: ['security'],
    notBefore: new Date(start).toISOString(),
  });
  assert.deepEqual([security.created, security.skipped.nothingOpen], [1, 1]);
  await api.post(`/api/install-jobs/${(await installJobs(installDevice.deviceId))[0].id}/cancel`);

  // Faellig, nach Typ: beim Check-in gegen die Verfuegbar-Liste aufgeloest.
  // INST hat ein Sicherheits- und ein Definitionsupdate offen, nur Letzteres passt.
  await api.post('/api/install-jobs', { deviceIds: [installDevice.deviceId], scope: 'types', classifications: ['definition', 'drivers'] });
  const due = await checkin(agent, installDevice.token, snapshot({ hostInfo: installHost, collectedAt: minutesAgo(0.5), available: [U.late, U.defender] }));
  assert.deepEqual(due.installRequest?.updateIds, [U.defender.updateId]);
  await api.post(`/api/install-jobs/${due.installRequest.jobId}/cancel`);

  const drivers = await api.post('/api/install-jobs', { deviceIds: [installDevice.deviceId], scope: 'types', classifications: ['drivers'] });
  assert.deepEqual([drivers.created, drivers.skipped.nothingOpen], [0, 1]);

  await api.request('POST', '/api/install-jobs', { body: { deviceIds: [secondDevice.deviceId], scope: 'selected' }, expect: 400 });
  await api.request('POST', '/api/install-jobs', { body: { deviceIds: [secondDevice.deviceId], scope: 'types', classifications: [] }, expect: 400 });
  await api.request('POST', '/api/install-jobs', { body: { deviceIds: [secondDevice.deviceId], scope: 'types', classifications: ['gibt-es-nicht'] }, expect: 400 });
  await api.request('POST', '/api/install-jobs', { body: { deviceIds: [secondDevice.deviceId], scope: 'all' }, expect: 400 });
});

await step('Installationen: zusammengefasst, mit Fortschritt und Abbruch', async () => {
  // Die erste dieses Laufs: ein Geraet, erledigt, mit Neustart.
  const done = (await installJobs(installDevice.deviceId)).find((job) => job.state === 'done' && job.results?.length === 1);
  const listed = await api.get('/api/installations?limit=100');
  const first = listed.items.find((i) => i.id === done.installationId);
  assert.ok(first, 'die erste Installation fehlt in der Liste');
  assert.deepEqual(
    [first.scope, first.selectedCount, first.devices, first.requestedDevices, first.states.done],
    ['selected', 1, 1, 1, 1],
  );
  assert.deepEqual([first.installedUpdates, first.failedUpdates, first.rebootDevices], [1, 0, 1]);
  assert.deepEqual(first.skipped, { openJob: 0, agentTooOld: 0, notEligible: 0, nothingOpen: 0 });
  assert.ok(first.lastCompletedAt);

  // Zwei Geraete und eines, das es nicht gibt; neueste zuerst.
  const notBefore = new Date(Date.now() + 3_600_000).toISOString();
  const created = await api.post('/api/install-jobs', {
    deviceIds: [installDevice.deviceId, secondDevice.deviceId, '00000000-0000-4000-8000-000000000000'],
    scope: 'types',
    classifications: ['security', 'definition'],
    notBefore,
    spreadMinutes: 30,
  });
  assert.equal(created.created, 2);

  const newest = (await api.get('/api/installations?limit=5')).items[0];
  assert.equal(newest.id, created.installationId);
  assert.deepEqual(
    [newest.devices, newest.requestedDevices, newest.states.pending, newest.spreadMinutes, newest.createdBy],
    [2, 3, 2, 30, ADMIN.username],
  );
  assert.deepEqual(newest.classifications, ['security', 'definition']);
  assert.deepEqual(newest.skipped, { openJob: 0, agentTooOld: 0, notEligible: 1, nothingOpen: 0 });
  assert.equal(new Date(newest.notBefore).toISOString(), notBefore);

  const jobs = await api.get(`/api/installations/${created.installationId}/jobs`);
  assert.deepEqual(jobs.map((j) => j.hostname).sort(), [installHost.hostname, secondHost.hostname].sort());
  assert.ok(jobs.every((j) => j.installationId === created.installationId && j.state === 'pending'));

  assert.deepEqual(await api.post(`/api/installations/${created.installationId}/cancel`), { cancelled: 2 });
  assert.deepEqual(await api.post(`/api/installations/${created.installationId}/cancel`), { cancelled: 0 });
  assert.equal((await api.get('/api/installations?limit=5')).items[0].states.cancelled, 2);

  await api.request('GET', '/api/installations/00000000-0000-4000-8000-000000000000/jobs', { expect: 404 });
  await api.request('GET', '/api/installations?limit=500', { expect: 400 });
});

await step('Installationsauftrag: Eingespieltes wartet auf den Neustart', async () => {
  // Bis zum Neustart bietet Windows ein eingespieltes Update weiter an und
  // meldet den Versuch mit 0x80242014. Installieren laesst es sich nicht.
  const rebootHost = host(`REBOOT-${RUN}`);
  const rebootDevice = await enroll(agent, enrollmentToken, rebootHost);
  const installedToday = async () =>
    (await api.get('/api/reports/trend?days=1&interval=hour')).reduce((sum, p) => sum + p.installed, 0);
  const installedBefore = await installedToday();
  await checkin(agent, rebootDevice.token, snapshot({
    hostInfo: rebootHost,
    collectedAt: minutesAgo(2),
    available: [U.late, U.defender],
    entries: [history(U.late, { resultCode: 4, hresult: HRESULT_POST_REBOOT, occurredAt: minutesAgo(3) })],
    pendingReboot: true,
  }));

  // Der Eintrag mit 0x80242014 ist keine weitere Installation im Verlauf.
  assert.equal(await installedToday(), installedBefore, 'Warten auf den Neustart als Installation gezaehlt');

  const detail = await api.get(`/api/devices/${rebootDevice.deviceId}`);
  const byKb = Object.fromEntries(detail.updates.map((u) => [u.kbArticle, u]));
  assert.deepEqual([byKb[U.late.kbArticle].state, byKb[U.late.kbArticle].awaitingReboot], ['available', true]);
  assert.equal(byKb[U.defender.kbArticle].awaitingReboot, false);

  // Die Vorschau zaehlt es nicht, ausdruecklich gewaehlt passt es nicht, und
  // ein Auftrag ueber alle Typen bekommt nur das Uebrige.
  const preview = await api.post('/api/install-jobs/preview', { deviceIds: [rebootDevice.deviceId] });
  const counts = Object.fromEntries(preview.classifications.map((c) => [c.classification, c.updates]));
  assert.deepEqual([counts.security, counts.definition], [0, 1]);

  const selected = await api.post('/api/install-jobs', { deviceIds: [rebootDevice.deviceId], scope: 'selected', updateIds: [lateCatalogId] });
  assert.deepEqual([selected.created, selected.skipped.nothingOpen], [0, 1]);

  await api.post('/api/install-jobs', { deviceIds: [rebootDevice.deviceId], scope: 'types', classifications: allTypes });
  const due = await checkin(agent, rebootDevice.token, snapshot({ hostInfo: rebootHost, collectedAt: minutesAgo(1), available: [U.late, U.defender], pendingReboot: true }));
  assert.deepEqual(due.installRequest?.updateIds, [U.defender.updateId]);
  await api.post(`/api/install-jobs/${due.installRequest.jobId}/cancel`);
});

await step('Agent-Zustand: Protokoll ueber zwei Check-ins (fuer ui-smoke)', async () => {
  // In den Agent-Zustand gehoert nur die neue Warnung: Die alte stammt von vor
  // dem vorletzten Check-in, die gescheiterte Uebermittlung hat der Check-in
  // selbst erledigt. Die alte steht in Ortszeit mit Versatz, wie Serilog sie
  // schreibt — als Text verglichen laege sie spaeter als der Check-in.
  const inPlusTwo = (iso) => new Date(new Date(iso).getTime() + 2 * 3_600_000).toISOString().replace('Z', '+02:00');
  const logHost = host(`AGENTLOG-${RUN}`);
  const logDevice = await enroll(agent, enrollmentToken, logHost);
  await checkin(agent, logDevice.token, snapshot({ hostInfo: logHost, collectedAt: minutesAgo(20) }));

  const latest = snapshot({ hostInfo: logHost, collectedAt: minutesAgo(5) });
  latest.diagnostics.recentLogs = [
    { at: inPlusTwo(minutesAgo(30)), level: 'warning', message: 'Alte Warnung aus dem Smoke-Test' },
    { at: minutesAgo(15), level: 'warning', message: 'Uebermittlung fehlgeschlagen, 1 Snapshots bleiben in der Warteschlange: Testfehler' },
    { at: minutesAgo(12), level: 'warning', message: 'Neue Warnung aus dem Smoke-Test' },
  ];
  await checkin(agent, logDevice.token, latest);

  const detail = await api.get(`/api/devices/${logDevice.deviceId}`);
  assert.equal(detail.checkins.length, 2);
  assert.equal(detail.agentDiagnostics.recentLogs.length, 3);
});

await step('Stoerungen der Agents, nach Meldung zusammengefasst', async () => {
  const problems = await api.get('/api/agent-problems?days=1');
  const byKey = Object.fromEntries(problems.map((p) => [p.key, p]));

  // Jeder Snapshot der Tests traegt diesen Eintrag; alle Geraete fallen zusammen.
  const common = byKey['Testeintrag aus dem Smoke-Test'];
  assert.ok(common && common.devices >= 3, `${common?.devices} Geraete mit dem Testeintrag`);
  assert.equal(common.level, 'warning');
  assert.equal(common.entries.length, common.devices);

  const fresh = byKey['Neue Warnung aus dem Smoke-Test'];
  assert.deepEqual(fresh?.entries.map((e) => e.hostname), [`AGENTLOG-${RUN}`]);
  assert.ok(!problems.some((p) => p.key.startsWith('Uebermittlung fehlgeschlagen')), 'Uebermittlungsfehler als Stoerung');

  await api.request('GET', '/api/agent-problems?days=3', { expect: 400 });
});

// --- Neustarts -------------------------------------------------------------------

await step('Neustart-Regeln in den Einstellungen', async () => {
  const defaults = (await api.get('/api/settings')).restart;
  assert.deepEqual(
    [defaults.deferralMinutes, defaults.nextMorningHour, defaults.maxDeferrals, defaults.deadlineHours, defaults.countdownMinutes],
    [[60, 240], 8, 3, 24, 10],
  );

  // Sortiert, ohne Doppel, Text getrimmt; nicht Gesendetes bleibt.
  const saved = await api.put('/api/settings/restart', { maxDeferrals: 2, message: '  Service Desk  ', deferralMinutes: [240, 60, 60] });
  assert.deepEqual([saved.maxDeferrals, saved.message, saved.deferralMinutes, saved.deadlineHours], [2, 'Service Desk', [60, 240], 24]);
  assert.equal((await api.put('/api/settings/restart', { nextMorningHour: null })).nextMorningHour, null);
  await api.put('/api/settings/restart', { nextMorningHour: 8 });

  await api.request('PUT', '/api/settings/restart', { body: { deadlineHours: 0 }, expect: 400 });
  await api.request('PUT', '/api/settings/restart', { body: { deferralMinutes: [1] }, expect: 400 });
  await api.request('PUT', '/api/settings/restart', { body: { nextMorningHour: 24 }, expect: 400 });
});

await step('Neustart: angefordert, gemeldet, verschoben, durch den Systemstart erledigt', async () => {
  // Ein Server und ein Agent vor 0.9.0 werden uebergangen.
  const serverHost = host(`SRV-${RUN}`, { osName: 'Windows Server 2022 Standard' });
  const server = await enroll(agent, enrollmentToken, serverHost);
  await checkin(agent, server.token, snapshot({ hostInfo: serverHost, collectedAt: minutesAgo(1) }));
  const old = (
    await agent.request('POST', '/api/agent/v1/enroll', {
      body: { enrollmentToken, host: host(`OLDR-${RUN}`), agentVersion: '0.8.2' },
    })
  ).data;

  const created = await api.post('/api/restart-jobs', {
    deviceIds: [device.deviceId, server.deviceId, old.deviceId],
    reason: 'Updates abschliessen',
  });
  assert.equal(created.created, 1);
  assert.deepEqual(created.skipped, { openJob: 0, agentTooOld: 1, server: 1, notEligible: 0 });
  assert.equal(created.minimumAgentVersion, '0.9.0');
  const again = await api.post('/api/restart-jobs', { deviceIds: [device.deviceId] });
  assert.deepEqual([again.created, again.skipped.openJob, again.requestId], [0, 1, null]);

  // Beim Check-in, mit den Regeln zum Zeitpunkt des Anlegens.
  const current = (minutes, extra = {}) =>
    snapshot({ hostInfo: { ...hostInfo, ...extra }, collectedAt: minutesAgo(minutes), available: [U.defender, U.late], pendingReboot: true });
  const delivered = (await checkin(agent, device.token, current(0.5))).restartRequest;
  assert.equal(delivered?.reason, 'Updates abschliessen');
  assert.deepEqual(
    [delivered.maxDeferrals, delivered.message, delivered.deferralMinutes, delivered.nextMorningHour, delivered.deadlineHours, delivered.countdownMinutes],
    [2, 'Service Desk', [60, 240], 8, 24, 10],
  );

  // Gemeldet und verschoben, von einem Benutzer; fremde Geraete schliessen ihn nicht.
  const jobId = delivered.jobId;
  const deadlineAt = new Date(Date.now() + 24 * 3_600_000).toISOString();
  await agent.post('/api/agent/v1/restart-result', { jobId, state: 'notified', deadlineAt, deferrals: 0, user: 'TEST\\lena' }, { token: device.token });
  const until = new Date(Date.now() + 3_600_000).toISOString();
  await agent.post('/api/agent/v1/restart-result', { jobId, state: 'deferred', deferredUntil: until, deferrals: 1, user: 'TEST\\lena' }, { token: device.token });
  await agent.request('POST', '/api/agent/v1/restart-result', { body: { jobId, state: 'restarting' }, token: server.token, expect: 404 });

  const [deferred] = await api.get(`/api/restart-jobs?deviceId=${device.deviceId}`);
  assert.deepEqual([deferred.state, deferred.deferrals, deferred.lastUser], ['deferred', 1, 'TEST\\lena']);
  assert.equal(new Date(deferred.deferredUntil).toISOString(), until);
  assert.equal(new Date(deferred.deadlineAt).toISOString(), deadlineAt);
  assert.deepEqual(deferred.events.map((e) => e.state), ['delivered', 'notified', 'deferred']);

  // Bis zum Einleiten geht er weiter mit, danach nicht mehr.
  assert.equal((await checkin(agent, device.token, current(0.4))).restartRequest?.jobId, jobId);
  const restartingAt = new Date(Date.now() - 60_000).toISOString();
  await agent.post('/api/agent/v1/restart-result', { jobId, state: 'restarting', at: restartingAt, user: 'TEST\\lena', note: 'vom Benutzer bestaetigt' }, { token: device.token });
  assert.equal((await checkin(agent, device.token, current(0.3))).restartRequest, null);
  assert.equal((await api.get(`/api/restart-jobs?deviceId=${device.deviceId}`))[0].state, 'restarting');

  // Erledigt erst mit einem gemeldeten Systemstart nach dem Einleiten.
  await checkin(agent, device.token, current(0.2, { lastBootAt: new Date().toISOString() }));
  const [done] = await api.get(`/api/restart-jobs?deviceId=${device.deviceId}`);
  assert.equal(done.state, 'done');
  assert.ok(done.completedAt);

  const request = (await api.get('/api/restart-requests?limit=5')).items.find((r) => r.id === created.requestId);
  assert.deepEqual(
    [request.devices, request.requestedDevices, request.states.done, request.deferrals, request.rules.maxDeferrals, request.createdBy],
    [1, 3, 1, 1, 2, ADMIN.username],
  );
  assert.deepEqual(request.skipped, created.skipped);
  const jobs = await api.get(`/api/restart-requests/${created.requestId}/jobs`);
  assert.deepEqual(jobs.map((j) => [j.hostname, j.state]), [[HOST, 'done']]);
});

await step('Neustart abgebrochen: die Meldung entfaellt beim naechsten Check-in', async () => {
  const created = await api.post('/api/restart-jobs', { deviceIds: [device.deviceId] });
  assert.equal(created.created, 1);
  const current = (minutes) =>
    snapshot({ hostInfo, collectedAt: minutesAgo(minutes), available: [U.defender, U.late], pendingReboot: true });
  assert.ok((await checkin(agent, device.token, current(0.15))).restartRequest);

  assert.deepEqual(await api.post(`/api/restart-requests/${created.requestId}/cancel`), { cancelled: 1 });
  assert.deepEqual(await api.post(`/api/restart-requests/${created.requestId}/cancel`), { cancelled: 0 });
  assert.equal((await checkin(agent, device.token, current(0.1))).restartRequest, null);

  const [job] = await api.get(`/api/restart-jobs?deviceId=${device.deviceId}`);
  assert.equal(job.state, 'cancelled');
  await api.request('POST', `/api/restart-jobs/${job.id}/cancel`, { expect: 409 });

  await api.request('GET', '/api/restart-requests/00000000-0000-4000-8000-000000000000/jobs', { expect: 404 });
  await api.request('POST', '/api/restart-jobs', { body: { deviceIds: [] }, expect: 400 });
  await api.request('GET', '/api/restart-requests?limit=500', { expect: 400 });

  await api.put('/api/settings/restart', { maxDeferrals: 3, message: '' });
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
