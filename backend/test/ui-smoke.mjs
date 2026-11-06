/**
 * Prueft die Oberflaeche im Browser und legt Bildschirmfotos ab. Laeuft im
 * Playwright-Container des Test-Stacks (deploy/test-stack.ps1 legt das Skript
 * nach /work, wo das Paket playwright installiert ist).
 *
 *   node ui-smoke.mjs [Basis-URL] [Ausgabeverzeichnis]
 *
 * Am sinnvollsten nach smoke.mjs und ad-smoke.mjs: Dann gibt es Geraete,
 * Updates und Abgleiche, und die Seiten zeigen mehr als leere Tabellen. Auf
 * einer leeren Instanz richtet der Test das Administratorkonto selbst ein.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const [base = 'http://backend:3000', out = '/out'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const USER = process.env.SMOKE_USER ?? 'admin';
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'nur-fuer-den-test-stack';
const SETTINGS = ['ad', 'agent', 'auth', 'operation'];

await mkdir(out, { recursive: true });

const results = [];
const problems = new Set();
let shot = 0;

async function step(name, fn) {
  process.stdout.write(`- ${name} ... `);
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('ok');
  } catch (error) {
    results.push({ name, ok: false });
    console.log('FEHLER');
    // Die erste Zeile nennt nur die Zeitueberschreitung; welcher Locator es
    // war, steht im Protokoll darunter.
    const lines = (error instanceof Error ? error.message : String(error)).split('\n');
    console.log(`    ${lines[0]}`);
    const waiting = lines.find((line) => /waiting for/.test(line));
    if (waiting) console.log(`    ${waiting.trim()}`);
    // `page` gibt es erst nach den ersten Schritten.
    await globalThis.failurePage?.screenshot({ path: join(out, `fehler-${results.length}.png`), fullPage: true }).catch(() => {});
  }
}

/** Ein Foto der ganzen Seite, fortlaufend nummeriert. */
async function capture(page, name) {
  // Diagramme und Uebergaenge zur Ruhe kommen lassen.
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
  shot += 1;
  await page.screenshot({ path: join(out, `${String(shot).padStart(2, '0')}-${name}.png`), fullPage: true });
}

/**
 * Fehler im Browser sammeln. Abgelehnte Anmeldungen (401) gehoeren zum Test
 * und erscheinen in Chromium ebenfalls als Konsolenfehler.
 */
function watch(page, label) {
  page.on('pageerror', (error) => problems.add(`${label}: Seitenfehler ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (/status of 401/.test(message.text())) return;
    problems.add(`${label}: Konsole ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 500) problems.add(`${label}: ${response.status()} ${response.url()}`);
  });
}

async function signIn(page) {
  await page.goto(`${base}/login`);
  await page.locator('#username').fill(USER);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
  // Nach der Anmeldung landet die App auf der Geraeteliste, nicht auf dem
  // Dashboard.
  await page.goto(`${base}/`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'de-CH', colorScheme: 'light' });
const page = await context.newPage();
globalThis.failurePage = page;
watch(page, 'hell');

await step('Einrichtung, falls die Instanz leer ist', async () => {
  const status = await (await page.request.get(`${base}/api/auth/status`)).json();
  if (!status.setupRequired) return;
  await page.goto(`${base}/setup`);
  await capture(page, 'einrichtung');
  await page.locator('#username').fill(USER);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('#repeat').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/setup'));
  await page.context().clearCookies();
});

await step('Anmeldeseite und falsches Passwort', async () => {
  await page.goto(`${base}/login`);
  await page.locator('#username').waitFor();
  await capture(page, 'anmeldung');
  await page.locator('#username').fill(USER);
  await page.locator('#password').fill('falsch');
  await page.locator('button[type="submit"]').click();
  await page.locator('[role="alert"]').first().waitFor({ timeout: 10_000 });
  await capture(page, 'anmeldung-fehler');
});

await step('Anmelden und Dashboard', async () => {
  await signIn(page);
  await capture(page, 'dashboard');
});

