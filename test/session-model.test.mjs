// Tests for src/shared/session-model.ts.
// Run with: npm test  (or: node --test test/session-model.test.mjs)
// Compiles the module inline via esbuild, then runs assertions.
//
// Headline cases: live-length-change (shrink preserves elapsed time) and grace
// baked in at session birth (no mid-session gap, wind-down only at the true
// extended tail).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = mkdtempSync(join(tmpdir(), 'webtime-model-test-'));
const outFile = join(out, 'session-model.mjs');
await build({
  entryPoints: ['src/shared/session-model.ts'],
  bundle: true,
  format: 'esm',
  outfile: outFile,
  platform: 'node',
});
const mod = await import(pathToFileURL(outFile).href);
const {
  startSession, effectiveLength, displayFor,
  naturalEnd, endEarly, changeLength, cooldownLength, incrementSeconds,
  computeGraceSeconds, computeNudgeTimes, nextNudgeToFire, markNudgeFired,
  windDownState, WIND_DOWN_DURATION,
  endsAtSessionTime, windDownAtSessionTime, secondsUntil, instantFor, scheduleFor,
  shouldScheduleWakes,
} = mod;

const M = 60;

// ---------------------------------------------------------------------------
// Derivers
// ---------------------------------------------------------------------------

test('effectiveLength sums base + carryover + grace', () => {
  const s = startSession({ dailyTotal: 0, baseLength: 30 * M, carryover: 5 * M, graceSeconds: 1 * M });
  assert.equal(effectiveLength(s), 36 * M);
});

test('displayFor: fresh session shows full effective length', () => {
  const s = startSession({ dailyTotal: 0, baseLength: 30 * M });
  const d = displayFor(s, 0);
  assert.equal(d.sessionTime, 0);
  assert.equal(d.sessionLimitSeconds, 30 * M);
  assert.equal(d.remaining, 30 * M);
});

test('displayFor: anchored to startDaily, not a daily modulo', () => {
  // Session started at daily=2400 (i.e. session 2). 5 min in.
  const s = startSession({ dailyTotal: 40 * M, baseLength: 30 * M, sessionNum: 2 });
  const d = displayFor(s, 45 * M);
  assert.equal(d.sessionTime, 5 * M);
  assert.equal(d.remaining, 25 * M);
});

// ---------------------------------------------------------------------------
// CASE 1 — the headline bug: shrink preserves elapsed time
// ---------------------------------------------------------------------------

test('changeLength: 55→45 min at 40 min in → 5 min remaining (the reported bug)', () => {
  const s = startSession({ dailyTotal: 0, baseLength: 55 * M });
  // 40 min in → 15 min left on the old 55 min limit
  assert.equal(displayFor(s, 40 * M).remaining, 15 * M);

  const { session, expired } = changeLength(s, { dailyTotal: 40 * M, newBaseLength: 45 * M });
  assert.equal(expired, false);
  // Elapsed preserved (40 min), so remaining drops by exactly the 10 min delta.
  assert.equal(displayFor(session, 40 * M).sessionTime, 40 * M);
  assert.equal(displayFor(session, 40 * M).remaining, 5 * M);
});

// ---------------------------------------------------------------------------
// CASE 2 — shrink past elapsed → expired (caller fires cooldown)
// ---------------------------------------------------------------------------

test('changeLength: shrink below elapsed → expired=true', () => {
  const s = startSession({ dailyTotal: 0, baseLength: 55 * M });
  const { expired } = changeLength(s, { dailyTotal: 40 * M, newBaseLength: 30 * M });
  assert.equal(expired, true); // 40 min in, new limit 30 → over
});

test('changeLength: shrink to exactly elapsed → expired=true (remaining 0)', () => {
  const s = startSession({ dailyTotal: 0, baseLength: 55 * M });
  const { session, expired } = changeLength(s, { dailyTotal: 40 * M, newBaseLength: 40 * M });
  assert.equal(expired, true);
  assert.equal(displayFor(session, 40 * M).remaining, 0);
});

// ---------------------------------------------------------------------------
// CASE 3 — grow mid-session
// ---------------------------------------------------------------------------

test('changeLength: 45→55 min at 30 min in → 25 min remaining, not expired', () => {
  const s = startSession({ dailyTotal: 0, baseLength: 45 * M });
  const { session, expired } = changeLength(s, { dailyTotal: 30 * M, newBaseLength: 55 * M });
  assert.equal(expired, false);
  assert.equal(displayFor(session, 30 * M).remaining, 25 * M);
});

