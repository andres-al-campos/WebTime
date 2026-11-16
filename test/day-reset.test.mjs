// The day reset is stored as an hour plus a minute. Settings saved when it was
// an hour alone must read the same, and a minute past the hour must count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = join(mkdtempSync(join(tmpdir(), 'webtime-reset-test-')), 'utils.mjs');
await build({ entryPoints: ['src/shared/utils.ts'], bundle: true, format: 'esm', outfile: out, platform: 'node' });
const { dayResetMinutesOf, getLocalDateStr } = await import(pathToFileURL(out).href);

test('an hour saved alone reads as that hour', () => {
  assert.equal(dayResetMinutesOf({ dayResetTime: 4 }), 240);
  assert.equal(dayResetMinutesOf({}), 0);
  assert.equal(dayResetMinutesOf(undefined), 0);
});

test('the minute adds to the hour', () => {
  assert.equal(dayResetMinutesOf({ dayResetTime: 4, dayResetMinute: 30 }), 270);
});

test('before the reset minute it is still yesterday', () => {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.equal(getLocalDateStr(minutes + 1), key(yesterday), 'a reset one minute from now has not happened yet');
  assert.equal(getLocalDateStr(minutes), key(now), 'a reset this minute has happened');
});
