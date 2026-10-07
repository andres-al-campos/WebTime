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
//   --cooldown M                      with --limit: cooldown step in minutes (session N waits N × M)
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
const cooldownMinutes = Number(opt('--cooldown', '0'));
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

async function launch() {
  const ctx = await chromium.launchPersistentContext(profile, {
    // 'chromium' is the full browser in new headless mode; the default
    // headless shell cannot load extensions.
    channel: 'chromium',
    headless: !headed,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  let [w] = ctx.serviceWorkers();
  if (!w) w = await ctx.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => null);
  if (!w) {
    await ctx.close();
    fail('The extension service worker never started.',
      'check dist-chrome/manifest.json loads in chrome://extensions (Load unpacked) and fix any error it shows.');
    process.exit(1);
  }
  return [ctx, w];
}

try {
  let worker;
  [context, worker] = await launch();

  // The os-idle gate asks the OS, and synthetic mouse moves don't count as
  // input there, so with the default 30s timeout the clock stops whenever
  // nobody has touched this machine for 30s. Raise it so runs don't depend on that.
  const global = { inactivityTimeoutS: 3600 };
  const domains = limitMinutes === null ? {} : {
    localhost: { sessionLimitEnabled: true, sessionLimit: limitMinutes, cooldownIncrement: cooldownMinutes },
  };
  {
    // Store the settings, then relaunch so the worker boots with them.
    // SETTINGS_UPDATED would apply them but keep the OS idle state read under
    // the old timeout: a person changing settings is active, the harness is
    // not. (chrome.runtime.reload() disables a command-line-loaded extension.)
    await worker.evaluate((v) => chrome.storage.local.set({ webTimeSettings: v }), { global, domains });
    await context.close();
    [context, worker] = await launch();
    if (limitMinutes !== null) {
      console.log(`  session rules on for localhost: ${limitMinutes}-minute sessions, ` +
        `${cooldownMinutes ? `${cooldownMinutes}-minute cooldown step` : 'no cooldown'}`);
    }
  }
  console.log(`✓ worker up: ${worker.url()}`);

  // Debug builds log every clock transition as "Clock verdict: a -> b".
  context.on('console', (msg) => {
    const m = /Clock verdict: \S+ -> (\S+)/.exec(msg.text());
    if (m) verdicts.push(m[1]);
  });

  const page = await context.newPage();
  await page.goto(pageUrl);
  await page.bringToFront();

  // Move the mouse through the stay so the tab counts as engaged. The content
  // script throttles USER_ACTIVE to one per 5s, so every second is plenty.
  // Each second also notes which overlays are up, and logs only the changes.
  const timeline = [];
  let lastOverlays = '';
  for (let s = 0; s < seconds; s++) {
    await page.mouse.move(100 + (s % 2) * 50, 100 + s);
    await page.waitForTimeout(1000);
    const overlays = await readOverlays(page);
    if (overlays !== lastOverlays) {
      timeline.push(`${s + 1}s ${overlays || '(none)'}`);
      lastOverlays = overlays;
    }
  }
  const blockerSeen = timeline.some((t) => t.includes('blocker'));

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
  if (timeline.length) console.log(`  overlays:\n    ${timeline.join('\n    ')}`);
  console.log(`  timer: ${timerVisible ? 'visible' : 'hidden'} "${timerText ?? '(no element)'}"`);
  console.log(`  stored localhost seconds on ${day ?? '(no day)'}: ${localhostSeconds}`);

  if (doctor) {
    console.log(verdicts.includes('running')
      ? '✓ doctor: stack up, clock runs on a tracked page'
      : `✗ doctor: clock never reached "running" (last verdict: ${lastVerdict})`);
    if (!verdicts.includes('running')) process.exitCode = 1;
  } else if (limitMinutes !== null && cooldownMinutes > 0 && seconds > limitMinutes * 60 + 5 && !blockerSeen) {
    fail(`The session was ${limitMinutes} min and the stay ${seconds}s, but no cooldown blocker appeared ` +
      `(last clock verdict: ${lastVerdict}).`,
      verdicts.includes('cooldown')
        ? 'the background did start the cooldown, so the page never showed it: check SHOW_BLOCKER handling in content.ts.'
        : 'check the stored seconds above reached the limit; if they did, the session-end path in background.ts did not fire.');
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

// The page's own overlays, summarized in one line: blocker text, wind-down
// darkness, average popup, nudge blur. Read from the page, not from messages,
// so what's reported is what a user would see.
function readOverlays(page) {
  return page.evaluate(() => {
    const out = [];
    const blocker = document.querySelector('.web-time-blocker-overlay');
    if (blocker) {
      // Without the live countdown, so the timeline logs the blocker once.
      const clone = blocker.cloneNode(true);
      clone.querySelector('.web-time-blocker-countdown')?.remove();
      const lines = [...clone.querySelectorAll('*')].filter((e) => !e.children.length).map((e) => e.textContent.trim());
      out.push(`blocker "${lines.filter(Boolean).join(' / ')}"`);
    }
    const wind = document.querySelector('.web-time-wind-down-overlay');
    if (wind && wind.style.visibility !== 'hidden') {
      const alpha = /rgba\([^)]*,\s*([\d.]+)\)/.exec(wind.style.background)?.[1];
      // In 10% steps, so the timeline logs a step, not every second.
      out.push(`wind-down (dim ${alpha ? Math.floor(alpha * 10) * 10 : '?'}%)`);
    }
    if (document.querySelector('.web-time-average-popup-overlay')) out.push('average popup');
    // Nudges and the blocker share this element.
    const blur = document.querySelector('.web-time-blur-overlay');
    if (blur && getComputedStyle(blur).opacity !== '0' && blur.style.display !== 'none') out.push('blur');
    return out.join(', ');
  }).catch(() => '');
}