await step('Dashboard merkt sich den Zeitraum', async () => {
  // smoke.mjs hat 30 Tage, woechentlich gespeichert.
  const range = page.getByRole('combobox').first();
  await range.filter({ hasText: '30 Tage' }).waitFor({ timeout: 10_000 });
  await page.getByRole('combobox', { name: 'Intervall' }).filter({ hasText: /chentlich/ }).waitFor({ timeout: 5_000 });

  // Gespeichert wird nebenher; erst danach neu laden.
  const saved = page.waitForResponse((res) => res.url().endsWith('/api/preferences') && res.request().method() === 'PUT');
  await range.click();
  await page.getByRole('option', { name: '7 Tage' }).click();
  await saved;
  await page.reload();
  await page.getByRole('combobox').first().filter({ hasText: '7 Tage' }).waitFor({ timeout: 10_000 });
});

await step('Geraeteliste', async () => {
  await page.goto(`${base}/devices`);
  await page.locator('table tbody tr').first().waitFor({ timeout: 15_000 });
  await capture(page, 'geraete');
});

await step('Mehrfachauswahl in der Geraeteliste', async () => {
  await page.getByRole('checkbox', { name: 'Alle Geräte dieser Seite auswählen' }).click();
  await page.getByText(/\d+ ausgewählt/).waitFor({ timeout: 5_000 });
  await capture(page, 'geraete-auswahl');

  // Nur ansehen: Angelegt wird im Geraetedetail.
  await page.getByRole('button', { name: /Offene Updates installieren/ }).click();
  await page.getByRole('dialog').waitFor({ timeout: 5_000 });
  await capture(page, 'geraete-installieren');
  await page.getByRole('dialog').getByRole('button', { name: 'Abbrechen' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 5_000 });

  await page.getByRole('button', { name: 'Auswahl aufheben' }).click();
  await page.getByText(/\d+ ausgewählt/).waitFor({ state: 'detached', timeout: 5_000 });
});

await step('Geraetedetail', async () => {
  // Das Geraet mit den meisten offenen Updates zeigt am meisten.
  const list = await (await page.request.get(`${base}/api/devices?sortBy=openUpdates&sortDir=desc&limit=1`)).json();
  if (list.items.length === 0) throw new Error('keine Geraete - lief smoke.mjs vorher?');
  await page.goto(`${base}/devices/${list.items[0].id}`);
  await page.getByText(list.items[0].hostname).first().waitFor({ timeout: 15_000 });
  await capture(page, 'geraet');

  // Ein offenes Update mit gescheitertem Versuch (aus smoke.mjs) klappt auf.
  const attempts = page.getByRole('button', { name: /Versuch/ }).first();
  if ((await attempts.count()) > 0) {
    await attempts.click();
    await page.getByText('gescheitert', { exact: true }).first().waitFor({ timeout: 5_000 });
    await capture(page, 'geraet-versuche');
  }
});

await step('Installationsauftrag im Geraetedetail', async () => {
  // Das INST-Geraet aus smoke.mjs meldet einen Agent ab 0.7.0; das obige steht
  // nach dem Selbst-Update auf der Version im Image und wuerde uebergangen.
  const list = await (await page.request.get(`${base}/api/devices?search=INST-&sortBy=openUpdates&sortDir=desc&limit=1`)).json();
  if (list.items.length === 0) throw new Error('kein INST-Geraet - lief smoke.mjs vorher?');
  await page.goto(`${base}/devices/${list.items[0].id}`);
  await page.getByText(list.items[0].hostname).first().waitFor({ timeout: 15_000 });

  // Ein Update auswaehlen und einen Auftrag anlegen - es sei denn, ein frueherer
  // Lauf hat schon einen offenen hinterlassen; dann ist der Knopf gesperrt.
  const install = page.getByRole('button', { name: /Installieren …/ });
  if (await install.isEnabled()) {
    await page.locator('table tbody').getByRole('checkbox').first().click();
    await install.click();
    await page.getByRole('dialog').waitFor({ timeout: 5_000 });
    await capture(page, 'geraet-installieren');

    // Umschalten auf die Typen; angelegt wird mit allen.
    await page.getByRole('radio', { name: 'Nach Update-Typ' }).check();
    await page.getByText('Alle Typen').waitFor({ timeout: 5_000 });
    await page.getByText(/\d+ offen/).first().waitFor({ timeout: 5_000 });
    await capture(page, 'geraet-installieren-typen');
    await page.getByRole('button', { name: 'Aufträge anlegen' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 10_000 });
  }
  await page.getByText(/Installationsauftrag|Installation läuft/).first().waitFor({ timeout: 10_000 });
  await capture(page, 'geraet-auftrag');

  await page.getByRole('tab', { name: /Installationen/ }).click();
  await page.locator('table tbody tr').first().waitFor({ timeout: 5_000 });
  await capture(page, 'geraet-installationen');
});

