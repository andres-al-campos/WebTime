#!/usr/bin/env node
// Drive the Chrome build headless: load dist-chrome/ into Playwright's
// Chromium, open a local page, act like a user on it, and report what the
// extension did. See features/README.md for what each mode proves.
//
//   node scripts/drive.mjs            drive Time tracking + On-page timer
//   node scripts/drive.mjs --doctor   is the stack up? (build present, worker loads, clock verdict)
//   --seconds N                       how long to stay on the page (default 15)
//   --headed                          show the browser window
//   --limit M                         turn session rules on for the page, M-minute sessions
//   --popup                           afterwards, open the popup for the page and print its cards
//   --ext DIR                         extension dir to load (default dist-chrome/)
//
// Chrome only. Firefox has no equivalent here; drive it by hand (web-ext run).

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const doctor = flag('--doctor');
const headed = flag('--headed');
const seconds = Number(opt('--seconds', doctor ? '6' : '15'));
const extDir = resolve(root, opt('--ext', 'dist-chrome'));
const limitMinutes = opt('--limit', null) === null ? null : Number(opt('--limit'));
const popup = flag('--popup');

function fail(what, fix) {
  console.error(`✗ ${what}\n  Fix: ${fix}`);
  process.exitCode = 1;
}

if (!existsSync(join(extDir, 'manifest.json'))) {
  fail(`No built extension at ${extDir}.`, 'run ./build.sh (or npm run build), then try again.');
  process.exit(1);
}

// A page on localhost: trackable (http), needs no network, and its domain is
// "localhost", so it can't collide with a real site's history.
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>WebTime drive</title><p>WebTime drive page</p>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://localhost:${server.address().port}/`;

const profile = mkdtempSync(join(tmpdir(), 'webtime-drive-'));
const verdicts = [];
let context;

try {
  context = await chromium.launchPersistentContext(profile, {
    // 'chromium' is the full browser in new headless mode; the default
    // headless shell cannot load extensions.
    channel: 'chromium',
    headless: !headed,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });

  // Debug builds log every clock transition as "Clock verdict: a -> b".
  context.on('console', (msg) => {
    const m = /Clock verdict: \S+ -> (\S+)/.exec(msg.text());
    if (m) verdicts.push(m[1]);
  });

  let [worker] = context.serviceWorkers();
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => null);
  }
  if (!worker) {
    fail('The extension service worker never started.',
      'check dist-chrome/manifest.json loads in chrome://extensions (Load unpacked) and fix any error it shows.');
    process.exit(1);
  }
  console.log(`✓ worker up: ${worker.url()}`);

  if (limitMinutes !== null) {
    // The worker reads settings when it needs them, so writing them before the
    // page opens is enough; no SETTINGS_UPDATED needed.
    await worker.evaluate((limit) => chrome.storage.local.set({
      webTimeSettings: { global: {}, domains: { localhost: { sessionLimitEnabled: true, sessionLimit: limit } } },
    }), limitMinutes);
    console.log(`  session rules on for localhost: ${limitMinutes}-minute sessions`);
  }

  const page = await context.newPage();
  await page.goto(pageUrl);
  await page.bringToFront();

  // Move the mouse through the stay so the tab counts as engaged. The content
  // script throttles USER_ACTIVE to one per 5s, so every second is plenty.
  for (let s = 0; s < seconds; s++) {
    await page.mouse.move(100 + (s % 2) * 50, 100 + s);
    await page.waitForTimeout(1000);
  }

  const timerText = await page.locator('.web-time-timer').textContent().catch(() => null);
  const timerVisible = await page
    .locator('.web-time-timer:not(.web-time-timer-hidden)').count().catch(() => 0);

  // The worker saves once a minute; read its in-memory total through storage
  // after nudging a save by switching away (a domain switch banks and saves).
  await page.goto('about:blank');
  await page.waitForTimeout(500);
  const stored = await worker.evaluate(async () => {
    const data = await chrome.storage.local.get('trackedTime');
    return data.trackedTime || null;
  });
  const day = stored?.lastDate;
  const localhostSeconds = day ? stored.timeHistory?.[day]?.localhost ?? 0 : 0;

  const popupResult = popup ? await readPopup(context, worker, pageUrl) : null;

  const lastVerdict = verdicts.at(-1) ?? '(none logged; is this a release build?)';
  console.log(`  clock verdicts seen: ${verdicts.join(' → ') || '(none)'}`);
  console.log(`  timer: ${timerVisible ? 'visible' : 'hidden'} "${timerText ?? '(no element)'}"`);
  console.log(`  stored localhost seconds on ${day ?? '(no day)'}: ${localhostSeconds}`);

  if (doctor) {
    console.log(verdicts.includes('running')
      ? '✓ doctor: stack up, clock runs on a tracked page'
      : `✗ doctor: clock never reached "running" (last verdict: ${lastVerdict})`);
    if (!verdicts.includes('running')) process.exitCode = 1;
  } else if (!timerVisible || !timerText) {
    fail('The on-page timer never appeared.',
      'run with --headed and watch the page; check the worker console for errors.');
  } else if (localhostSeconds <= 0) {
    fail(`No time was recorded for localhost (last clock verdict: ${lastVerdict}).`,
      'see the verdict: "unfocused" means run --headed; "os-idle" means touch the keyboard or mouse during the run.');
  } else {
    console.log(`✓ tracked ${localhostSeconds}s on localhost, timer showed "${timerText}"`);
  }
  if (popupResult) {
    console.log(`  popup usage card: ${JSON.stringify(popupResult.usage)}`);
    console.log(`  popup session card: ${JSON.stringify(popupResult.session)}`);
    if (popupResult.errors.length) {
      fail(`The popup threw: ${popupResult.errors.join(' | ')}`,
        'open the popup with --headed and check its console; the first error is usually the cause.');
    } else if (!popupResult.usage) {
      fail('The popup never rendered the site view for localhost.',
        'run with --headed --popup and look at the popup tab; check that popup-init still reads the active tab with tabs.query.');
    } else {
      console.log('✓ popup rendered the site view for localhost');
    }
  }
} finally {
  await context?.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

// The popup opens as an ordinary tab. It picks its site from the active tab,
// which would be itself, so tabs.query is answered with the drive page instead.
async function readPopup(context, worker, pageUrl) {
  const id = new URL(worker.url()).host;
  const popupPage = await context.newPage();
  const errors = [];
  popupPage.on('pageerror', (e) => errors.push(e.message));
  await popupPage.addInitScript((url) => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (q) => (q && q.active) ? [{ id: -1, url, active: true }] : query(q);
  }, pageUrl);
  await popupPage.goto(`chrome-extension://${id}/popup/popup.html`);
  // Both cards render asynchronously from storage.
  await popupPage.waitForFunction(
    () => document.querySelector('#detail-usage-card')?.textContent.trim(),
    null, { timeout: 10_000 }).catch(() => {});
  await popupPage.waitForTimeout(300);
  const text = (sel) => popupPage.locator(sel).innerText().then((t) => t.trim()).catch(() => '');
  const result = { usage: await text('#detail-usage-card'), session: await text('#session-card'), errors };
  await popupPage.close();
  return result;
}
