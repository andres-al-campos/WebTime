// Tests for src/shared/display-trust.ts.
//
// This rule has been keyed both ways, so the history is worth stating:
//
//   1. Keyed on background silence. Wrong while the MV3 worker was dying every
//      ~30s — silence was the normal state, and the timer hid itself during
//      ordinary reading.
//   2. Keyed on local user input. Fixed that, but decided visibility from a
//      number unrelated to the user's inactivity setting: the timer vanished on
//      its own 60s schedule while the settings screen said 30s.
//   3. Keyed on background silence again, because the keep-alive document
//      (src/offscreen.ts) keeps the worker up and updates arriving every second.
//      Silence carries information once more.
//
// Step 3 is only correct while the keep-alive holds. These tests pin the rule;
// the thing that would invalidate them is the worker dying again, which is what
// test/manifest-chrome.test.mjs guards by asserting the offscreen wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = mkdtempSync(join(tmpdir(), 'webtime-trust-test-'));
const outFile = join(out, 'display-trust.mjs');
await build({
  entryPoints: ['src/shared/display-trust.ts'],
  bundle: true,
  format: 'esm',
  outfile: outFile,
});
const { displayIsVerified } = await import(pathToFileURL(outFile).href);

const NOW = 1_000_000;
const STALE = 5_000;

/** A running clock updated a moment ago. */
function base(overrides = {}) {
  return {
    receivedAt: NOW - 1000,
    clockRunning: true,
    staleAfterMs: STALE,
    nowMs: NOW,
    ...overrides,
  };
}

test('nothing received yet is never verified', () => {
  assert.equal(displayIsVerified(base({ receivedAt: 0 })), false);
});

test('a stopped clock stays verified no matter how old', () => {
  // It isn't advancing, so the last value it reported is still correct. This is
  // what makes an idle user see a frozen-but-accurate number rather than a gap.
  assert.equal(displayIsVerified(base({
    clockRunning: false,
    receivedAt: NOW - 86_400_000,
  })), true);
});

test('a running clock is verified while updates keep arriving', () => {
  assert.equal(displayIsVerified(base()), true);
});

test('a running clock goes unverified once the background falls silent', () => {
  // The worker died or the port dropped. We can no longer tell whether time is
  // still accruing, so we stop showing a number instead of showing a wrong one.
  assert.equal(displayIsVerified(base({ receivedAt: NOW - STALE - 1 })), false);
});

test('the staleness boundary is exclusive', () => {
  assert.equal(displayIsVerified(base({ receivedAt: NOW - STALE + 1 })), true);
  assert.equal(displayIsVerified(base({ receivedAt: NOW - STALE })), false);
});

test('a slow tick is tolerated without flicker', () => {
  // The background sends once a second; the grace window has to absorb a couple
  // of missed ticks or the timer would blink on ordinary scheduling jitter.
  assert.equal(displayIsVerified(base({ receivedAt: NOW - 2500 })), true);
});

test('local user input does not enter the rule', () => {
  // Guards against reintroducing step 2. Whether the user is touching the page
  // is the background's business — it stops the clock and says so via
  // clockRunning. Passing activity here must not change the answer.
  const quiet = displayIsVerified(base({ lastActivityTime: NOW - 3_600_000 }));
  const busy = displayIsVerified(base({ lastActivityTime: NOW }));
  assert.equal(quiet, busy);
  assert.equal(quiet, true);
});
