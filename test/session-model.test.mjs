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
  naturalEnd, endEarly, changeLength, cooldownLength,
  computeGraceSeconds, computeNudgeTimes, nextNudgeToFire, markNudgeFired,
  windDownState, WIND_DOWN_DURATION,
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
const NUDGE_MIN_GAP = 120;
const NUDGE_DECAY = 1.8;

test('computeNudgeTimes: deterministic for a given seed', () => {
  const eff = 55 * M;
  const a = computeNudgeTimes(eff, 12345);
  const b = computeNudgeTimes(eff, 12345);
  assert.deepEqual(a, b); // same seed → identical times, every call
});

test('computeNudgeTimes: different seeds give different times', () => {
  const eff = 55 * M;
  const a = computeNudgeTimes(eff, 1);
  const b = computeNudgeTimes(eff, 999999);
  // Overwhelmingly likely to differ; assert at least one element differs.
  assert.notDeepEqual(a, b);
});

test('startSession: regenerates a fresh seed each session', () => {
  // Across many sessions the seeds should not all be identical.
  const seeds = new Set();
  for (let i = 0; i < 20; i++) {
    seeds.add(startSession({ dailyTotal: 0, baseLength: 30 * M }).nudgeSeed);
  }
  assert.ok(seeds.size > 1, 'expected fresh randomness across sessions');
});

test('computeNudgeTimes: jitter stays within ±30s of the un-jittered base', () => {
  const eff = 55 * M;
  // Un-jittered base times for the same decay/window/floor logic.
  const baseTimes = [];
  for (let i = 1; i <= 3; i++) {
    const b = Math.round(eff - eff / Math.pow(NUDGE_DECAY, i));
    baseTimes.push(b);
  }
  // Try many seeds; every produced time must be within JITTER of *some* base time.
  for (let seed = 0; seed < 200; seed++) {
    const times = computeNudgeTimes(eff, seed);
    for (const t of times) {
      const nearest = baseTimes.reduce((best, b) =>
        Math.abs(b - t) < Math.abs(best - t) ? b : best, baseTimes[0]);
      assert.ok(
        Math.abs(t - nearest) <= NUDGE_JITTER,
        `time ${t} is more than ${NUDGE_JITTER}s from any base (${baseTimes})`
      );
    }
  }
});

test('computeNudgeTimes: never two nudges closer than the min-gap floor', () => {
  // Force many attempts on a long session so bunching WOULD happen without the floor.
  const eff = 120 * M;
  for (let seed = 0; seed < 100; seed++) {
    const times = computeNudgeTimes(eff, seed, 12); // request 12 → floor prunes
    for (let i = 1; i < times.length; i++) {
      assert.ok(
        times[i] - times[i - 1] >= NUDGE_MIN_GAP,
        `gap ${times[i] - times[i - 1]}s < floor ${NUDGE_MIN_GAP}s (seed ${seed})`
      );
    }
  }
});

test('computeNudgeTimes: no nudge inside the final wind-down window', () => {
  const eff = 55 * M;
  for (let seed = 0; seed < 100; seed++) {
    for (const t of computeNudgeTimes(eff, seed)) {
      assert.ok(t <= eff - WIND_DOWN_DURATION, `nudge ${t} intrudes on wind-down`);
      assert.ok(t >= 60, `nudge ${t} too early`);
    }
  }
});

test('computeNudgeTimes: overrideCount=0 disables nudges', () => {
  assert.deepEqual(computeNudgeTimes(55 * M, 1, 0), []);
});

test('computeNudgeTimes: remaining time shrinks by ~DECAY each nudge (shape)', () => {
  // With no jitter influence on the relationship, the *base* schedule should
  // have each successive "remaining at nudge" be ~1/DECAY of the previous.
  const eff = 90 * M;
  // Average over seeds to wash out jitter, then check the ratio of remainings.
  const times = computeNudgeTimes(eff, 7);
  assert.ok(times.length >= 2);
  const rem = times.map(t => eff - t);
  for (let i = 1; i < rem.length; i++) {
    const ratio = rem[i - 1] / rem[i]; // should be ~DECAY
    assert.ok(ratio > 1.4 && ratio < 2.3, `ratio ${ratio.toFixed(2)} not ~${NUDGE_DECAY}`);
  }
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
