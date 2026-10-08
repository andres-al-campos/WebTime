// The pieces every drive scenario shares: a browser with the extension and
// seeded storage, a trackable page, a stay that keeps the page engaged, and
// readers for what the page and popup show. Chrome only.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function fail(what, fix) {
  console.error(`✗ ${what}\n  Fix: ${fix}`);
  process.exitCode = 1;
  return false;
}

export function pass(what) {
  console.log(`✓ ${what}`);
  return true;
}

/** YYYY-MM-DD in local time, `daysAgo` before today: the background's day key
 *  with the default 0:00 day reset. */
export function localDate(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Start a run: a page server, a throwaway profile, and the browser with the
 * extension. `storage` (storage.local keys → values) is written and the
 * browser relaunched so the worker boots with it.
 *
 * The inactivity timeout is always raised to an hour. The os-idle gate asks the
 * OS, synthetic mouse moves don't count as input there, and with the default
 * 30s the clock stops whenever nobody has touched this machine for 30s.
 * Settings are applied by relaunching rather than SETTINGS_UPDATED, which
 * keeps the OS idle state read under the old timeout (a person changing
 * settings is active; the harness is not). chrome.runtime.reload() is no
 * alternative: it disables a command-line-loaded extension.
 */
export async function startRun({ extDir, headed = false, storage = {} }) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>WebTime drive</title><p>WebTime drive page</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // "localhost" is trackable (http), needs no network, and can't collide with
  // a real site's history.
  const pageUrl = `http://localhost:${server.address().port}/`;
  const profile = mkdtempSync(join(tmpdir(), 'webtime-drive-'));

  const launch = async () => {
    const context = await chromium.launchPersistentContext(profile, {
      // 'chromium' is the full browser in new headless mode; the default
      // headless shell cannot load extensions.
      channel: 'chromium',
      headless: !headed,
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
    });
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => null);
    return { context, worker };
  };

  const close = async (context) => {
    await context?.close();
    server.close();
    rmSync(profile, { recursive: true, force: true });
  };

  let { context, worker } = await launch();
  if (worker) {
    const settings = storage.webTimeSettings ?? { global: {}, domains: {} };
    const seeded = {
      ...storage,
      webTimeSettings: { ...settings, global: { ...settings.global, inactivityTimeoutS: 3600 } },
    };
    await worker.evaluate((v) => chrome.storage.local.set(v), seeded);
    await context.close();
    ({ context, worker } = await launch());
  }
  if (!worker) {
    await close(context);
    fail('The extension service worker never started.',
      'check dist-chrome/manifest.json loads in chrome://extensions (Load unpacked) and fix any error it shows.');
    process.exit(1);
  }

  // Everything the extension logs, from the worker and the page. Debug builds
  // log every clock transition as "Clock verdict: a -> b".
  const logs = [];
  context.on('console', (msg) => logs.push(msg.text()));

  // Nudges last a second, too short for a once-a-second poll to catch. Record
  // them in the page as they happen: the timer scales up only during a nudge.
  await context.addInitScript(() => {
    window.__webtimeNudges = [];
    const start = Date.now();
    new MutationObserver(() => {
      const t = document.querySelector('.web-time-timer');
      const scaled = t && /scale\((?!1\))/.test(t.style.transform);
      if (scaled && !window.__webtimeNudgeOn) window.__webtimeNudges.push(Math.round((Date.now() - start) / 1000));
      window.__webtimeNudgeOn = scaled;
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['style'] });
  });

  return {
    context, worker, pageUrl, logs,
    extensionId: new URL(worker.url()).host,
    verdicts: () => logs.map((l) => /Clock verdict: \S+ -> (\S+)/.exec(l)?.[1]).filter(Boolean),
    lastVerdict() { return this.verdicts().at(-1) ?? '(none logged; is this a release build?)'; },
    storage: (key) => worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k] ?? null, key),
    close: () => close(context),
  };
}

/** Open the drive page in front. */
export async function openPage(run) {
  const page = await run.context.newPage();
  await page.goto(run.pageUrl);
  await page.bringToFront();
  page.openedAt = Date.now();
  page.timeline = [];
  return page;
}

