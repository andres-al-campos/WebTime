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
const { shouldClockRun } = await import(pathToFileURL(outFile).href);

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
