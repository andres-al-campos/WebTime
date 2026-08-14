// Tests for src/shared/clock-gates.ts.
//
// The headline case: a playing video must keep counting. Watching one means no
// keyboard or mouse input for minutes, which chrome.idle reports as an idle
// machine — so an idle gate placed ahead of the audible check stops the clock
// ~30s into every video. That shipped, and these pin the ordering that fixes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = mkdtempSync(join(tmpdir(), 'webtime-gates-test-'));
const outFile = join(out, 'clock-gates.mjs');
await build({
  entryPoints: ['src/shared/clock-gates.ts'],
  bundle: true,
  format: 'esm',
  outfile: outFile,
});
const { shouldClockRun, clockVerdict } = await import(pathToFileURL(outFile).href);

/** Everything permitting the clock to run: focused, engaged, nothing blocking. */
function base(overrides = {}) {
  return {
    browserIsFocused: true,
    trackedDomain: 'youtube.com',
    inCooldown: false,
    endSessionConfirmOpen: false,
    averagePopupOpen: false,
    osIdleState: 'active',
    activeTabAudible: false,
    tabIsEngaged: true,
    ...overrides,
  };
}

test('an ordinary engaged tab counts', () => {
  assert.equal(shouldClockRun(base()), true);
});

// --- the video case --------------------------------------------------------

test('a playing video keeps counting once the machine looks idle', () => {
  // The reported bug. Sitting still watching = no input = chrome.idle says
  // 'idle', and the clock stopped ~30s in even though the video was playing.
  assert.equal(shouldClockRun(base({
    osIdleState: 'idle',
    activeTabAudible: true,
    tabIsEngaged: false,
  })), true);
});

test('a playing video keeps counting once the tab looks disengaged', () => {
  // The Firefox showing of the same bug. chrome.idle stays 'active' there, so
  // the idle gate never fires and the per-tab engagement test is what expires
  // after the inactivity threshold. Audio has to outrank that too — and the
  // caller must consult this function rather than testing engagement alone.
  assert.equal(shouldClockRun(base({
    osIdleState: 'active',
    activeTabAudible: true,
    tabIsEngaged: false,
  })), true);
});

test('audio outranks the idle gate specifically', () => {
  // Same state, audio off: this is the case the idle gate is FOR.
  assert.equal(shouldClockRun(base({
    osIdleState: 'idle',
    activeTabAudible: false,
    tabIsEngaged: false,
  })), false);
});

test('audio does not override a locked machine', () => {
  // A video playing to a lock screen is not time the user is spending.
  assert.equal(shouldClockRun(base({
    osIdleState: 'locked',
    activeTabAudible: true,
  })), false);
});

test('audio does not override an unfocused browser', () => {
  // Music in a background window while the user works in another app.
  assert.equal(shouldClockRun(base({
    browserIsFocused: false,
    activeTabAudible: true,
  })), false);
});

test('audio does not override a cooldown', () => {
  // Cooldown means the timer is deliberately frozen; audio must not resume it.
  assert.equal(shouldClockRun(base({
    inCooldown: true,
    activeTabAudible: true,
  })), false);
});

test('audio does not override the blocking popups', () => {
  for (const key of ['endSessionConfirmOpen', 'averagePopupOpen']) {
    assert.equal(
      shouldClockRun(base({ [key]: true, activeTabAudible: true })),
      false,
      `${key} should still freeze the clock`,
    );
  }
});

// --- the other gates -------------------------------------------------------

test('an unfocused browser does not count', () => {
  assert.equal(shouldClockRun(base({ browserIsFocused: false })), false);
});

test('no trackable domain does not count', () => {
  assert.equal(shouldClockRun(base({ trackedDomain: null })), false);
});

test('a cooldown freezes the clock', () => {
  assert.equal(shouldClockRun(base({ inCooldown: true })), false);
});

test('an open confirmation or average popup freezes the clock', () => {
  assert.equal(shouldClockRun(base({ endSessionConfirmOpen: true })), false);
  assert.equal(shouldClockRun(base({ averagePopupOpen: true })), false);
});

test('a locked machine does not count', () => {
  assert.equal(shouldClockRun(base({ osIdleState: 'locked' })), false);
});

test('a disengaged tab does not count even when the machine is active', () => {
  // Reading with the mouse still is covered by tabIsEngaged, not by chrome.idle.
  assert.equal(shouldClockRun(base({ tabIsEngaged: false })), false);
});

// --- the verdict -----------------------------------------------------------
//
// clockVerdict() names which gate decided, so a stop in the debug trace says
// WHY. shouldClockRun() is derived from it, so the risk this introduces is the
// two disagreeing — the exact two-deciders shape that caused the audible bug.

test('each gate reports itself by name', () => {
  assert.equal(clockVerdict(base()), 'running');
  assert.equal(clockVerdict(base({ activeTabAudible: true })), 'audible');
  assert.equal(clockVerdict(base({ browserIsFocused: false })), 'unfocused');
  assert.equal(clockVerdict(base({ trackedDomain: null })), 'untracked');
  assert.equal(clockVerdict(base({ inCooldown: true })), 'cooldown');
  assert.equal(
    clockVerdict(base({ endSessionConfirmOpen: true })),
    'end-session-confirm',
  );
  assert.equal(clockVerdict(base({ averagePopupOpen: true })), 'average-popup');
  assert.equal(clockVerdict(base({ osIdleState: 'locked' })), 'locked');
  assert.equal(clockVerdict(base({ osIdleState: 'idle' })), 'os-idle');
  assert.equal(clockVerdict(base({ tabIsEngaged: false })), 'tab-unengaged');
});

test('the verdict and the boolean never disagree', () => {
  // Exhaustive over every combination of the gate inputs: if any input tuple
  // makes clockVerdict() say "running"/"audible" while shouldClockRun() says
  // false (or vice versa), the two have drifted apart.
  const bools = [false, true];
  const idleStates = ['active', 'idle', 'locked'];
  let checked = 0;

  for (const browserIsFocused of bools)
  for (const trackedDomain of [null, 'youtube.com'])
  for (const inCooldown of bools)
  for (const endSessionConfirmOpen of bools)
  for (const averagePopupOpen of bools)
  for (const osIdleState of idleStates)
  for (const activeTabAudible of bools)
  for (const tabIsEngaged of bools) {
    const input = {
      browserIsFocused, trackedDomain, inCooldown, endSessionConfirmOpen,
      averagePopupOpen, osIdleState, activeTabAudible, tabIsEngaged,
    };
    const v = clockVerdict(input);
    assert.equal(
      shouldClockRun(input),
      v === 'running' || v === 'audible',
      `disagreement at ${JSON.stringify(input)} (verdict: ${v})`,
    );
    checked++;
  }

  assert.equal(checked, 2 * 2 * 2 * 2 * 2 * 3 * 2 * 2);
});

test('a video ending falls through to engagement, it does not force a stop', () => {
  // The reported stutter: audio ends and the clock stops for a beat. Losing
  // audio must NOT be a stop on its own — it just stops short-circuiting, and
  // an engaged user keeps counting through the transition.
  const watching = base({ activeTabAudible: true, tabIsEngaged: true });
  assert.equal(clockVerdict(watching), 'audible');

  const videoEnded = { ...watching, activeTabAudible: false };
  assert.equal(clockVerdict(videoEnded), 'running');
  assert.equal(shouldClockRun(videoEnded), true);
});
