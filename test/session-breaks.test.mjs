// Tests for src/shared/session-breaks.ts: the break between sessions grows by
// √n, and an early end takes only the share it used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = mkdtempSync(join(tmpdir(), 'webtime-breaks-test-'));
const outFile = join(out, 'session-breaks.mjs');
await build({ entryPoints: ['src/shared/session-breaks.ts'], bundle: true, format: 'esm', outfile: outFile, platform: 'node' });
const { breakSeconds, breakLeft, DEFAULT_BREAK_MIN } = await import(pathToFileURL(outFile).href);

test('breaks grow by the square root of the session number', () => {
  const mins = [1, 2, 3, 4, 5].map(n => Math.round(breakSeconds(n, 5) / 6) / 10);
  assert.deepEqual(mins, [5, 7.1, 8.7, 10, 11.2]);
});

test('the default first break is 5 minutes', () => {
  assert.equal(DEFAULT_BREAK_MIN, 5);
});

test('an early end takes the break in proportion to what it used', () => {
  assert.equal(breakSeconds(4, 5, 0.5), breakSeconds(4, 5) / 2);
  assert.equal(breakSeconds(1, 5, 0), 0);
});

test('a share past the session counts as the whole session', () => {
  assert.equal(breakSeconds(1, 5, 1.4), 300);
});

test('0 minutes turns breaks off', () => {
  assert.equal(breakSeconds(3, 0), 0);
});

test('breakLeft counts down to 0 and stays there', () => {
  assert.equal(breakLeft(10_000, 4_000), 6);
  assert.equal(breakLeft(10_000, 10_000), 0);
  assert.equal(breakLeft(undefined, 1), 0);
});
