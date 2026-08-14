// Tests for src/shared/session-history.ts.
//
// The point of this module is that a finished session survives being replaced.
// The shell keeps ONE session per domain, so the failures worth pinning are
// about fidelity of the record rather than arithmetic: a cooldown recomputed
// from settings would let a later settings change rewrite the past, and a
// `used` derived from a stale daily total would render a bar past its track.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = mkdtempSync(join(tmpdir(), 'webtime-history-test-'));
const outFile = join(out, 'session-history.mjs');
await build({
  entryPoints: ['src/shared/session-history.ts'],
  bundle: true,
  format: 'esm',
  outfile: outFile,
});
const {
  effectiveLengthOf,
  usedSecondsOf,
  toRecord,
  appendRecord,
  pruneHistory,
  sessionsFor,
  runningTotals,
} = await import(pathToFileURL(outFile).href);

/** A session anchored at `startDaily` with a 15m base. */
function session(overrides = {}) {
  return {
    sessionNum: 1,
    startDaily: 0,
    baseLength: 900,
    carryover: 0,
    graceSeconds: 0,
    firedNudges: [],
    ...overrides,
  };
}

test('effective length is base + carryover + grace', () => {
  assert.equal(effectiveLengthOf(session()), 900);
  assert.equal(effectiveLengthOf(session({ carryover: 420, graceSeconds: 42 })), 1362);
});

test('used is measured from the session anchor, not the day start', () => {
  // Session 2 began 15m into the day and ran 8m.
  const s = session({ sessionNum: 2, startDaily: 900 });
  assert.equal(usedSecondsOf(s, 1380), 480);
});

test('used never exceeds the session length', () => {
  // A session can overrun its limit between ticks; the bar must not overflow.
  const s = session();
  assert.equal(usedSecondsOf(s, 1000), 900);
});

test('used never goes negative', () => {
  // A stale daily total (rollover raced the record) must not produce a negative bar.
  const s = session({ startDaily: 900 });
  assert.equal(usedSecondsOf(s, 0), 0);
});

test('a record captures the cooldown that ran, not one derived later', () => {
  const s = session({ sessionNum: 3 });
  const r = toRecord(s, 900, 900, 'completed');
  assert.deepEqual(r, [900, 900, 900, 'completed']);
  // Nothing in the record references the increment setting, so changing it
  // cannot alter this session's stored cooldown.
  assert.equal(r[2], 900);
});

test('append builds a day per domain, in order', () => {
  let h = {};
  h = appendRecord(h, '2026-08-14', 'youtube.com', [900, 900, 300, 'completed']);
  h = appendRecord(h, '2026-08-14', 'youtube.com', [480, 900, 600, 'early']);
  h = appendRecord(h, '2026-08-14', 'reddit.com', [300, 900, 300, 'early']);
  assert.deepEqual(sessionsFor(h, '2026-08-14', 'youtube.com'), [
    [900, 900, 300, 'completed'],
    [480, 900, 600, 'early'],
  ]);
  assert.deepEqual(sessionsFor(h, '2026-08-14', 'reddit.com'), [[300, 900, 300, 'early']]);
});

test('append does not mutate the history it was given', () => {
  // The shell reads, appends, and writes back; an in-place mutation would make a
  // failed write leave memory and storage disagreeing.
  const before = { '2026-08-14': { 'youtube.com': [[900, 900, 300, 'completed']] } };
  const after = appendRecord(before, '2026-08-14', 'youtube.com', [480, 900, 600, 'early']);
  assert.equal(before['2026-08-14']['youtube.com'].length, 1);
  assert.equal(after['2026-08-14']['youtube.com'].length, 2);
});

test('a day with no record yet reads as empty, not undefined', () => {
  assert.deepEqual(sessionsFor({}, '2026-08-01', 'youtube.com'), []);
  assert.deepEqual(sessionsFor({ '2026-08-01': {} }, '2026-08-01', 'youtube.com'), []);
});

test('prune keeps the newest days and drops the rest', () => {
  const h = {
    '2026-08-01': { a: [] },
    '2026-08-03': { b: [] },
    '2026-08-02': { c: [] },
  };
  assert.deepEqual(Object.keys(pruneHistory(h, 2)).sort(), ['2026-08-02', '2026-08-03']);
});

test('prune leaves a history under the limit untouched', () => {
  const h = { '2026-08-01': { a: [] } };
  assert.equal(pruneHistory(h, 90), h);
});

test('running totals accumulate used time across the day', () => {
  const totals = runningTotals([
    [900, 900, 300, 'completed'],
    [480, 900, 600, 'early'],
    [1010, 1362, 900, 'early'],
  ]);
  assert.deepEqual(totals, [900, 1380, 2390]);
});

test('a day-ended session records the cooldown it would have served', () => {
  // The rollover pre-empted the cooldown, but what it WOULD have been is a real
  // fact about the session. Storing it keeps the card stable when the increment
  // setting changes later — the same reason every other record stores its own.
  const r = toRecord(session({ sessionNum: 3, startDaily: 1800 }), 2100, 900, 'dayEnded');
  assert.deepEqual(r, [300, 900, 900, 'dayEnded']);
});

test('a zero cooldown is recorded when the domain has cooldowns off', () => {
  // cooldownLength() returns 0 when the increment is 0. That is a true record —
  // no cooldown ran and none was due — distinct from the day-ended case above.
  const r = toRecord(session({ sessionNum: 2 }), 900, 0, 'completed');
  assert.deepEqual(r, [900, 900, 0, 'completed']);
});