// ---------------------------------------------------------------------------
// CASE 4 — endEarly bakes carryover + grace into the next session AT BIRTH
// ---------------------------------------------------------------------------

test('endEarly: 10 min left → carryover 10 min, grace 1 min, both baked into next session', () => {
  const s = startSession({ dailyTotal: 0, baseLength: 30 * M, sessionNum: 1 });
  // 20 min in → 10 min left
  const r = endEarly(s, { dailyTotal: 20 * M, cooldownIncrement: 5 * M });
  assert.ok(r !== null);
  assert.equal(r.graceEarned, 1 * M); // 10% of 10 min = 1 min

  const next = r.nextSession;
  assert.equal(next.sessionNum, 2);
  assert.equal(next.startDaily, 20 * M);     // anchored at current daily
  assert.equal(next.carryover, 10 * M);
  assert.equal(next.graceSeconds, 1 * M);
  // Effective length from second 0 — grace is part of the duration, no gap.
  assert.equal(effectiveLength(next), 30 * M + 10 * M + 1 * M);
});

test('endEarly: returns null when nothing left to claim', () => {
  const s = startSession({ dailyTotal: 0, baseLength: 30 * M });
  assert.equal(endEarly(s, { dailyTotal: 30 * M, cooldownIncrement: 5 * M }), null);
  assert.equal(endEarly(s, { dailyTotal: 35 * M, cooldownIncrement: 5 * M }), null);
});

// The end-session confirm quotes the cooldown BEFORE the user commits, by
// calling cooldownLength directly with the session number it has on hand. The
// blocker then shows what endEarly actually produced. If those two ever
// disagreed the dialog would be lying about the price, so pin them together.
test('cooldownLength matches the cooldown endEarly actually fires', () => {
  for (const sessionNum of [1, 2, 3, 7]) {
    for (const increment of [0, 3 * M, 5 * M]) {
      const s = startSession({ dailyTotal: 0, baseLength: 30 * M, sessionNum });
      const quoted = cooldownLength(sessionNum, increment);
      const r = endEarly(s, { dailyTotal: 10 * M, cooldownIncrement: increment });
      assert.equal(r.cooldownSeconds, quoted,
        `session ${sessionNum}, increment ${increment}`);
    }
  }
});

test('cooldownLength: no increment configured means no cooldown to quote', () => {
  assert.equal(cooldownLength(4, 0), 0);
});

// ---------------------------------------------------------------------------
// CASE 5 — grace tracks time left, not the session's pedigree
// ---------------------------------------------------------------------------

test('endEarly: a grace-extended session still earns 10% of time left', () => {
  // This session was BORN with grace (graceSeconds > 0).
  const s = startSession({ dailyTotal: 0, baseLength: 30 * M, graceSeconds: 1 * M, sessionNum: 2 });
  // End it early with time left — 10% is earned regardless of prior grace.
  const r = endEarly(s, { dailyTotal: 20 * M, cooldownIncrement: 5 * M });
  assert.ok(r !== null);
  // effLen 31 min, 20 in → 11 left; 10% of 11 min = 66s.
  assert.equal(r.nextSession.carryover, 11 * M);
  assert.equal(r.graceEarned, 66);
  assert.equal(r.nextSession.graceSeconds, 66);
});

// ---------------------------------------------------------------------------
// CASE 6 — catch-up nudge after a shrink
// ---------------------------------------------------------------------------

test('nextNudgeToFire: a nudge that moves behind us after shrink fires once', () => {
  // Long session with a known nudge schedule. computeNudgeTimes reads the same
  // per-session seed as nextNudgeToFire, so they agree.
  const s0 = startSession({ dailyTotal: 0, baseLength: 60 * M });
  const times = computeNudgeTimes(effectiveLength(s0), s0.nudgeSeed);
  assert.ok(times.length > 0, 'expected at least one nudge for a 60-min session');
  const firstNudge = times[0];

  // Sit just BEFORE the first nudge — nothing due yet.
  assert.equal(nextNudgeToFire(s0, firstNudge - 1), null);

  // Now we're AT/after it → it's due.
  const due = nextNudgeToFire(s0, firstNudge);
  assert.equal(due, firstNudge);

  // Mark fired, then it must not fire again.
  const s1 = markNudgeFired(s0, due);
  assert.equal(nextNudgeToFire(s1, firstNudge), null);
});