await step('Eingespieltes Update wartet auf den Neustart', async () => {
  const list = await (await page.request.get(`${base}/api/devices?search=REBOOT-&limit=1`)).json();
  if (list.items.length === 0) throw new Error('kein REBOOT-Geraet - lief smoke.mjs vorher?');
  await page.goto(`${base}/devices/${list.items[0].id}`);
  await page.getByText('wartet auf Neustart').first().waitFor({ timeout: 15_000 });

  const row = page.locator('table tbody tr', { hasText: 'wartet auf Neustart' }).first();
  if (!(await row.getByRole('checkbox').isDisabled())) {
    throw new Error('das wartende Update laesst sich auswaehlen');
  }
  await capture(page, 'geraet-wartet-auf-neustart');
});

await step('Agent-Zustand zeigt nur Stoerungen aus dem juengsten Durchlauf', async () => {
  const list = await (await page.request.get(`${base}/api/devices?search=AGENTLOG-&limit=1`)).json();
  if (list.items.length === 0) throw new Error('kein AGENTLOG-Geraet - lief smoke.mjs vorher?');
  await page.goto(`${base}/devices/${list.items[0].id}`);

  // Als Ueberschrift auffindbar heisst auch: Die Kartenteile sind eingebunden.
  const card = page.locator('[data-slot=card]', { has: page.getByRole('heading', { name: 'Agent-Zustand' }) });
  await card.waitFor({ timeout: 15_000 });
  const text = await card.innerText();
  if (!text.includes('Neue Warnung aus dem Smoke-Test')) throw new Error('die neue Warnung fehlt');
  for (const stale of ['Alte Warnung', 'Uebermittlung fehlgeschlagen']) {
    if (text.includes(stale)) throw new Error(`"${stale}" steht im Agent-Zustand`);
  }
  await capture(page, 'geraet-agent-zustand');
});

await step('Updates: offene, alle nach Typ, Detailseite und zurueck', async () => {
  await page.goto(`${base}/updates`);
  await page.locator('table tbody tr').first().waitFor({ timeout: 15_000 });
  // Auch die offenen haben die Typen daneben, gezaehlt wird nur Offenes.
  await page.getByRole('button', { name: /^Sicherheitsupdates/ }).click();
  await page.waitForURL(/\/updates\?.*classification=security/);
  await page.locator('table tbody tr').first().waitFor({ timeout: 15_000 });
  await capture(page, 'updates');

  await page.getByRole('tab', { name: 'Alle Updates' }).click();
  await page.waitForURL(/\/updates\/all/);
  await page.getByRole('button', { name: /^Definitionsupdates/ }).click();
  await page.waitForURL(/classification=definition/);
  await page.locator('table tbody tr', { hasText: 'Definitionsupdate' }).first().waitFor({ timeout: 15_000 });
  await capture(page, 'updates-alle');

  await page.locator('table tbody tr').first().click();
  await page.waitForURL(/\/updates\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { level: 2, name: 'Geräte' }).waitFor({ timeout: 15_000 });
  await capture(page, 'update-detail');

  // Zurueck in dieselbe Auswahl, nicht in die ungefilterte Liste.
  await page.getByRole('button', { name: 'Windows Updates', exact: true }).click();
  await page.waitForURL(/\/updates\/all\?.*classification=definition/);
});

await step('Installationen mit ihren Geraeten', async () => {
  await page.goto(`${base}/updates/installations`);
  const first = page.locator('table tbody tr').first();
  await first.waitFor({ timeout: 15_000 });
  await first.click();
  await page.locator('table table a[href^="/devices/"]').first().waitFor({ timeout: 10_000 });
  await capture(page, 'installationen');
});

