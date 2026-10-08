// One scenario per feature worth driving: it seeds what the feature needs,
// drives it the way a user would, and checks what the page, popup and storage
// show. Each returns true on success; failures go through fail() with a fix.

import {
  cardText, fail, localDate, openPage, openPopup, pass, readNudges, readTimer, stay, startRun,
} from './lib.mjs';
import { readFile } from 'node:fs/promises';

const rules = (localhost) => ({ webTimeSettings: { global: {}, domains: { localhost } } });
const clockSeconds = (text) => {
  const m = /(\d+):(\d\d)\s*$/.exec(text ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Time tracking + On-page timer, with knobs for poking around by hand. */
async function track(opts) {
  const { seconds = 15, limit = null, cooldown = 0, popup = false, doctor = false } = opts;
  const storage = limit === null ? {} : rules({ sessionLimitEnabled: true, sessionLimit: limit, cooldownIncrement: cooldown });
  const run = await startRun({ ...opts, storage });
  try {
    if (limit !== null) {
      console.log(`  session rules on for localhost: ${limit}-minute sessions, ` +
        `${cooldown ? `${cooldown}-minute cooldown step` : 'no cooldown'}`);
    }
    const page = await openPage(run);
    await stay(page, seconds);
    const timer = await readTimer(page);
    const blockerSeen = page.timeline.some((t) => t.overlays.includes('blocker'));

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
    } else if (limit !== null && cooldown > 0 && seconds > limit * 60 + 5 && !blockerSeen) {
      ok = fail(`The session was ${limit} min and the stay ${seconds}s, but no cooldown blocker appeared ` +
        `(last clock verdict: ${run.lastVerdict()}).`,
        run.verdicts().includes('cooldown')
          ? 'the background did start the cooldown, so the page never showed it: check SHOW_BLOCKER handling in content.ts.'
          : 'check the stored seconds above reached the limit; if they did, the session-end path in background.ts did not fire.');
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
  const run = await startRun({ ...opts, storage: rules({ sessionLimitEnabled: true, sessionLimit: 3, nudgeInterval: 0.5 }) });
  try {
    console.log('  3-minute session, nudge every 30s');
    const page = await openPage(run);
    await stay(page, 128);
    const seen = await readNudges(page);
    const logged = run.logs.filter((l) => /nudge at/.test(l)).length;
    console.log(`  nudges on the page at: ${seen.map((s) => `${s}s`).join(', ') || '(none)'}`);
    console.log(`  nudges the background logged: ${logged}`);
    console.log(`  clock verdicts seen: ${run.verdicts().join(' → ')}`);

    if (seen.length < 2) {
      return fail(`Expected 2–3 nudges by 128s, the page showed ${seen.length} (background logged ${logged}).`,
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

/** End session early with the shortcut: confirm, cooldown, then a longer next session. */
async function endEarly(opts) {
  const run = await startRun({ ...opts, storage: rules({ sessionLimitEnabled: true, sessionLimit: 2, cooldownIncrement: 0.25 }) });
  try {
    console.log('  2-minute session, 15s cooldown step');
    const page = await openPage(run);
    await stay(page, 10);
    await page.keyboard.press('Control+e');
    const confirm = await stay(page, 3, { until: (o) => o.includes('end-session confirm') });
    if (!confirm.includes('end-session confirm')) {
      return fail('Ctrl+E did not open the end-session confirm.',
        'check isEndSessionShortcutMatch and the keydown listener in content.ts; the default shortcut is Ctrl+E.');
    }
    const promised = clockSeconds(/Next session will be ([\d:]+)/.exec(confirm)?.[1]);
    console.log(`  verdict while confirming: ${run.lastVerdict()}`);

    await page.click('.web-time-end-ok');
    const blocked = await stay(page, 5, { until: (o) => o.includes('blocker') });
    if (!blocked.includes('Session 1 Ended')) {
      return fail('OK on the confirm did not bring up the "Session 1 Ended" blocker.',
        'check END_SESSION_EARLY in background.ts and SHOW_BLOCKER in content.ts.');
    }
    await stay(page, 20, { until: (o) => !o.includes('blocker') });
    await stay(page, 2);
    const timer = await readTimer(page);
    const left = clockSeconds(timer.text);
    console.log(`  confirm promised a next session of ${promised}s; timer after the cooldown: "${timer.text}"`);

    if (left === null || promised === null || Math.abs(promised - left) > 6) {
      return fail(`The next session should start near ${promised}s, the timer shows "${timer.text}".`,
        'check endSessionEarly carryover and grace in session-model.ts against nextLength in content.ts.');
    }
    return pass(`ended early: confirm → blocker → session 2 of ~${promised}s (carryover + 10% grace)`);
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
    await stay(page, 3);
    const after = (await readTimer(page)).text;
    console.log(`  timer before "${before}", after the toggle "${after}"`);
    console.log(`  saved: ${JSON.stringify(saved)}`);
    console.log(`  session card: ${card}`);

    if (!saved?.sessionLimitEnabled) {
      return fail('The toggle did not save sessionLimitEnabled for localhost.',
        'check the toggle handler and writeDomainLimits in popup/session-card.ts.');
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
    return pass(`wind-down dimmed from ${dims[0]}% to ${dims.at(-1)}% over 40s`);
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
    return pass(`Chart scale saved as ${saved.scalingPower}; untouched settings kept`);
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
  nudges: { run: nudges, about: 'Nudges at a 30s interval (~2 min)' },
  'end-early': { run: endEarly, about: 'End session early via Ctrl+E (~40s)' },
  'average-popup': { run: averagePopup, about: '7-day average popup pauses the clock (~1 min)' },
  'session-rules': { run: sessionRules, about: 'Session rules toggle in the popup reaches the page (~10s)' },
  'wind-down': { run: windDown, about: 'Wind-down dims the page as a session ends (~45s)' },
  overview: { run: overview, about: 'All-sites overview lists stored sites (~5s)' },
  'past-day': { run: pastDay, about: 'Past-day sessions from a clicked bar (~5s)' },
  'global-settings': { run: globalSettings, about: 'Global settings save from the gear sheet (~5s)' },
  export: { run: exportData, about: 'Your data: summary and Export download (~5s)' },
};
