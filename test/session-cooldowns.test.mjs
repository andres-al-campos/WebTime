// Tests for src/shared/session-cooldowns.ts: the cooldown between sessions grows by
// √n, and an early end takes only the share it used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = mkdtempSync(join(tmpdir(), 'webtime-cooldowns-test-'));
const outFile = join(out, 'session-cooldowns.mjs');
await build({ entryPoints: ['src/shared/session-cooldowns.ts'], bundle: true, format: 'esm', outfile: outFile, platform: 'node' });
const { cooldownSeconds, cooldownLeft, DEFAULT_COOLDOWN_MIN } = await import(pathToFileURL(outFile).href);

test('cooldowns grow by the square root of the session number', () => {
  const mins = [1, 2, 3, 4, 5].map(n => Math.round(cooldownSeconds(n, 5) / 6) / 10);
  assert.deepEqual(mins, [5, 7.1, 8.7, 10, 11.2]);
});

test('the default first cooldown is 5 minutes', () => {
  assert.equal(DEFAULT_COOLDOWN_MIN, 5);
});

test('an early end takes the cooldown in proportion to what it used', () => {
  assert.equal(cooldownSeconds(4, 5, 0.5), cooldownSeconds(4, 5) / 2);
  assert.equal(cooldownSeconds(1, 5, 0), 0);
});

test('a share past the session counts as the whole session', () => {
  assert.equal(cooldownSeconds(1, 5, 1.4), 300);
});

test('0 minutes turns cooldowns off', () => {
  assert.equal(cooldownSeconds(3, 0), 0);
});

test('cooldownLeft counts down to 0 and stays there', () => {
  assert.equal(cooldownLeft(10_000, 4_000), 6);
  assert.equal(cooldownLeft(10_000, 10_000), 0);
  assert.equal(cooldownLeft(undefined, 1), 0);
});