// ---------------------------------------------------------------------------
// CASE 7 — catch-up after a skipped tick
// ---------------------------------------------------------------------------

test('nextNudgeToFire: jumping past a nudge still fires it next call', () => {
  const s = startSession({ dailyTotal: 0, baseLength: 60 * M });
  const times = computeNudgeTimes(effectiveLength(s), s.nudgeSeed);
  const firstNudge = times[0];
  // Daily jumps from before the nudge to well past it (simulated skipped ticks).
  const due = nextNudgeToFire(s, firstNudge + 30);
  assert.equal(due, firstNudge); // not dropped
});

test('nextNudgeToFire: picks the LATEST overdue unfired nudge', () => {
  const s = startSession({ dailyTotal: 0, baseLength: 60 * M });
  const times = computeNudgeTimes(effectiveLength(s), s.nudgeSeed);
  assert.ok(times.length >= 2, 'need >=2 nudges for this case');
  // Past the second nudge with none fired → should return the second (latest eligible).
  const due = nextNudgeToFire(s, times[1] + 5);
  assert.equal(due, times[1]);
});

// ---------------------------------------------------------------------------
// Nudge spacing: determinism, jitter bound, min-gap floor, decay shape
// ---------------------------------------------------------------------------

const NUDGE_JITTER = 30;
const NUDGE_MIN_INTERVAL = 120;
const DEFAULT_INTERVAL_MIN = 20;

test('computeNudgeTimes: deterministic for a given seed', () => {
  const eff = 55 * M;
  const a = computeNudgeTimes(eff, 12345);
  const b = computeNudgeTimes(eff, 12345);
  assert.deepEqual(a, b); // same seed → identical times, every call
});

test('computeNudgeTimes: different seeds give different times', () => {
  const eff = 120 * M;
  const a = computeNudgeTimes(eff, 1, 10);
  const b = computeNudgeTimes(eff, 999999, 10);
  assert.notDeepEqual(a, b);
});

test('startSession: regenerates a fresh seed each session', () => {
  const seeds = new Set();
  for (let i = 0; i < 20; i++) {
    seeds.add(startSession({ dailyTotal: 0, baseLength: 30 * M }).nudgeSeed);
  }
  assert.ok(seeds.size > 1, 'expected fresh randomness across sessions');
});

test('computeNudgeTimes: lands on multiples of the interval, within jitter', () => {
  const eff = 120 * M;
  for (const minutes of [5, 10, 20, 30]) {
    for (let seed = 0; seed < 50; seed++) {
      for (const t of computeNudgeTimes(eff, seed, minutes)) {
        const iv = minutes * 60;
        const nearest = Math.round(t / iv) * iv;
        assert.ok(
          Math.abs(t - nearest) <= NUDGE_JITTER,
          `${t} is more than ${NUDGE_JITTER}s from any multiple of ${iv}`
        );
      }
    }
  }
});

test('computeNudgeTimes: gaps are the interval, not a decaying fraction', () => {
  // The whole point of the change: spacing must not depend on session length.
  // Same interval, three very different sessions → same gap between nudges.
  for (const eff of [45 * M, 90 * M, 180 * M]) {
    const times = computeNudgeTimes(eff, 7, 15);
    assert.ok(times.length >= 2, `expected >=2 nudges in a ${eff / M}m session`);
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      // 15m ± jitter on both ends.
      assert.ok(
        Math.abs(gap - 15 * 60) <= 2 * NUDGE_JITTER,
        `gap ${gap}s is not ~15m (session ${eff / M}m)`
      );
    }
  }
});

test('computeNudgeTimes: the first nudge does not scale with session length', () => {
  // Under the old φ schedule the first nudge sat at a fixed FRACTION, so it
  // moved with the limit. It must not any more.
  const short = computeNudgeTimes(30 * M, 3, 10)[0];
  const long = computeNudgeTimes(180 * M, 3, 10)[0];
  assert.ok(
    Math.abs(short - long) <= 2 * NUDGE_JITTER,
    `first nudge moved from ${short}s to ${long}s with the session length`
  );
});

