// Tests for src/shared/interventions.ts — which intervention is due.
//
// These decisions used to live inside background.ts, tangled with the tab
// messaging and ticker plumbing that fires them, so they could only be
// exercised by running the extension.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = mkdtempSync(join(tmpdir(), 'webtime-interventions-test-'));
const outFile = join(out, 'interventions.mjs');
await build({
  entryPoints: ['src/shared/interventions.ts'],
  bundle: true,
  format: 'esm',
  outfile: outFile,
});
const { checkSessionLimit, checkNudge } = await import(pathToFileURL(outFile).href);

const modelFile = join(out, 'session-model.mjs');
await build({
  entryPoints: ['src/shared/session-model.ts'],
  bundle: true,
  format: 'esm',
  outfile: modelFile,
});
const { startSession } = await import(pathToFileURL(modelFile).href);

/** A session of `baseLength` starting at daily total 0. */
function session(baseLength = 600, overrides = {}) {
  return { ...startSession({ dailyTotal: 0, baseLength }), ...overrides };
}

// --- session limit ---------------------------------------------------------

test('a session with time left continues', () => {
  const outcome = checkSessionLimit({
    session: session(600),
    dailyTotal: 300,
    sessionLimitSeconds: 600,
    cooldownIncrementSeconds: 60,
    cooldownEndsAt: 0,
    now: 1000,
  });
  assert.equal(outcome.kind, 'continue');
});

test('a session that reached its limit fires a cooldown', () => {
  const s = session(600);
  const outcome = checkSessionLimit({
    session: s,
    dailyTotal: 600,
    sessionLimitSeconds: 600,
    cooldownIncrementSeconds: 60,
    cooldownEndsAt: 0,
    now: 1000,
  });
  assert.equal(outcome.kind, 'limit-reached');
  assert.equal(outcome.endedSessionNum, s.sessionNum);
  assert.ok(outcome.result.cooldownSeconds > 0);
  assert.equal(outcome.result.nextSession.sessionNum, s.sessionNum + 1);
});

test('an active cooldown short-circuits before the limit is considered', () => {
  // Distinct from 'continue': the caller must stop running other interventions.
  const outcome = checkSessionLimit({
    session: session(600),
    dailyTotal: 600,
    sessionLimitSeconds: 600,
    cooldownIncrementSeconds: 60,
    cooldownEndsAt: 5000,
    now: 1000,
  });
  assert.equal(outcome.kind, 'in-cooldown');
});

test('a cooldown that has expired no longer short-circuits', () => {
  const outcome = checkSessionLimit({
    session: session(600),
    dailyTotal: 300,
    sessionLimitSeconds: 600,
    cooldownIncrementSeconds: 60,
    cooldownEndsAt: 900,
    now: 1000,
  });
  assert.equal(outcome.kind, 'continue');
});

test('no session limit configured means nothing to enforce', () => {
  const outcome = checkSessionLimit({
    session: session(600),
    dailyTotal: 99999,
    sessionLimitSeconds: 0,
    cooldownIncrementSeconds: 60,
    cooldownEndsAt: 0,
    now: 1000,
  });
  assert.equal(outcome.kind, 'continue');
});

test('grace and carryover push the limit out', () => {
  // Both are baked into effectiveLength, so a session at its base length but
  // holding carryover has not actually ended.
  const s = session(600, { carryover: 120 });
  const outcome = checkSessionLimit({
    session: s,
    dailyTotal: 600,
    sessionLimitSeconds: 600,
    cooldownIncrementSeconds: 60,
    cooldownEndsAt: 0,
    now: 1000,
  });
  assert.equal(outcome.kind, 'continue');
});

// --- nudges ----------------------------------------------------------------

test('no nudge is due at the very start of a session', () => {
  assert.equal(checkNudge({
    session: session(600),
    dailyTotal: 0,
    sessionLimitSeconds: 600,
  }), null);
});

test('a nudge that comes due returns a session marking it fired', () => {
  // 3-minute interval: at the 20m default a 10m session gets no nudge at all.
  const s = session(600);
  let fired = null;
  let current = s;
  for (let t = 0; t <= 600 && !fired; t += 5) {
    const outcome = checkNudge({
      session: current, dailyTotal: t, sessionLimitSeconds: 600, nudgeInterval: 3,
    });
    if (outcome) fired = { outcome, t };
  }
  assert.ok(fired, 'expected some nudge to come due within the session');

  const { outcome, t } = fired;
  assert.notEqual(outcome.session, current, 'must return an updated session');

  // Same instant, now using the returned session: must not re-fire.
  assert.equal(checkNudge({
    session: outcome.session, dailyTotal: t, sessionLimitSeconds: 600, nudgeInterval: 3,
  }), null, 'a fired nudge must not fire again');
});

test('a session shorter than the nudge interval is silent', () => {
  // The cost of a fixed interval, pinned: 10 minutes at the 20m default
  // produces nothing but the wind-down.
  const s = session(600);
  for (let t = 0; t <= 600; t += 5) {
    assert.equal(
      checkNudge({ session: s, dailyTotal: t, sessionLimitSeconds: 600 }),
      null,
      `unexpected nudge at ${t}s`
    );
  }
});

test('no nudge without a session limit', () => {
  assert.equal(checkNudge({
    session: session(600),
    dailyTotal: 300,
    sessionLimitSeconds: 0,
  }), null);
});