/**
 * Stay on the page for `seconds`, moving the mouse so the tab counts as
 * engaged (the content script throttles USER_ACTIVE to one per 5s, so every
 * second is plenty). Prints each change in the page's overlays, timed from
 * when the page opened, and keeps them in page.timeline. Stops early once
 * `until(overlays)` is true; returns the overlays it stopped on.
 */
export async function stay(page, seconds, { until } = {}) {
  let overlays = page.timeline.at(-1)?.overlays ?? '';
  for (let s = 0; s < seconds; s++) {
    await page.mouse.move(100 + (s % 2) * 50, 100 + (s % 50));
    await page.waitForTimeout(1000);
    const now = await readOverlays(page);
    if (now !== overlays) {
      const at = Math.round((Date.now() - page.openedAt) / 1000);
      page.timeline.push({ at, overlays: now });
      console.log(`    ${at}s ${now || '(no overlay)'}`);
      overlays = now;
    }
    if (until?.(overlays)) break;
  }
  return overlays;
}

/** The on-page timer's text and whether it's showing. */
export async function readTimer(page) {
  const text = await page.locator('.web-time-timer').textContent().catch(() => null);
  const visible = await page.locator('.web-time-timer:not(.web-time-timer-hidden)').count().catch(() => 0);
  return { text, visible: visible > 0 };
}

/** Seconds into the run at which each nudge started. */
export function readNudges(page) {
  return page.evaluate(() => window.__webtimeNudges ?? []).catch(() => []);
}

/**
 * The page's own overlays in one line: blocker, wind-down darkness, end-session
 * confirm, average popup, blur. Read from the page, not from messages, so what
 * is reported is what a user would see.
 */
export function readOverlays(page) {
  return page.evaluate(() => {
    const out = [];
    const leafText = (el, skip) => {
      const clone = el.cloneNode(true);
      if (skip) clone.querySelector(skip)?.remove();
      // Text nodes, not leaf elements: a line broken by <br> has an element child.
      const walk = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
      const parts = [];
      while (walk.nextNode()) if (walk.currentNode.textContent.trim()) parts.push(walk.currentNode.textContent.trim());
      return parts.join(' / ');
    };
    const blocker = document.querySelector('.web-time-blocker-overlay');
    // Without the live countdown, so the timeline logs the blocker once.
    if (blocker) out.push(`blocker "${leafText(blocker, '.web-time-blocker-countdown')}"`);
    const wind = document.querySelector('.web-time-wind-down-overlay');
    if (wind && wind.style.visibility !== 'hidden') {
      const alpha = /rgba\([^)]*,\s*([\d.]+)\)/.exec(wind.style.background)?.[1];
      // In 10% steps, so the timeline logs a step, not every second.
      out.push(`wind-down (dim ${alpha ? Math.floor(alpha * 10) * 10 : '?'}%)`);
    }
    const confirm = document.querySelector('.web-time-end-session-overlay');
    if (confirm) out.push(`end-session confirm "${leafText(confirm)}"`);
    const avg = document.querySelector('.web-time-average-popup-overlay');
    if (avg) out.push(`average popup "${leafText(avg)}"`);
    // Nudges and the blocker share this element.
    const blur = document.querySelector('.web-time-blur-overlay');
    if (blur && getComputedStyle(blur).opacity !== '0' && blur.style.display !== 'none') out.push('blur');
    return out.join(', ');
  }).catch(() => '');
}

/**
 * Open the popup as a tab. It picks its site from the active tab, which would
 * be itself, so tabs.query is answered with the drive page instead. Returns
 * the popup page, left open for the caller to click through.
 */
export async function openPopup(run) {
  const popup = await run.context.newPage();
  popup.errors = [];
  popup.on('pageerror', (e) => popup.errors.push(e.message));
  await popup.addInitScript((url) => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (q) => (q && q.active) ? [{ id: -1, url, active: true }] : query(q);
  }, run.pageUrl);
  await popup.goto(`chrome-extension://${run.extensionId}/popup/popup.html`);
  // The cards render asynchronously from storage.
  await popup.waitForFunction(
    () => document.querySelector('#detail-usage-card')?.textContent.trim(),
    null, { timeout: 10_000 }).catch(() => {});
  await popup.waitForTimeout(300);
  return popup;
}

export const cardText = (popup, sel) =>
  popup.locator(sel).innerText().then((t) => t.trim().replace(/\n+/g, ' / ')).catch(() => '');