test('computeNudgeTimes: the interval you set is the interval you get', () => {
  // There was a 120s floor here once. It silently turned a 1-minute setting
  // into 2-minute nudges — a second decider disagreeing with the stepper's own
  // minimum, which is the only rule now.
  const eff = 30 * M;
  for (const minutes of [1, 2, 3, 5]) {
    const times = computeNudgeTimes(eff, 42, minutes);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    assert.ok(
      Math.abs(mean - minutes * 60) <= 10,
      `set ${minutes}m but the mean gap was ${(mean / 60).toFixed(2)}m`
    );
  }
});

test('computeNudgeTimes: jitter scales with the interval', () => {
  // At a fixed +/-30s a 1-minute interval swings 30-90s, which does not read as
  // "every minute". The window is a quarter of the interval, capped at 30s.
  const eff = 30 * M;
  for (const minutes of [1, 2]) {
    const iv = minutes * 60;
    const window = Math.min(NUDGE_JITTER, iv / 4);
    for (let seed = 0; seed < 40; seed++) {
      for (const t of computeNudgeTimes(eff, seed, minutes)) {
        const nearest = Math.round(t / iv) * iv;
        assert.ok(
          Math.abs(t - nearest) <= window + 1,
          `${t}s is ${Math.abs(t - nearest)}s off grid; window is ${window}s at ${minutes}m`
        );
      }
    }
  }
});

test('computeNudgeTimes: no nudge inside the final wind-down window', () => {
  const eff = 55 * M;
  for (let seed = 0; seed < 100; seed++) {
    for (const t of computeNudgeTimes(eff, seed, 10)) {
      assert.ok(t <= eff - WIND_DOWN_DURATION, `nudge ${t} intrudes on wind-down`);
      assert.ok(t >= 60, `nudge ${t} too early`);
    }
  }
});

test('computeNudgeTimes: interval 0 disables nudges', () => {
  assert.deepEqual(computeNudgeTimes(55 * M, 1, 0), []);
});

test('computeNudgeTimes: a session shorter than the interval gets none', () => {
  // Consequence of a fixed interval, asserted so it is a decision and not a
  // surprise: at the 20m default a 15m session is silent until the wind-down.
  assert.deepEqual(computeNudgeTimes(15 * M, 1, DEFAULT_INTERVAL_MIN), []);
  // And the default is what an unset domain gets.
  assert.deepEqual(computeNudgeTimes(15 * M, 1), []);
});

test('computeNudgeTimes: count grows linearly with length at a fixed interval', () => {
  const at = eff => computeNudgeTimes(eff, 5, 10).length;
  assert.equal(at(30 * M), 2);   // 10, 20
  assert.equal(at(60 * M), 5);   // 10..50
  assert.equal(at(120 * M), 11); // 10..110
});

// ---------------------------------------------------------------------------
// CASE 8 — wind-down only at the extended tail (after carryover + grace)
// ---------------------------------------------------------------------------

test('windDownState: not active at base-60 when session has carryover+grace', () => {
  const s = startSession({ dailyTotal: 0, baseLength: 30 * M, carryover: 5 * M, graceSeconds: 1 * M });
  const eff = effectiveLength(s); // 36 min
  // At base - 60 (29 min in) — would be wind-down on a plain 30-min session,
  // but here the real end is 36 min, so NOT active.
  assert.equal(windDownState(s, 30 * M - WIND_DOWN_DURATION).active, false);
  // At the true tail (eff - 60) — active.
  assert.equal(windDownState(s, eff - WIND_DOWN_DURATION).active, true);
  // One second before the very end — progress near 1.
  const wd = windDownState(s, eff - 1);
  assert.ok(wd.progress > 0.9 && wd.progress <= 1);
});

// ---------------------------------------------------------------------------
// CASE 9 — cooldown length: increment in seconds, 0 = immediate roll-over
// ---------------------------------------------------------------------------

test('naturalEnd: cooldown = sessionNum * increment (seconds)', () => {
  const s3 = startSession({ dailyTotal: 0, baseLength: 30 * M, sessionNum: 3 });
  const r = naturalEnd(s3, { dailyTotal: 30 * M, cooldownIncrement: 5 * M });
  assert.equal(r.cooldownSeconds, 15 * M); // 3 * 5 min
  assert.equal(r.nextSession.sessionNum, 4);
  assert.equal(r.nextSession.carryover, 0); // natural end consumes carryover
});

