// Tests for src/shared/display-trust.ts.
//
// This rule regressed once already: keyed on silence from the background, it
// hid the timer every 10s during ordinary reading, because under MV3 a silent
// background is the NORMAL state, not a fault. These tests pin the corrected
// rule so that can't come back.
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
const STALE = 60_000;

/** A running clock with the user active right now. */
function base(overrides = {}) {
  return {
    receivedAt: NOW - 1000,
    clockRunning: true,
    lastActivityTime: NOW,
    staleAfterMs: STALE,
    nowMs: NOW,
    ...overrides,
  };
}

test('nothing received yet is never verified', () => {
  assert.equal(displayIsVerified(base({ receivedAt: 0 })), false);
});

test('a stopped clock stays verified no matter how old', () => {
  // It isn't advancing, so the last value it reported is still correct.
  assert.equal(displayIsVerified(base({
    clockRunning: false,
    receivedAt: NOW - 86_400_000,
    lastActivityTime: NOW - 86_400_000,
  })), true);
});

test('a running clock is verified while the user is interacting', () => {
  assert.equal(displayIsVerified(base()), true);
});

test('a long-dead background does NOT invalidate the display', () => {
  // The regression case. The MV3 worker dies after ~30s, so receivedAt can be
  // far in the past while everything is working perfectly.
  assert.equal(displayIsVerified(base({
    receivedAt: NOW - 10 * 60 * 1000,
    lastActivityTime: NOW - 500,
  })), true);
});

test('a running clock goes unverified once the user stops interacting', () => {
  assert.equal(displayIsVerified(base({
    lastActivityTime: NOW - STALE - 1,
  })), false);
});

test('the staleness boundary is exclusive', () => {
  assert.equal(displayIsVerified(base({ lastActivityTime: NOW - STALE + 1 })), true);
  assert.equal(displayIsVerified(base({ lastActivityTime: NOW - STALE })), false);
});

test('verification does not depend on how old the last update is', () => {
  // Same activity, wildly different receivedAt — the answer must not change.
  const recent = displayIsVerified(base({ receivedAt: NOW - 100 }));
  const ancient = displayIsVerified(base({ receivedAt: NOW - 3_600_000 }));
  assert.equal(recent, ancient);
});
