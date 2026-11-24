// Tests for src/shared/session-model.ts.
// Run with: npm test  (or: node --test test/session-model.test.mjs)
// Compiles the module inline via esbuild, then runs assertions.
//
// Headline cases: live-length-change (shrink preserves elapsed time) and
// carryover baked in at session birth (wind-down only at the true extended
// tail).
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
  changeLength, cooldownLength, computeNudgeTimes, nextNudgeToFire, markNudgeFired,
  windDownState, windDownProgress, WIND_DOWN_DURATION,
  endsAtSessionTime, windDownAtSessionTime, secondsUntil, instantFor, scheduleFor,
  shouldScheduleWakes,
} = mod;

const M = 60;

// ---------------------------------------------------------------------------
// Derivers
// ---------------------------------------------------------------------------

test('effectiveLength sums base + carryover', () => {
  const s = startSession({ dailyTotal: 0, baseLength: 30 * M, carryover: 6 * M });
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
// CASE 2 — shrink past elapsed → expired (caller ends the session)
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
// cooldownLength — still read by past-day cards for records from before refills
// ---------------------------------------------------------------------------

test('cooldownLength: no increment configured means no cooldown to quote', () => {
  assert.equal(cooldownLength(4, 0), 0);
});


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
  const times = computeNudgeTimes(effectiveLength(s), s.nudgeSeed, 3);
  assert.ok(times.length >= 2, 'need >=2 nudges for this case');
  // Past the second nudge with none fired → should return the second (latest eligible).
  const due = nextNudgeToFire(s, times[1] + 5, 3);
  assert.equal(due, times[1]);
});

// ---------------------------------------------------------------------------
// Nudge spacing: determinism, jitter bound, min-gap floor, decay shape
// ---------------------------------------------------------------------------

const NUDGE_JITTER = 30;
const PHI = (1 + Math.sqrt(5)) / 2;

test('computeNudgeTimes: deterministic for a given seed', () => {
  const eff = 55 * M;
  assert.deepEqual(computeNudgeTimes(eff, 12345, 3), computeNudgeTimes(eff, 12345, 3));
});

test('computeNudgeTimes: different seeds give different times', () => {
  const eff = 120 * M;
  assert.notDeepEqual(computeNudgeTimes(eff, 1, 3), computeNudgeTimes(eff, 999999, 3));
});

test('startSession: regenerates a fresh seed each session', () => {
  const seeds = new Set();
  for (let i = 0; i < 20; i++) {
    seeds.add(startSession({ dailyTotal: 0, baseLength: 30 * M }).nudgeSeed);
  }
  assert.ok(seeds.size > 1, 'expected fresh randomness across sessions');
});

test('computeNudgeTimes: one nudge by default, about 38% in', () => {
  for (let seed = 0; seed < 30; seed++) {
    const times = computeNudgeTimes(30 * M, seed);
    assert.equal(times.length, 1);
    assert.ok(Math.abs(times[0] - 30 * M * (1 - 1 / PHI)) <= NUDGE_JITTER, `${times[0]}s`);
  }
});

test('computeNudgeTimes: the count you set is the count you get', () => {
  for (const count of [1, 2, 3, 4]) {
    assert.equal(computeNudgeTimes(40 * M, 7, count).length, count);
  }
});

test('computeNudgeTimes: nudges sit at the same fractions of any length', () => {
  for (const eff of [12 * M, 40 * M, 90 * M]) {
    const times = computeNudgeTimes(eff, 3, 3);
    const window = Math.min(NUDGE_JITTER, eff / 20);
    times.forEach((t, i) => {
      const target = eff - eff / PHI ** (i + 1);
      assert.ok(Math.abs(t - target) <= window + 1, `${t}s vs ${Math.round(target)}s in ${eff / M}m`);
    });
  }
});

test('computeNudgeTimes: gaps shrink toward the end', () => {
  const times = computeNudgeTimes(60 * M, 11, 4);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] < gaps[i - 1], `gaps ${gaps}`);
});

test('computeNudgeTimes: no nudge in the first minute or the final wind-down', () => {
  for (const eff of [3 * M, 12 * M, 55 * M]) {
    for (let seed = 0; seed < 60; seed++) {
      for (const t of computeNudgeTimes(eff, seed, 6)) {
        assert.ok(t <= eff - WIND_DOWN_DURATION, `nudge ${t} intrudes on wind-down`);
        assert.ok(t >= 60, `nudge ${t} too early`);
      }
    }
  }
});

test('computeNudgeTimes: 0 disables nudges', () => {
  assert.deepEqual(computeNudgeTimes(55 * M, 1, 0), []);
});

// ---------------------------------------------------------------------------
// CASE 8 — wind-down only at the extended tail (after carryover)
// ---------------------------------------------------------------------------

test('windDownState: not active at base-60 when session has carryover', () => {
  const s = startSession({ dailyTotal: 0, baseLength: 30 * M, carryover: 6 * M });
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

test('windDownProgress: the bar is the timer drawn as a line', () => {
  // Outside the final minute there is no bar.
  assert.equal(windDownProgress(0, 30 * M), null);
  assert.equal(windDownProgress(30 * M - 61, 30 * M), null);
  // Inside it, progress follows remaining and nothing else: the same timer
  // numbers give the same bar, so a paused clock is a paused bar.
  assert.equal(windDownProgress(30 * M - 60, 30 * M), 0);
  assert.equal(windDownProgress(30 * M - 30, 30 * M), 0.5);
  assert.equal(windDownProgress(30 * M, 30 * M), 1);
  // Time added mid-wind-down pushes remaining past a minute: the bar goes.
  assert.equal(windDownProgress(30 * M - 30, 31 * M), null);
  // Sessions shorter than the wind-down never show it.
  assert.equal(windDownProgress(10, 50), null);
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

test('shouldScheduleWakes requires a running clock and a session', () => {
  const yes = { clockRunning: true, hasSession: true };
  assert.equal(shouldScheduleWakes(yes), true);
  // A paused clock: deadlines have no knowable instant.
  assert.equal(shouldScheduleWakes({ ...yes, clockRunning: false }), false);
  // No session yet: nothing to schedule against.
  assert.equal(shouldScheduleWakes({ ...yes, hasSession: false }), false);
});