test('naturalEnd: increment 0 → 0 cooldown (limit still fires, immediate roll-over)', () => {
  const s = startSession({ dailyTotal: 0, baseLength: 30 * M, sessionNum: 1 });
  const r = naturalEnd(s, { dailyTotal: 30 * M, cooldownIncrement: 0 });
  assert.equal(r.cooldownSeconds, 0);     // no wait
  assert.equal(r.nextSession.sessionNum, 2); // but the session DID end & rolled over
});

test('cooldown increment is seconds-granular (not minute-rounded)', () => {
  const s = startSession({ dailyTotal: 0, baseLength: 30 * M, sessionNum: 2 });
  // 90-second increment → session 2 cooldown = 180s. Proves sub-minute works.
  const r = naturalEnd(s, { dailyTotal: 30 * M, cooldownIncrement: 90 });
  assert.equal(r.cooldownSeconds, 180);
});

// ---------------------------------------------------------------------------
// CASE 10 — endEarly with nothing left (covered above) + grace formula
// ---------------------------------------------------------------------------

test('computeGraceSeconds: floor of 10% of given-up time', () => {
  assert.equal(computeGraceSeconds(10 * M), 1 * M);
  assert.equal(computeGraceSeconds(55), 5);  // floor(5.5)
  assert.equal(computeGraceSeconds(0), 0);
});

// ---------------------------------------------------------------------------
// Scheduling — session-relative deadlines as absolute instants (MV3 port).
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

test('endsAtSessionTime / windDownAtSessionTime track effectiveLength', () => {
  const s = startSession({ dailyTotal: 0, baseLength: 30 * M, carryover: 2 * M });
  assert.equal(endsAtSessionTime(s), 32 * M);
  assert.equal(windDownAtSessionTime(s), 32 * M - WIND_DOWN_DURATION);
});

test('windDownAtSessionTime never goes negative on a very short session', () => {
  const s = startSession({ dailyTotal: 0, baseLength: 30 });
  assert.equal(windDownAtSessionTime(s), 0);
});

test('secondsUntil measures running-clock seconds from current elapsed', () => {
  const s = startSession({ dailyTotal: 100, baseLength: 30 * M });
  // 5 minutes of the session already elapsed.
  assert.equal(secondsUntil(s, 100 + 5 * M, endsAtSessionTime(s)), 25 * M);
});

test('instantFor converts to epoch ms, and returns null once due', () => {
  const s = startSession({ dailyTotal: 0, baseLength: 30 * M });
  assert.equal(instantFor(s, 10 * M, 30 * M, NOW), NOW + 20 * M * 1000);
  // Exactly due and past due both schedule nothing — the caller acts now.
  assert.equal(instantFor(s, 30 * M, 30 * M, NOW), null);
  assert.equal(instantFor(s, 31 * M, 30 * M, NOW), null);
});

test('scheduleFor returns wind-down and end, sorted, ahead of the deadline', () => {
  const s = startSession({ dailyTotal: 0, baseLength: 30 * M });
  const wakes = scheduleFor(s, 0, NOW);
  const kinds = wakes.map(w => w.kind);
  assert.ok(kinds.includes('windDown'));
  assert.equal(kinds[kinds.length - 1], 'sessionEnd');
  // Sorted ascending by instant.
  const ats = wakes.map(w => w.at);
  assert.deepEqual(ats, [...ats].sort((a, b) => a - b));
  const end = wakes.find(w => w.kind === 'sessionEnd');
  assert.equal(end.at, NOW + 30 * M * 1000);
  const wd = wakes.find(w => w.kind === 'windDown');
  assert.equal(wd.at, NOW + (30 * M - WIND_DOWN_DURATION) * 1000);
});

test('scheduleFor drops deadlines already behind us', () => {
  const s = startSession({ dailyTotal: 0, baseLength: 30 * M });
  // Inside the wind-down window: only the session end is still schedulable.
  const wakes = scheduleFor(s, 30 * M - 10, NOW);
  assert.deepEqual(wakes.map(w => w.kind), ['sessionEnd']);
  assert.equal(wakes[0].at, NOW + 10 * 1000);
});

