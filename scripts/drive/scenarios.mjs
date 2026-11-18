// One scenario per feature worth driving: it seeds what the feature needs,
// drives it the way a user would, and checks what the page, popup and storage
// show. Each returns true on success; failures go through fail() with a fix.

import {
  cardText, fail, localDate, openPage, openPopup, pass, passGate, readNudges, readTimer, stay, startRun,
} from './lib.mjs';
import { readFile } from 'node:fs/promises';

const rules = (localhost) => ({ webTimeSettings: { global: {}, domains: { localhost } } });
const clockSeconds = (text) => {
  const m = /(\d+):(\d\d)\s*$/.exec(text ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Time tracking + On-page timer, with knobs for poking around by hand. */
async function track(opts) {
  const { seconds = 15, limit = null, popup = false, doctor = false } = opts;
  const storage = limit === null ? {} : rules({ sessionLimitEnabled: true, sessionLimit: limit });
  const run = await startRun({ ...opts, storage });
  try {
    if (limit !== null) {
      console.log(`  session rules on for localhost: ${limit}-minute sessions`);
    }
    const page = await openPage(run);
    await stay(page, seconds);
    const timer = await readTimer(page);
    // The timeline starts once the first session is under way, so a gate in it
    // is the one that follows a session ending.
    const gateSeen = page.timeline.some((t) => t.overlays.includes('gate'));

    // The worker saves once a minute; a domain switch banks and saves.
    await page.goto('about:blank');
    await page.waitForTimeout(500);
    const stored = await run.storage('trackedTime');
    const day = stored?.lastDate;
    const tracked = day ? stored.timeHistory?.[day]?.localhost ?? 0 : 0;

    console.log(`  clock verdicts seen: ${run.verdicts().join(' → ') || '(none)'}`);
    console.log(`  timer: ${timer.visible ? 'visible' : 'hidden'} "${timer.text ?? '(no element)'}"`);
    console.log(`  stored localhost seconds on ${day ?? '(no day)'}: ${tracked}`);

    let ok;
    if (doctor) {
      ok = run.verdicts().includes('running')
        ? pass('doctor: stack up, clock runs on a tracked page')
        : fail(`doctor: clock never reached "running" (last verdict: ${run.lastVerdict()}).`,
          'run npm run drive with --headed and watch the page; check the worker console for errors.');
    } else if (limit !== null && seconds > limit * 60 + 5 && !gateSeen) {
      ok = fail(`The session was ${limit} min and the stay ${seconds}s, but the gate did not come back ` +
        `(last clock verdict: ${run.lastVerdict()}).`,
        run.lastVerdict() === 'gate'
          ? 'the background did end the session, so the page never showed the gate: check SHOW_GATE handling in content.ts.'
          : 'check the stored seconds above reached the limit; if they did, checkSessionLimit in background.ts did not end the session.');
    } else if (!timer.visible || !timer.text) {
      ok = fail('The on-page timer never appeared.',
        'run with --headed and watch the page; check the worker console for errors.');
    } else if (tracked <= 0) {
      ok = fail(`No time was recorded for localhost (last clock verdict: ${run.lastVerdict()}).`,
        'see the verdict: "unfocused" means run --headed; anything else is the gate that held the clock.');
    } else {
      ok = pass(`tracked ${tracked}s on localhost, timer showed "${timer.text}"`);
    }

    if (popup) {
      const p = await openPopup(run);
      console.log(`  popup usage card: ${await cardText(p, '#detail-usage-card')}`);
      console.log(`  popup session card: ${await cardText(p, '#session-card')}`);
      if (p.errors.length) {
        ok = fail(`The popup threw: ${p.errors.join(' | ')}`,
          'open the popup with --headed and check its console; the first error is usually the cause.');
      } else if (!(await cardText(p, '#detail-usage-card'))) {
        ok = fail('The popup never rendered the site view for localhost.',
          'run with --headed --popup and look at the popup tab; check that popup-init still reads the active tab with tabs.query.');
      } else {
        pass('popup rendered the site view for localhost');
      }
    }
    return ok;
  } finally {
    await run.close();
  }
}

/** Nudges at a 30s interval in a 3-minute session: due at ~60, 90 and 120s.
 *  None can fire before 60s or in the last 60s, so that's the shortest run. */
async function nudges(opts) {
  // Each nudge is jittered by up to a quarter of the interval and dropped if
  // that lands it under 60s or inside the final minute. In a 3-minute session
  // the 60s and 120s slots were both coin flips, and 22% of seeds scheduled
  // only one nudge. Four minutes keeps the 120s slot clear of the wind-down,
  // so every seed has at least two by 140s.
  const run = await startRun({ ...opts, storage: rules({ sessionLimitEnabled: true, sessionLimit: 4, nudgeInterval: 0.5 }) });
  try {
    console.log('  4-minute session, nudge every 30s');
    const page = await openPage(run);
    await stay(page, 140);
    const seen = await readNudges(page);
    const logged = run.logs.filter((l) => /nudge at/.test(l)).length;
    console.log(`  nudges on the page at: ${seen.map((s) => `${s}s`).join(', ') || '(none)'}`);
    console.log(`  nudges the background logged: ${logged}`);
    console.log(`  clock verdicts seen: ${run.verdicts().join(' → ')}`);

    if (seen.length < 2) {
      return fail(`Expected 2–3 nudges by 140s, the page showed ${seen.length} (background logged ${logged}).`,
        logged > seen.length
          ? 'the background fired them but the page did not animate: check NUDGE handling and showNudge in content.ts.'
          : 'check checkPhiNudges in background.ts and nudgeTimes in session-model.ts.');
    }
    if (seen.some((s) => s < 55)) {
      return fail(`A nudge came at ${seen[0]}s, before the 60s floor.`, 'check the 60s floor in nudgeTimes (session-model.ts).');
    }
    if (run.lastVerdict() !== 'running') {
      return fail(`The clock ended on "${run.lastVerdict()}" after the nudges, not "running".`,
        'a nudge must not hold the clock: check what the nudge path changes in the gates (clock-gates.ts).');
    }
    return pass(`${seen.length} nudges at ${seen.join('s, ')}s; the clock kept running`);
  } finally {
    await run.close();
  }
}

/** End session early with the shortcut: confirm, the gate, and the unused
 *  time back in what the site holds. */
async function endEarly(opts) {
  const run = await startRun({ ...opts, storage: rules({ sessionLimitEnabled: true, sessionLimit: 2 }) });
  try {
    console.log('  2-minute sessions; the site starts with 4 and the first is under way');
    const page = await openPage(run);
    await stay(page, 10);
    await page.keyboard.press('Control+e');
    const confirm = await stay(page, 3, { until: (o) => o.includes('end-session confirm') });
    if (!confirm.includes('end-session confirm')) {
      return fail('Ctrl+E did not open the end-session confirm.',
        'check isEndSessionShortcutMatch and the keydown listener in content.ts; the default shortcut is Ctrl+E.');
    }
    console.log(`  verdict while confirming: ${run.lastVerdict()}`);

    await page.click('.web-time-end-ok');
    const gated = await stay(page, 5, { until: (o) => o.includes('gate') });
    if (!gated.includes('gate')) {
      return fail('OK on the confirm did not bring the gate back.',
        'check END_SESSION_EARLY and endSession in background.ts, and SHOW_GATE in content.ts.');
    }
    console.log(`  verdict at the gate: ${run.lastVerdict()}`);
    const gateTitle = () => page.locator('.web-time-gate-title').innerText();
    const endedTitle = await gateTitle();
    const button = await page.locator('.web-time-gate-ok').innerText();
    const previewAfterEnd = clockSeconds((await readTimer(page)).text);
    console.log(`  gate after the end: "${endedTitle}", button "${button}", timer ${previewAfterEnd}s`);
    if (endedTitle !== 'Session 1 Ended' || button !== 'Start Session') {
      return fail(`After ending session 1 the gate reads "${endedTitle}" with a "${button}" button.`,
        'expected "Session 1 Ended" and "Start Session": check sessionNumSeen in showGate and the title in renderGate (content.ts).');
    }
    if (!(previewAfterEnd > 220 && previewAfterEnd <= 240)) {
      return fail(`At the gate the timer should show the next session's length, about 3:50; it shows ${previewAfterEnd}s.`,
        'check sessionViewSeconds and offeredSeconds in content.ts.');
    }
    await page.reload();
    await page.locator('.web-time-gate-title').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(1200);
    const freshTitle = await gateTitle();
    const previewAfterLoad = clockSeconds((await readTimer(page)).text);
    console.log(`  gate after a reload: "${freshTitle}", timer ${previewAfterLoad}s`);
    if (freshTitle !== 'Start a Session?' || !(previewAfterLoad > 220 && previewAfterLoad <= 240)) {
      return fail(`A freshly loaded page reads "${freshTitle}" with the timer at ${previewAfterLoad}s.`,
        'a new page should greet with "Start a Session?" and still preview the session: check showGate and updateTimerText in content.ts.');
    }
    // About 110 of the 120 seconds wait to be added to the next session.
    const extra = (await run.storage('webTimeSessionExtra'))?.localhost;
    console.log(`  extra kept after ending ~10s into a 2-minute session: ${extra}s`);
    if (!(extra > 100 && extra < 115)) {
      return fail(`Ending ~10s into a 2-minute session should keep about 110s for the next one, storage holds ${extra}.`,
        'check returnUnused in background.ts.');
    }

    if (!(await passGate(page))) {
      return fail('The gate after an early end did not start the next session.',
        'check START_SESSION and beginSession in background.ts.');
    }
    await stay(page, 2);
    const timer = await readTimer(page);
    const left = clockSeconds(timer.text);
    console.log(`  timer two seconds into the next session: "${timer.text}"`);
    const expected = 120 + extra - 2;
    if (left === null || Math.abs(expected - left) > 6) {
      return fail(`The next session should be 2:00 plus the ${extra}s kept, the timer shows "${timer.text}".`,
        'check that beginSession adds extraSeconds to the length in background.ts.');
    }
    const after = (await run.storage('webTimeSessionExtra'))?.localhost;
    if (after) {
      return fail(`The kept time should be used up by the next session, ${after}s is still stored.`,
        'check that beginSession clears extraSeconds in background.ts.');
    }
    return pass(`ended early: confirm → gate → ${extra}s kept → next session "${timer.text}"`);
  } finally {
    await run.close();
  }
}

/** An end-session confirm left open in one tab holds the clock only there:
 *  another site keeps counting, and going back to the confirm's tab stops it
 *  again. Held everywhere, it froze every timer in the browser. */
async function confirmElsewhere(opts) {
  const run = await startRun({ ...opts, storage: rules({ sessionLimitEnabled: true, sessionLimit: 40 }) });
  try {
    const first = await openPage(run);
    await stay(first, 3);
    await first.keyboard.press('Control+e');
    const confirm = await stay(first, 3, { until: (o) => o.includes('end-session confirm') });
    if (!confirm.includes('end-session confirm')) {
      return fail('Ctrl+E did not open the end-session confirm.',
        'check isEndSessionShortcutMatch and the keydown listener in content.ts.');
    }
    console.log(`  confirm open on localhost, verdict ${run.lastVerdict()}`);

    // Another site: same server, another host name, so another domain.
    const other = await run.context.newPage();
    await other.goto(run.pageUrl.replace('localhost', '127.0.0.1'));
    await other.bringToFront();
    other.timeline = [];
    other.openedAt = Date.now();
    await stay(other, 3);
    const from = clockSeconds((await readTimer(other)).text);
    await stay(other, 6);
    const to = clockSeconds((await readTimer(other)).text);
    console.log(`  127.0.0.1 timer over 6s: ${from}s → ${to}s, verdict ${run.lastVerdict()}`);
    if (from === null || to === null || to - from < 4) {
      return fail(`With a confirm open on localhost, 127.0.0.1's timer went ${from}s → ${to}s in 6s (verdict ${run.lastVerdict()}).`,
        'a dialog should hold the clock only while its own tab is active: check endSessionConfirmOpen in currentClockVerdict (background.ts).');
    }

    await first.bringToFront();
    await stay(first, 2);
    const back = run.lastVerdict();
    console.log(`  back on localhost with the confirm still open: verdict ${back}`);
    if (back !== 'end-session-confirm') {
      return fail(`Back on the tab with the confirm open, the verdict is ${back}.`,
        'the confirm should still hold the clock on its own tab: check currentClockVerdict in background.ts.');
    }
    return pass(`confirm held only its own tab: 127.0.0.1 counted ${to - from}s meanwhile, localhost frozen again on return`);
  } finally {
    await run.close();
  }
}

/** Sitting still after the gate on a silent page, with the default 30s
 *  inactivity: the clock stops once the window since the last input passes,
 *  and a mouse move starts it again. The OS idle gate asks this machine, so
 *  whether it or the tab's own check stops the clock depends on whether
 *  someone is using the Mac; the verdicts say which. */
async function sitStill(opts) {
  const run = await startRun({ ...opts, inactivityS: 30, storage: rules({ sessionLimitEnabled: true, sessionLimit: 40 }) });
  try {
    console.log('  40-minute sessions, inactivity 30s; OK is the last input');
    const page = await openPage(run);
    const verdictsBefore = run.verdicts().length;
    let last = null;
    let frozeAt = null;
    for (let s = 1; s <= 50; s++) {
      await page.waitForTimeout(1000);
      const { text } = await readTimer(page);
      if (text !== last) {
        frozeAt = null;
      } else if (frozeAt === null) {
        frozeAt = s - 1;
      }
      if (s % 5 === 0 || (frozeAt === s - 1)) console.log(`    ${s}s after the gate: "${text}"`);
      last = text;
    }
    const sinceStart = run.verdicts().slice(verdictsBefore - 1);
    console.log(`  verdicts since the session started: ${sinceStart.join(' → ')}`);
    if (frozeAt === null) {
      return fail('The timer kept counting through 50s with no input on a silent page.',
        'that means neither the tab check nor the OS idle gate stopped the clock; check activeTabIsEngaged and clockVerdict.');
    }
    console.log(`  timer stopped about ${frozeAt}s after the session started`);

    const stoppedBy = run.lastVerdict();
    // Synthetic moves are not OS input, so once the OS gate has stopped the
    // clock only a person at this Mac can start it again.
    if (stoppedBy === 'os-idle') {
      return pass(`sat still: stopped ~${frozeAt}s into the session (os-idle); restarting on input needs a person at this Mac, not checked`);
    }
    await page.mouse.move(300, 300);
    await page.waitForTimeout(2500);
    const after = (await readTimer(page)).text;
    console.log(`  after moving the mouse: "${last}" → "${after}" (verdict ${run.lastVerdict()})`);
    if (after === last) {
      return fail(`Moving the mouse did not start the clock again; it stayed at "${after}" with verdict ${run.lastVerdict()}.`,
        'check USER_ACTIVE in background.ts and updateActivityState in content.ts.');
    }
    return pass(`sat still: stopped ~${frozeAt}s into the session (${stoppedBy}), a mouse move restarted it`);
  } finally {
    await run.close();
  }
}

/** The 7-day average popup: a week at 60s/day puts it at 48s today. It pauses
 *  the clock until Continue. */
async function averagePopup(opts) {
  const timeHistory = {};
  for (let d = 1; d <= 7; d++) timeHistory[localDate(d)] = { localhost: 60 };
  const run = await startRun({
    ...opts,
    storage: {
      ...rules({ sessionLimitEnabled: true, sessionLimit: 10 }),
      trackedTime: { lastDate: localDate(0), timeHistory, version: 1 },
    },
  });
  try {
    console.log('  7 days at 60s/day on localhost, 10-minute sessions');
    const page = await openPage(run);
    const shown = await stay(page, 70, { until: (o) => o.includes('average popup') });
    if (!shown.includes('average popup')) {
      return fail(`No average popup by 70s (last clock verdict: ${run.lastVerdict()}).`,
        'check checkAveragePopup in background.ts: rules on, 7 days with data, 80% of the average.');
    }
    const before = (await readTimer(page)).text;
    await page.waitForTimeout(3000);
    const during = (await readTimer(page)).text;
    console.log(`  verdict with the popup up: ${run.lastVerdict()}; timer "${before}" then "${during}" 3s later`);
    if (run.lastVerdict() !== 'average-popup' || before !== during) {
      return fail('The clock kept running behind the average popup.',
        'the popup must hold the clock: check AVERAGE_POPUP_OPEN and the average-popup gate.');
    }

    await page.click('.web-time-avg-continue-btn');
    await stay(page, 4);
    const after = (await readTimer(page)).text;
    console.log(`  after Continue: verdict ${run.lastVerdict()}, timer "${after}"`);
    if (run.lastVerdict() !== 'running' || after === during) {
      return fail(`After Continue the clock is "${run.lastVerdict()}" and the timer stuck at "${after}".`,
        'Continue must release the gate: check AVERAGE_POPUP_CLOSE in background.ts and that content.ts sends it.');
    }
    return pass('average popup paused the clock and Continue released it');
  } finally {
    await run.close();
  }
}

/** Session rules from the popup: the toggle must reach the background and the
 *  page. The background re-reads settings every intervention pass, so this
 *  passes even if the popup's SETTINGS_UPDATED is lost; it can't see that. */
async function sessionRules(opts) {
  const run = await startRun(opts);
  try {
    const page = await openPage(run);
    await stay(page, 3);
    const before = (await readTimer(page)).text;

    const popup = await openPopup(run);
    await popup.click('#session-settings-card .sc-toggle');
    await popup.waitForTimeout(1000);
    const card = await cardText(popup, '#session-card');
    const saved = (await run.storage('webTimeSettings'))?.domains?.localhost;
    await popup.close();

    await page.bringToFront();
    // Turning rules on puts the page behind the gate.
    const gated = await passGate(page);
    await stay(page, 3);
    const after = (await readTimer(page)).text;
    console.log(`  timer before "${before}", after the toggle and the gate "${after}"`);
    console.log(`  saved: ${JSON.stringify(saved)}`);
    console.log(`  session card: ${card}`);

    if (!saved?.sessionLimitEnabled) {
      return fail('The toggle did not save sessionLimitEnabled for localhost.',
        'check the toggle handler and writeDomainLimits in popup/session-card.ts.');
    }
    if (!gated) {
      return fail('The toggle saved, but the page never showed a gate that starts a session.',
        'check the sweep at the end of applyUpdatedSettings in background.ts and SHOW_GATE in content.ts.');
    }
    if (!after?.includes('⏱')) {
      return fail(`The toggle saved, but the page timer still shows "${after}" instead of a session countdown.`,
        'the background re-reads settings on each intervention pass; check runInterventionPass and the TIME_UPDATE it sends the tab.');
    }
    return pass(`toggle saved ${saved.sessionLimit}-minute sessions and the page timer switched to "${after}"`);
  } finally {
    await run.close();
  }
}

/** Wind-down: a 1-minute session is all wind-down, so the page should dim
 *  further as it goes. */
async function windDown(opts) {
  const run = await startRun({ ...opts, storage: rules({ sessionLimitEnabled: true, sessionLimit: 1 }) });
  try {
    console.log('  1-minute session');
    const page = await openPage(run);
    await stay(page, 40);
    const dims = page.timeline.map((t) => /wind-down \(dim (\d+)%\)/.exec(t.overlays)?.[1]).filter(Boolean).map(Number);
    console.log(`  dim steps seen: ${dims.map((d) => `${d}%`).join(' → ') || '(none)'}`);
    if (!dims.length) {
      return fail(`No wind-down overlay in a 1-minute session by 40s (last clock verdict: ${run.lastVerdict()}).`,
        'check checkWindDown in background.ts and windDownState in session-model.ts.');
    }
    if (dims.length < 2 || dims.at(-1) <= dims[0]) {
      return fail(`The wind-down dim did not deepen: ${dims.join('% → ')}%.`,
        'check the opacity windDownState returns and how content.ts applies SHOW_WIND_DOWN.');
    }

    // Adding time takes the session out of its final minute: the overlay
    // should fade out, not vanish, and stay gone.
    console.log('  session raised to 2 minutes');
    // Opened first and left behind the page: a popup tab in front would take
    // tracking away from the page, and the change wouldn't reach its session.
    const popup = await openPopup(run);
    await page.bringToFront();
    await stay(page, 2);
    await page.evaluate(() => {
      window.__windFade = [];
      const id = setInterval(() => {
        const w = document.querySelector('.web-time-wind-down-overlay');
        const v = w.style.visibility === 'hidden' ? 'hidden' : Number(getComputedStyle(w).opacity).toFixed(2);
        if (window.__windFade.at(-1) !== v) window.__windFade.push(v);
        if (v === 'hidden') clearInterval(id);
      }, 30);
      setTimeout(() => clearInterval(id), 10_000);
    });
    // From the popup, as the settings sheet does: the background acts on its
    // SETTINGS_UPDATED, not on the storage write.
    await popup.evaluate(async () => {
      const { webTimeSettings: s } = await chrome.storage.local.get('webTimeSettings');
      s.domains.localhost.sessionLimit = 2;
      await chrome.storage.local.set({ webTimeSettings: s });
      await chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED' }).catch(() => {});
    });
    await page.waitForFunction(() => window.__windFade.at(-1) === 'hidden', null, { timeout: 5000 }).catch(() => {});
    const fade = await page.evaluate(() => window.__windFade);
    const partial = fade.filter((o) => o !== 'hidden' && o > 0 && o < 1);
    console.log(`    opacity: ${fade.join(' → ')}`);
    if (fade.at(-1) !== 'hidden') {
      return fail(`The wind-down overlay was still up 5s after the session went past a minute left (${fade.at(-1)}).`,
        'check syncWindDownToTimer in content.ts hides when windDownProgress returns null.');
    }
    if (!partial.length) {
      return fail('The wind-down overlay vanished without fading.',
        'check hideWindDownOverlay in content.ts fades opacity before hiding.');
    }
    await popup.close();
    const back = await stay(page, 3);
    if (back.includes('wind-down')) {
      return fail(`The wind-down overlay came back with 2 minutes on the session: ${back}.`,
        'check checkWindDown in background.ts and windDownProgress in session-model.ts.');
    }
    return pass(`wind-down dimmed from ${dims[0]}% to ${dims.at(-1)}% over 40s, then faded out when time was added`);
  } finally {
    await run.close();
  }
}

/** Stored history for the popup scenarios: localhost today and yesterday, and
 *  two finished sessions yesterday (one completed, one ended early). */
const seededHistory = () => ({
  trackedTime: {
    lastDate: localDate(0),
    timeHistory: { [localDate(1)]: { localhost: 420 }, [localDate(0)]: { localhost: 125 } },
    version: 1,
  },
  webTimeSessionHistory: {
    version: 1,
    history: { [localDate(1)]: { localhost: [[300, 300, 60, 'completed'], [120, 330, 0, 'early']] } },
  },
});

/** Open the popup on seeded history and hand it to `check`; popup errors fail. */
async function withPopup(opts, check) {
  const run = await startRun({ ...opts, storage: seededHistory() });
  try {
    const popup = await openPopup(run);
    const ok = await check(popup, run);
    if (ok && popup.errors.length) {
      return fail(`The popup threw: ${popup.errors.join(' | ')}`,
        'open the popup with --headed and check its console; the first error is usually the cause.');
    }
    return ok;
  } finally {
    await run.close();
  }
}

/** All-sites overview: the breakdown lists the seeded site for today. */
function overview(opts) {
  return withPopup(opts, async (popup) => {
    await popup.click('#nav-toggle-btn');
    await popup.waitForTimeout(500);
    const labels = await popup.locator('#general-page .breakdown-label').allInnerTexts().catch(() => []);
    const head = await cardText(popup, '#usage-breakdown-head');
    console.log(`  breakdown head: ${head}`);
    console.log(`  breakdown sites: ${labels.join(', ') || '(none)'}`);
    if (!labels.some((l) => l.includes('localhost'))) {
      return fail('The all-sites breakdown does not list localhost, which has 2:05 stored today.',
        'check updateDailyBreakdown in popup/ui-manager.ts and the totals from data-processor.ts.');
    }
    return pass('all-sites overview lists localhost in today\'s breakdown');
  });
}

/** Past-day sessions: click yesterday's bar, see its two finished sessions. */
function pastDay(opts) {
  return withPopup(opts, async (popup) => {
    // The chart picks the nearest bar to the click (mode 'index'), today
    // rightmost. Step left from the right edge until the date leaves "Today".
    // Wait after each click: a second click on the same bar deselects it.
    const box = await popup.locator('#time-chart').boundingBox();
    let label = 'Today';
    for (let x = box.x + box.width - 10; x > box.x && /Today/.test(label); x -= 20) {
      await popup.mouse.click(x, box.y + box.height / 2);
      await popup.waitForTimeout(150);
      label = await popup.locator('#topbar-date-label').innerText();
    }
    const cards = await cardText(popup, '#past-day-cards');
    console.log(`  date label: ${label}`);
    console.log(`  past-day cards: ${cards || '(empty)'}`);
    if (/Today/.test(label)) {
      return fail('Clicking along the site chart never selected a past day.',
        'check the detail chart onClick in popup/chart-builder.ts and selectDetailDay in ui-manager.ts.');
    }
    if (!/Session 1/i.test(cards) || !/Session 2/i.test(cards) || !/early/i.test(cards)) {
      return fail(`Yesterday has two stored sessions (completed, ended early); the cards show "${cards}".`,
        'check renderPastDayCards in popup/past-day-cards.ts and sessionsFor in shared/session-history.ts.');
    }
    return pass(`past day ${label} shows its two sessions, the second ended early`);
  });
}

/** Global settings: step Chart scale down, Save, and find it in storage. */
function globalSettings(opts) {
  return withPopup(opts, async (popup, run) => {
    await popup.click('#settings-toggle-btn');
    await popup.waitForTimeout(400);
    await popup.click('#chart-scaling-stepper .sc-stepper-btn:has-text("▼")');
    await popup.click('#start-countdown-stepper .sc-stepper-btn:has-text("▼")');
    await popup.click('#day-reset-stepper .sc-stepper-btn:has-text("▼")');
    await popup.click('#save-settings-btn');
    await popup.waitForTimeout(500);
    const saved = (await run.storage('webTimeSettings'))?.global;
    console.log(`  saved global settings: ${JSON.stringify(saved)}`);
    if (!(saved?.scalingPower < 1)) {
      return fail(`Stepped Chart scale down from 1.0 and saved; storage holds ${saved?.scalingPower}.`,
        'check the stepper mirrors into #chart-scaling (mountSettingsStepper) and saveSettings in popup/ui-manager.ts.');
    }
    if (saved.inactivityTimeoutS !== 3600) {
      return fail(`Saving changed Inactivity to ${saved.inactivityTimeoutS} though it was not touched.`,
        'saveSettings writes every global from the form: check loadSettings fills #inactivity-timeout from storage.');
    }
    if (saved.dayResetTime !== 23 || saved.dayResetMinute !== 55) {
      return fail(`Stepped Day resets at down from 00:00 and saved; storage holds ${saved.dayResetTime}:${saved.dayResetMinute}, not 23:55.`,
        'stepping past midnight should come round the clock: check the cycle option in stepper (popup/session-card.ts) and #day-reset-stepper in ui-manager.ts.');
    }
    if (saved.startCountdownS !== 9) {
      return fail(`Stepped Start countdown down from 10 and saved; storage holds ${saved.startCountdownS}.`,
        'check #start-countdown-stepper mirrors into #start-countdown and saveSettings writes startCountdownS (popup/ui-manager.ts).');
    }
    return pass(`Chart scale saved as ${saved.scalingPower}, start countdown as 9s, day reset wrapped to 23:55; untouched settings kept`);
  });
}

/** Your data: the summary counts the stored days and Export downloads them. */
function exportData(opts) {
  return withPopup(opts, async (popup) => {
    await popup.click('#settings-toggle-btn');
    await popup.waitForTimeout(400);
    const summary = await cardText(popup, '#storage-summary');
    const [download] = await Promise.all([
      popup.waitForEvent('download', { timeout: 5000 }).catch(() => null),
      popup.click('#export-data-btn'),
    ]);
    console.log(`  storage summary: ${summary}`);
    if (!download) {
      return fail('Export did not start a download.', 'check downloadExport in popup/storage-panel.ts.');
    }
    const file = JSON.parse(await readFile(await download.path(), 'utf8'));
    const yesterday = file.sessionHistory?.history?.[localDate(1)]?.localhost?.length;
    console.log(`  downloaded ${download.suggestedFilename()}: app ${file.app}, ` +
      `${Object.keys(file.trackedTime?.timeHistory ?? {}).length} days, ${yesterday ?? 0} sessions yesterday`);
    if (!/2 days/.test(summary)) {
      return fail(`Two days are stored; the summary says "${summary}".`, 'check the summary in popup/storage-panel.ts.');
    }
    if (file.app !== 'WebTime' || file.trackedTime?.timeHistory?.[localDate(0)]?.localhost !== 125 || yesterday !== 2) {
      return fail('The export is missing seeded data (want app WebTime, 125s today, 2 sessions yesterday).',
        'check buildExport in shared/data-export.ts and what downloadExport reads from storage.');
    }
    return pass(`exported ${download.suggestedFilename()} with both days and yesterday's sessions`);
  });
}

export const scenarios = {
  track: { run: track, about: 'Time tracking + On-page timer (default); takes --seconds, --limit, --cooldown, --popup' },
  nudges: { run: nudges, about: 'Nudges at a 30s interval (~2.5 min)' },
  'confirm-elsewhere': { run: confirmElsewhere, about: 'An end-session confirm left open holds the clock only on its tab (~25s)' },
  'sit-still': { run: sitStill, about: 'Sitting still after the gate stops the clock; a mouse move restarts it (~75s)' },
  'end-early': { run: endEarly, about: 'End session early via Ctrl+E (~40s)' },
  'average-popup': { run: averagePopup, about: '7-day average popup pauses the clock (~1 min)' },
  'session-rules': { run: sessionRules, about: 'Session rules toggle in the popup reaches the page (~10s)' },
  'wind-down': { run: windDown, about: 'Wind-down dims the page as a session ends (~45s)' },
  overview: { run: overview, about: 'All-sites overview lists stored sites (~5s)' },
  'past-day': { run: pastDay, about: 'Past-day sessions from a clicked bar (~5s)' },
  'global-settings': { run: globalSettings, about: 'Global settings save from the gear sheet (~5s)' },
  export: { run: exportData, about: 'Your data: summary and Export download (~5s)' },
};
