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
const { dayResetMinutesOf, getLocalDateStr, formatTimeOfDay, parseTimeOfDay, nextDayResetAt } = await import(pathToFileURL(out).href);

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

test('the reset time reads back as it was typed', () => {
  assert.equal(formatTimeOfDay(0), '00:00');
  assert.equal(formatTimeOfDay(270), '04:30');
  for (const [typed, minutes] of [['7', 420], ['7:30', 450], ['07:30', 450], ['730', 450], ['0005', 5], ['23:59', 1439]]) {
    assert.equal(parseTimeOfDay(typed), minutes, typed);
  }
});

test("what isn't a time is refused, not read as midnight", () => {
  for (const typed of ['', '24:00', '7:60', 'noon', '12345']) assert.equal(parseTimeOfDay(typed), null, typed);
});

const local = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();

test('before the reset time the next reset is later the same day', () => {
  assert.equal(nextDayResetAt(local(18, 3), 240), local(18, 4));
});

test('after the reset time the next reset is tomorrow', () => {
  assert.equal(nextDayResetAt(local(18, 15), 240), local(19, 4));
});

test('at the reset instant the next reset is a day away', () => {
  assert.equal(nextDayResetAt(local(18, 4), 240), local(19, 4));
});

test('a midnight reset is the coming midnight', () => {
  assert.equal(nextDayResetAt(local(18, 23, 59), 0), local(19, 0));
});
