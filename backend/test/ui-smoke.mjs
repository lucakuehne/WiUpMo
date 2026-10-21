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
const SETTINGS = ['ad', 'agent', 'releases', 'auth', 'thresholds', 'retention'];

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
    console.log(`    ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`);
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

await step('Geraeteliste', async () => {
  await page.goto(`${base}/devices`);
  await page.locator('table tbody tr').first().waitFor({ timeout: 15_000 });
  await capture(page, 'geraete');
});

await step('Geraetedetail', async () => {
  // Das Geraet mit den meisten offenen Updates zeigt am meisten.
  const list = await (await page.request.get(`${base}/api/devices?sortBy=openUpdates&sortDir=desc&limit=1`)).json();
  if (list.items.length === 0) throw new Error('keine Geraete - lief smoke.mjs vorher?');
  await page.goto(`${base}/devices/${list.items[0].id}`);
  await page.getByText(list.items[0].hostname).first().waitFor({ timeout: 15_000 });
  await capture(page, 'geraet');
});

await step('Updates', async () => {
  await page.goto(`${base}/updates`);
  await page.locator('table').first().waitFor({ timeout: 15_000 });
  await capture(page, 'updates');
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