await step('Neustarts: Anforderung mit Geraeten, Geraet mit Verlauf und Dialog', async () => {
  await page.goto(`${base}/restarts`);
  const first = page.locator('table tbody tr').first();
  await first.waitFor({ timeout: 15_000 });
  await first.click();
  const deviceLink = page.locator('table table a[href^="/devices/"]').first();
  await deviceLink.waitFor({ timeout: 10_000 });
  await capture(page, 'neustarts');

  // Das Geraet: Verlauf im eigenen Tab, und anfordern laesst sich ein neuer.
  await deviceLink.click();
  await page.getByRole('tab', { name: /^Neustarts/ }).click();
  await page.locator('table tbody tr', { hasText: /neu gestartet|abgebrochen/ }).first().waitFor({ timeout: 10_000 });
  await capture(page, 'geraet-neustarts');

  await page.getByRole('button', { name: 'Neustart anfordern' }).click();
  await page.getByRole('dialog').getByText('Der Benutzer kann').waitFor({ timeout: 10_000 });
  await capture(page, 'geraet-neustart-anfordern');
  await page.getByRole('dialog').getByRole('button', { name: 'Abbrechen' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 5_000 });
});

await step('Agents: Ausrollen mit Geraeten, Versionen, Stoerungen', async () => {
  await page.goto(`${base}/agents`);
  const first = page.locator('table tbody tr').first();
  await first.waitFor({ timeout: 15_000 });
  await first.click();
  await page.locator('table table a[href^="/devices/"]').first().waitFor({ timeout: 10_000 });
  await capture(page, 'agents-updates');

  await page.getByRole('tab', { name: 'Versionen' }).click();
  await page.waitForURL(/\/agents\/versions/);
  await page.getByText('Hinterlegte Versionen').waitFor({ timeout: 10_000 });
  await capture(page, 'agents-versionen');

  await page.getByRole('tab', { name: 'Störungen' }).click();
  await page.waitForURL(/\/agents\/problems/);
  await page.getByText('Testeintrag aus dem Smoke-Test').first().waitFor({ timeout: 10_000 });
  await capture(page, 'agents-stoerungen');

  // Ein altes Lesezeichen auf die Versionen in den Einstellungen findet hierher.
  await page.goto(`${base}/settings/releases`);
  await page.waitForURL(/\/agents\/versions/);
});

await step('Berichte', async () => {
  await page.goto(`${base}/reports`);
  await page.waitForTimeout(1000);
  await capture(page, 'berichte');
});

for (const section of SETTINGS) {
  await step(`Einstellungen: ${section}`, async () => {
    await page.goto(`${base}/settings/${section}`);
    await capture(page, `einstellungen-${section}`);
  });
}

await step('Einstellungen: Schwellwerte und Aufbewahrung stehen unter Betrieb', async () => {
  // Alte Lesezeichen auf die frueheren Abschnitte landen dort.
  for (const old of ['thresholds', 'retention']) {
    await page.goto(`${base}/settings/${old}`);
    for (const title of ['Melde-Intervall', 'Installationsaufträge', 'Neustarts', 'Schwellwerte', 'Aufbewahrung']) {
      await page.getByRole('heading', { name: title, exact: true }).waitFor({ timeout: 10_000 });
    }
  }
});

await step('Dunkles Farbschema', async () => {
  const dark = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'de-CH', colorScheme: 'dark' });
  const darkPage = await dark.newPage();
  watch(darkPage, 'dunkel');
  await signIn(darkPage);
  await capture(darkPage, 'dashboard-dunkel');
  await darkPage.goto(`${base}/devices`);
  await capture(darkPage, 'geraete-dunkel');
  await dark.close();
});

await step('Schmale Ansicht', async () => {
  const narrow = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'de-CH', isMobile: true, hasTouch: true });
  const narrowPage = await narrow.newPage();
  watch(narrowPage, 'schmal');
  await signIn(narrowPage);
  await capture(narrowPage, 'dashboard-schmal');
  await narrowPage.goto(`${base}/devices`);
  await capture(narrowPage, 'geraete-schmal');
  await narrow.close();
});

await browser.close();

await step('Keine Fehler im Browser', async () => {
  if (problems.size > 0) throw new Error([...problems].join('\n'));
});
if (problems.size > 0) for (const problem of problems) console.log(`    ${problem}`);

const failed = results.filter((r) => !r.ok);
console.log(`\nOberflaeche: ${results.length - failed.length} von ${results.length} Pruefungen bestanden, ${shot} Bildschirmfotos in ${out}.`);
if (failed.length > 0) {
  console.log(`Gescheitert: ${failed.map((f) => f.name).join('; ')}`);
  process.exitCode = 1;
}
