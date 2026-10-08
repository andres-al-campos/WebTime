// One scenario per feature worth driving: it seeds what the feature needs,
// drives it the way a user would, and checks what the page, popup and storage
// show. Each returns true on success; failures go through fail() with a fix.

import {
  cardText, fail, localDate, openPage, openPopup, pass, readNudges, readTimer, stay, startRun,
} from './lib.mjs';

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

export const scenarios = {
  track: { run: track, about: 'Time tracking + On-page timer (default); takes --seconds, --limit, --cooldown, --popup' },
  nudges: { run: nudges, about: 'Nudges at a 30s interval (~2 min)' },
  'end-early': { run: endEarly, about: 'End session early via Ctrl+E (~40s)' },
  'average-popup': { run: averagePopup, about: '7-day average popup pauses the clock (~1 min)' },
  'session-rules': { run: sessionRules, about: 'Session rules toggle in the popup reaches the page (~10s)' },
};
