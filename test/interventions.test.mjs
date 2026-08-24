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

// ── Concurrent intervention passes must not double-fire a nudge ─────────────
// Reported as "3 nudges in a row on a tab I hadn't used in hours". Three
// unserialized drivers (the per-second tick, the heartbeat, every wake alarm)
// all call checkForInterventions, which awaits settings BEFORE deciding. They
// resume against the same unmarked session and each fire the same nudge.
// A pass that reads the session, awaits, then writes firedNudges — the exact
// shape of checkForInterventions. `run` decides whether the three overlapping
// callers are coalesced or not; `sent` counts real sendNudge() calls.
function nudgeBurst(coalesce) {
  const M = 60;
  const session = {
    sessionNum: 1, startDaily: 0, baseLength: 30 * M,
    carryover: 0, graceSeconds: 0, nudgeSeed: 42, firedNudges: [],
  };
  let state = session;
  let sent = 0;

  const pass = async () => {
    const snapshot = state;                    // read
    await new Promise(r => setTimeout(r, 0));  // the settings load
    const outcome = checkNudge({
      session: snapshot, dailyTotal: 10 * M,
      sessionLimitSeconds: 30 * M, nudgeInterval: 3,
    });
    if (!outcome) return;
    sent++;                                    // sendNudge()
    state = outcome.session;                   // write firedNudges
  };

  // Exactly what background.ts does: check the slot, fill it, clear on settle.
  let inFlight = null;
  const call = coalesce
    ? () => {
        if (inFlight) return inFlight;
        inFlight = pass().finally(() => { inFlight = null; });
        return inFlight;
      }
    : pass;

  return Promise.all([call(), call(), call()]).then(() => sent);
}

test('unserialized passes each fire the same nudge — the reported burst', async () => {
  assert.equal(await nudgeBurst(false), 3,
    'the bug is real: three overlapping passes send three nudges for one nudge time');
});

test('coalescing collapses overlapping passes to a single nudge', async () => {
  assert.equal(await nudgeBurst(true), 1,
    'joining the in-flight pass must send exactly one nudge');
});

test('background coalesces its intervention passes', async () => {
  const { readFileSync } = await import('node:fs');
  const bg = readFileSync('src/background.ts', 'utf8');

  // The await sits between reading the session and marking the nudge fired, so
  // overlapping passes are the whole problem. Nothing may call the async body
  // directly except the coalescing wrapper.
  assert.match(bg, /let interventionPass: Promise<void> \| null = null;/,
    'an in-flight pass must be tracked');
  assert.match(bg, /if \(interventionPass\) return interventionPass;/,
    'an overlapping caller must join the in-flight pass');
  assert.match(bg, /\.finally\(\(\) => \{ interventionPass = null; \}\)/,
    'the slot must clear even when a pass throws, or interventions stop for good');

  // The declaration matches too, so exclude it: only one CALL may exist.
  const calls = (bg.match(/(?<!function )runInterventionPass\(\)/g) || []);
  assert.equal(calls.length, 1,
    'runInterventionPass must be called only by the coalescing wrapper');
});
