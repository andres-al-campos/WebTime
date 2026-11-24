// One scenario per feature worth driving: it seeds what the feature needs,
// drives it the way a user would, and checks what the page, popup and storage
// show. Each returns true on success; failures go through fail() with a fix.

import {
  cardText, fail, localDate, openPage, openPopup, pass, passGate, readNudges, readTimer, stay, startRun,
} from './lib.mjs';
import { readFile } from 'node:fs/promises';

// Breaks are off unless a drive sets them, so a drive that starts session
// after session isn't waiting minutes at the gate between them.
const rules = (localhost, global = {}) => ({ webTimeSettings: { global, domains: { localhost: { breakMinutes: 0, ...localhost } } } });
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

/** Three nudges in a 4-minute session, at golden-ratio fractions of it: due at
 *  about 92s and 148s, with the third (~183s) dropped as it falls inside the
 *  final minute. None can fire before 60s or in the last 60s. */
async function nudges(opts) {
  const run = await startRun({ ...opts, storage: rules({ sessionLimitEnabled: true, sessionLimit: 4 }, { nudgesPerSession: 3 }) });
  try {
    console.log('  4-minute session, 3 nudges a session');
    const page = await openPage(run);
    await stay(page, 165);
    const seen = await readNudges(page);
    const logged = run.logs.filter((l) => /nudge at/.test(l)).length;
    console.log(`  nudges on the page at: ${seen.map((s) => `${s}s`).join(', ') || '(none)'}`);
    console.log(`  nudges the background logged: ${logged}`);
    console.log(`  clock verdicts seen: ${run.verdicts().join(' → ')}`);

    if (seen.length < 2) {
      return fail(`Expected 2 nudges by 165s, the page showed ${seen.length} (background logged ${logged}).`,
        logged > seen.length
          ? 'the background fired them but the page did not animate: check NUDGE handling and showNudge in content.ts.'
          : 'check checkPhiNudges in background.ts, nudgesPerSession in the settings, and computeNudgeTimes in session-model.ts.');
    }
    if (seen.some((s) => s < 55)) {
      return fail(`A nudge came at ${seen[0]}s, before the 60s floor.`, 'check the 60s floor in computeNudgeTimes (session-model.ts).');
    }
    if (seen[1] - seen[0] < 30) {
      return fail(`The nudges came ${seen[1] - seen[0]}s apart; at 38% and 62% of 4 minutes they should be about 56s apart.`,
        'check the φ spacing in computeNudgeTimes (session-model.ts).');
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

/** The day's row: yesterday's leftovers reach the bank, a start costs one dot
 *  whatever it used, an empty row waits for the reset, and a budget stored while
 *  sessions refilled through the day keeps its dots. */
async function dailyRow(opts) {
  const site = { sessionLimitEnabled: true, sessionLimit: 2, sessionsPerDay: 3, bankSessions: 3 };
  const today = localDate(0);
  const seeded = (budget) => ({ ...rules(site), webTimeSessionBudget: { localhost: budget } });
  const filled = (page) => page.locator('.web-time-gate-dots > span').evaluateAll(
    (dots) => dots.filter((d) => d.style.getPropertyValue('--wt-gate-fill') === '100%').length);
  const stored = async (run) => (await run.storage('webTimeSessionBudget'))?.localhost;
  const line = (page) => page.locator('.web-time-gate-line').innerText();
  const kind = (page) => page.locator('.web-time-gate-dots').getAttribute('data-kind');
  const slots = (page) => page.locator('.web-time-gate-dots > span').count();

  let run = await startRun({ ...opts, storage: seeded({ used: 1, bank: 0, day: localDate(1) }) });
  try {
    const page = await openPage(run, { gate: false });
    await page.locator('.web-time-gate-ok').waitFor({ state: 'visible', timeout: 5000 });
    const row = await filled(page);
    const banked = await stored(run);
    const said = await line(page);
    console.log(`  new day: ${row} dots, "${said}", stored ${JSON.stringify(banked)}`);
    if (row !== 3 || banked?.bank !== 2 || banked?.used !== 0 || banked?.day !== today) {
      return fail(`Yesterday left 2 of 3: expected a full row and 2 banked, got ${row} dots and ${JSON.stringify(banked)}.`,
        'check settle in session-budget.ts and budgetOf in background.ts.');
    }
    if (said !== '3/3 sessions left') {
      return fail(`Under a full row of 3 the gate says "${said}".`,
        'expected "3/3 sessions left", and nothing about the bank while the row has some: check renderGate in content.ts.');
    }
    if (!(await passGate(page))) return fail('The gate did not start a session.', 'check beginSession in background.ts.');
    await stay(page, 3);
    await page.keyboard.press('Control+e');
    await page.locator('.web-time-end-ok').click();
    await page.locator('.web-time-gate-ok').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(900);
    const afterEnd = await filled(page);
    const spent = await stored(run);
    console.log(`  ended early: ${afterEnd} dots, stored ${JSON.stringify(spent)}`);
    if (afterEnd !== 2 || spent?.used !== 1) {
      return fail(`A session ended early should cost one whole dot: ${afterEnd} dots, ${JSON.stringify(spent)}.`,
        'the unused time goes to webTimeSessionExtra, not back to the row: check endSession in background.ts.');
    }
  } finally {
    await run.close();
  }

  // The row used up, the bank holding 2 of 3: the bank takes the row's place.
  run = await startRun({ ...opts, storage: seeded({ used: 3, bank: 2, day: today }) });
  try {
    const page = await openPage(run, { gate: false });
    await page.locator('.web-time-gate-ok').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(900);
    const shown = { kind: await kind(page), slots: await slots(page), filled: await filled(page), line: await line(page) };
    console.log(`  row used up: ${JSON.stringify(shown)}`);
    if (shown.kind !== 'bank' || shown.slots !== 3 || shown.filled !== 2 || shown.line !== '2/3 banked sessions left') {
      return fail(`With the row used up and 2 of 3 banked the gate shows ${JSON.stringify(shown)}.`,
        'expected the bank\'s 3 slots in the row\'s place, 2 filled, over "2/3 banked sessions left": check renderGate and renderGateDots in content.ts.');
    }
    await page.locator('.web-time-gate-ok').click();
    await page.waitForTimeout(900);
    const starting = { filled: await filled(page), line: await line(page) };
    console.log(`  counting down from the bank: ${JSON.stringify(starting)}`);
    if (starting.filled !== 1 || starting.line !== '1/3 banked sessions left') {
      return fail(`Starting from the bank shows ${JSON.stringify(starting)}.`,
        'during the countdown one banked dot should drain and stay as an empty slot: check renderGate in content.ts.');
    }
  } finally {
    await run.close();
  }

  run = await startRun({ ...opts, storage: seeded({ used: 3, bank: 0, day: today }) });
  try {
    const page = await openPage(run, { gate: false });
    const title = page.locator('.web-time-gate-title');
    await title.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(600);
    const [text, clock, canPress] = [await title.innerText(), await page.locator('.web-time-gate-body').innerText(), await page.locator('.web-time-gate-ok').isVisible()];
    console.log(`  nothing left: "${text}" ${clock}`);
    if (text !== 'Sessions Refill In' || clockSeconds(clock) === null || canPress) {
      return fail(`With nothing left the gate reads "${text}" / "${clock}".`,
        'expected "Sessions Refill In" over a clock and no Start button: check renderGate in content.ts.');
    }
  } finally {
    await run.close();
  }

  const asking = seeded({ sessions: 1.4, at: Date.now(), bank: 1 });
  // Longer than a title's line: it must not push the button down.
  const question = 'Is this really how you want to spend this whole evening?';
  asking.webTimeSettings.global = { startQuestion: question };
  run = await startRun({ ...opts, storage: asking });
  try {
    const page = await openPage(run, { gate: false });
    await page.locator('.web-time-gate-ok').waitFor({ state: 'visible', timeout: 5000 });
    const start = await page.locator('.web-time-gate-ok').boundingBox();
    await page.locator('.web-time-gate-ok').click();
    await page.waitForTimeout(800);
    const asked = await page.locator('.web-time-gate-title').innerText();
    const cancel = await page.locator('.web-time-gate-cancel').boundingBox();
    console.log(`  during the countdown the title asks: "${asked}"; button moved ${Math.abs(cancel.y - start.y)}px down, ${Math.abs(cancel.x - start.x)}px across`);
    if (asked !== question) {
      return fail(`The start question is set to "${question}", the gate's title reads "${asked}".`,
        'check startQuestion in syncGate (background.ts) and renderGate (content.ts).');
    }
    if (Math.abs(cancel.y - start.y) > 0.5 || Math.abs(cancel.x - start.x) > 0.5) {
      return fail(`Cancel appears ${cancel.y - start.y}px below and ${cancel.x - start.x}px beside Start Session.`,
        'it must land exactly where Start Session was, so a second click cancels: keep the gate at GATE_HEIGHT_PX and both buttons the same width (content.ts).');
    }
    const moved = await stored(run);
    console.log(`  stored by the refilling design: now ${JSON.stringify(moved)}`);
    if (moved?.used !== 2 || moved?.bank !== 1 || moved?.day !== today) {
      return fail(`A budget of 0.4 in the row and 1 banked should read 2 used, 1 banked: ${JSON.stringify(moved)}.`,
        'check readBudget in session-budget.ts and loadBudgets in background.ts.');
    }
  } finally {
    await run.close();
  }
  return pass('the row refills at the reset, a start costs one dot, the bank shows once the row is used up, an empty row waits, old budgets carry over');
}

/** End session early with the shortcut: confirm, the gate, and the unused
 *  time back in what the site holds. */
async function endEarly(opts) {
  // A 1-minute first break, so ending 10s into 2 minutes takes about 5s of it.
  const site = { sessionLimitEnabled: true, sessionLimit: 2, sessionsPerDay: 3, bankSessions: 2, breakMinutes: 1 };
  const storage = { ...rules(site), webTimeSessionBudget: { localhost: { used: 0, bank: 0, day: localDate(0) } } };
  const run = await startRun({ ...opts, storage });
  try {
    console.log('  2-minute sessions, an empty bank; the first is under way');
    const page = await openPage(run);
    await stay(page, 10);
    await page.keyboard.press('Control+e');
    const confirm = await stay(page, 3, { until: (o) => o.includes('end-session confirm') });
    if (!confirm.includes('end-session confirm')) {
      return fail('Ctrl+E did not open the end-session confirm.',
        'check isEndSessionShortcutMatch and the keydown listener in content.ts; the default shortcut is Ctrl+E.');
    }
    console.log(`  verdict while confirming: ${run.lastVerdict()}`);
    const confirmText = await page.locator('.web-time-end-session-overlay').innerText();
    if (!/rolls over to banked sessions/.test(confirmText)) {
      return fail(`The confirm should say the unused time rolls over to banked sessions; it reads "${confirmText.replace(/\n/g, ' / ')}".`,
        'check the body line in showEndSessionConfirm (content.ts).');
    }

    await page.click('.web-time-end-ok');
    const gated = await stay(page, 2, { until: (o) => o.includes('gate') });
    if (!gated.includes('gate')) {
      return fail('OK on the confirm did not bring the gate back.',
        'check END_SESSION_EARLY and endSession in background.ts, and SHOW_GATE in content.ts.');
    }
    await page.waitForTimeout(800);
    const gateTitle = () => page.locator('.web-time-gate-title').innerText();
    const button = () => page.locator('.web-time-gate-ok').innerText();
    const onBreak = await button();
    console.log(`  gate after the end: "${await gateTitle()}", button "${onBreak}"`);
    if (await gateTitle() !== 'Session Ended' || !/^Next session in \d+:\d\d$/.test(onBreak)) {
      return fail(`After ending a session the gate reads "${await gateTitle()}" with a "${onBreak}" button.`,
        'expected "Session Ended" and a "Next session in mm:ss" break: check startBreak in background.ts and renderGate in content.ts.');
    }
    const bank = (await run.storage('webTimeSessionBudget'))?.localhost?.bank;
    console.log(`  bank after ending ~12s into a 2-minute session: ${bank}`);
    if (!(bank > 0.8 && bank < 0.95)) {
      return fail(`Ending ~12s into a 2-minute session should bank about 0.9 of a session; the bank holds ${bank}.`,
        'check returnUnused and deposit in background.ts and session-budget.ts.');
    }

    // The break is in proportion to what was used: about 6s of a 60s break.
    await page.waitForTimeout(8000);
    const after = await button();
    console.log(`  button after the break: "${after}"`);
    if (after !== 'Start Session') {
      return fail(`The break should be over by now and the button read "Start Session"; it reads "${after}".`,
        'check breakSeconds (session-breaks.ts) and the share passed by startBreak in background.ts.');
    }
    const preview = clockSeconds((await readTimer(page)).text);
    if (!(preview > 110 && preview <= 120)) {
      return fail(`At the gate the timer should show a plain 2:00 session; it shows ${preview}s.`,
        'every session is one length now: check offeredSeconds in content.ts.');
    }
    if (!(await passGate(page))) {
      return fail('The gate after the break did not start the next session.',
        'check START_SESSION and beginSession in background.ts.');
    }
    await stay(page, 2);
    const timer = await readTimer(page);
    const left = clockSeconds(timer.text);
    console.log(`  timer two seconds into the next session: "${timer.text}"`);
    if (left === null || Math.abs(118 - left) > 6) {
      return fail(`The next session should be a plain 2:00; the timer shows "${timer.text}".`,
        'unspent time goes to the bank, not the next session: check beginSession in background.ts.');
    }
    return pass(`ended early: confirm → break "${onBreak}" → bank ${bank} → next session "${timer.text}"`);
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

/** Two browser windows: time goes to the site in the window you're in, and a
 *  confirm left open in the other window doesn't hold the clock. The focus
 *  change is sent to the extension directly: a headless browser never moves
 *  focus between windows, and a visible one loses it to whatever the person at
 *  the machine is doing. */
async function twoWindows(opts) {
  const run = await startRun({ ...opts, storage: rules({ sessionLimitEnabled: true, sessionLimit: 40 }) });
  const open = async (url) => {
    const [page, id] = await Promise.all([
      run.context.waitForEvent('page'),
      run.worker.evaluate((u) => chrome.windows.create({ url: u, focused: true, width: 700, height: 500 }).then((w) => w.id), url),
    ]);
    await page.waitForLoadState();
    page.timeline = [];
    page.openedAt = Date.now();
    return { page, id };
  };
  const focus = async (win) => {
    await run.worker.evaluate((id) => chrome.windows.onFocusChanged.dispatch(id), win.id);
    await win.page.bringToFront();
    await win.page.waitForTimeout(800);
  };
  try {
    const other = await open(run.pageUrl.replace('localhost', '127.0.0.1'));
    const first = await open(run.pageUrl);
    if (!(await passGate(first.page))) {
      return fail('The gate did not start a session.', 'check beginSession in background.ts.');
    }
    await stay(first.page, 2);

    await focus(other);
    await stay(other.page, 8);
    const counted = clockSeconds((await readTimer(other.page)).text);
    console.log(`  8s in the other window: its timer reads ${counted}s`);
    if (counted === null || counted < 5) {
      return fail(`After 8s in the 127.0.0.1 window its timer reads ${counted}s.`,
        'the active tab should follow window focus: check handleWindowFocusChanged in background.ts.');
    }

    await focus(first);
    await first.page.keyboard.press('Control+e');
    await stay(first.page, 3, { until: (o) => o.includes('end-session confirm') });
    if (run.lastVerdict() !== 'end-session-confirm') {
      return fail(`With the confirm open in its own window the verdict is ${run.lastVerdict()}.`,
        'the confirm should hold the clock there: check endSessionConfirmOpen in currentClockVerdict (background.ts).');
    }
    await focus(other);
    await stay(other.page, 2);
    const from = clockSeconds((await readTimer(other.page)).text);
    await stay(other.page, 6);
    const to = clockSeconds((await readTimer(other.page)).text);
    console.log(`  confirm open in the first window: the other window counted ${from}s → ${to}s, verdict ${run.lastVerdict()}`);
    if (from === null || to === null || to - from < 4) {
      return fail(`With a confirm open in another window, this window's timer went ${from}s → ${to}s in 6s.`,
        'a dialog holds the clock only while its own tab is active: check handleWindowFocusChanged in background.ts.');
    }
    return pass(`time followed the focused window: ${counted}s counted there, and ${to - from}s more with a confirm open in the other window`);
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
    // Back to the site: its chart is kept, not rebuilt with its grow-in again.
    await popup.evaluate(() => { document.querySelector('#detail-page canvas').dataset.drive = 'first'; });
    await popup.click('#nav-toggle-btn');
    await popup.waitForTimeout(500);
    const kept = await popup.evaluate(() => document.querySelector('#detail-page canvas')?.dataset.drive);
    console.log(`  back on the site view, chart ${kept === 'first' ? 'kept' : 'rebuilt'}`);
    if (kept !== 'first') {
      return fail('Switching to All sites and back rebuilt the site chart, which replays its grow-in animation.',
        'the nav toggle should call showDetailFor in popup/ui-manager.ts, which keeps the chart for the same site.');
    }
    return pass('all-sites overview lists localhost in today\'s breakdown; the site chart survives a switch');
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
    await popup.fill('#start-question', '  Worth it?  ');
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
    if (saved.startQuestion !== 'Worth it?') {
      return fail(`Typed a start question and saved; storage holds "${saved.startQuestion}".`,
        'saveSettings rewrites every global from the form: check it writes #start-question (popup/ui-manager.ts).');
    }
    return pass(`Chart scale saved as ${saved.scalingPower}, start countdown as 9s, start question kept, day reset wrapped to 23:55; untouched settings kept`);
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
  nudges: { run: nudges, about: 'Three φ-spaced nudges in a 4-minute session (~3 min)' },
  'confirm-elsewhere': { run: confirmElsewhere, about: 'An end-session confirm left open holds the clock only on its tab (~25s)' },
  'two-windows': { run: twoWindows, about: 'Time follows the focused window (~30s)' },
  'sit-still': { run: sitStill, about: 'Sitting still after the gate stops the clock; a mouse move restarts it (~75s)' },
  'daily-row': { run: dailyRow, about: 'The day\'s row: reset, bank, one dot per start, the wait (~35s)' },
  'end-early': { run: endEarly, about: 'End session early via Ctrl+E (~40s)' },
  'average-popup': { run: averagePopup, about: '7-day average popup pauses the clock (~1 min)' },
  'session-rules': { run: sessionRules, about: 'Session rules toggle in the popup reaches the page (~10s)' },
  'wind-down': { run: windDown, about: 'Wind-down dims the page as a session ends (~45s)' },
  overview: { run: overview, about: 'All-sites overview lists stored sites; switching back keeps the site chart (~6s)' },
  'past-day': { run: pastDay, about: 'Past-day sessions from a clicked bar (~5s)' },
  'global-settings': { run: globalSettings, about: 'Global settings save from the gear sheet (~5s)' },
  export: { run: exportData, about: 'Your data: summary and Export download (~5s)' },
};