test('scheduleFor excludes already-fired nudges so re-arming cannot replay them', () => {
  const s = startSession({ dailyTotal: 0, baseLength: 60 * M });
  const times = computeNudgeTimes(effectiveLength(s), s.nudgeSeed);
  assert.ok(times.length > 0, 'need nudges for this test to mean anything');
  const marked = markNudgeFired(s, times[0]);
  const before = scheduleFor(s, 0, NOW).filter(w => w.kind === 'nudge').map(w => w.sessionTime);
  const after = scheduleFor(marked, 0, NOW).filter(w => w.kind === 'nudge').map(w => w.sessionTime);
  assert.deepEqual(before, times);
  assert.deepEqual(after, times.slice(1));
});

test('scheduleFor after a live length change reflects the new deadline', () => {
  const s = startSession({ dailyTotal: 0, baseLength: 30 * M });
  const { session: longer } = changeLength(s, { dailyTotal: 10 * M, newBaseLength: 45 * M });
  const end = scheduleFor(longer, 10 * M, NOW).find(w => w.kind === 'sessionEnd');
  // 45m limit, 10m elapsed → 35m of running clock left.
  assert.equal(end.at, NOW + 35 * M * 1000);
});

test('scheduled instants agree with the live state derivers at those instants', () => {
  // The whole design rests on these two paths not drifting apart: the alarm
  // fires at scheduleFor's instant, and the handler then asks windDownState /
  // displayFor whether it is really due.
  const s = startSession({ dailyTotal: 0, baseLength: 30 * M });
  const wakes = scheduleFor(s, 0, NOW);
  for (const w of wakes) {
    const elapsedAtWake = (w.at - NOW) / 1000;
    const { remaining } = displayFor(s, elapsedAtWake);
    if (w.kind === 'sessionEnd') assert.equal(remaining, 0);
    if (w.kind === 'windDown') assert.equal(windDownState(s, elapsedAtWake).active, true);
  }
});

// ---------------------------------------------------------------------------
// shouldScheduleWakes — the guard around arming alarms.
// ---------------------------------------------------------------------------

test('shouldScheduleWakes requires a running clock, a session, and no cooldown', () => {
  const yes = { clockRunning: true, hasSession: true, inCooldown: false };
  assert.equal(shouldScheduleWakes(yes), true);
  // A paused clock: deadlines have no knowable instant.
  assert.equal(shouldScheduleWakes({ ...yes, clockRunning: false }), false);
  // No session yet: nothing to schedule against.
  assert.equal(shouldScheduleWakes({ ...yes, hasSession: false }), false);
  // Mid-cooldown: the session is not advancing.
  assert.equal(shouldScheduleWakes({ ...yes, inCooldown: true }), false);
});

// ---------------------------------------------------------------------------
// incrementSeconds — the minutes/seconds round-trip
// ---------------------------------------------------------------------------

test('incrementSeconds recovers whole seconds from every stepper combination', () => {
  // Settings persists coolMin + coolSec/60 and the shell multiplies by 60. That
  // round-trip is not exact in binary floating point, and 49 of these 3600
  // combinations land a hair BELOW the true second — which formatClock then
  // floors to one second short (a 4:30 increment displaying as 4:29).
  const wrong = [];
  for (let m = 0; m <= 59; m++) {
    for (let s = 0; s < 60; s++) {
      const stored = m + s / 60;
      const got = incrementSeconds(stored);
      if (got !== m * 60 + s) wrong.push(`${m}:${s} -> ${got}`);
    }
  }
  assert.deepEqual(wrong, [], 'these combinations do not survive the round-trip');
});

test('a recorded cooldown divides back out to its exact increment', () => {
  // What the past-day card does: cooldownSec / sessionNum to recover the
  // increment it was built from. Exact only because incrementSeconds rounded.
  for (const [m, s] of [[4, 30], [0, 31], [7, 17], [1, 1], [12, 59]]) {
    const inc = incrementSeconds(m + s / 60);
    for (let n = 1; n <= 12; n++) {
      const total = cooldownLength(n, inc);
      assert.equal(total / n, inc, `${m}:${s} x ${n} did not divide back out`);
      assert.ok(Number.isInteger(total), `${m}:${s} x ${n} is not whole seconds`);
    }
  }
});

test('incrementSeconds treats a missing increment as no cooldown', () => {
  assert.equal(incrementSeconds(undefined), 0);
  assert.equal(incrementSeconds(0), 0);
});
