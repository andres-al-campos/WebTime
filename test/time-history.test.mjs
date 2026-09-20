// Tests for src/shared/time-history.ts.
//
// This module exists for a failure that cannot be fixed after the fact: an old
// build reading a newer store. The build that mishandles the future format has
// already shipped, so the refusal has to be correct now, while there is still
// only one version in the wild.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = mkdtempSync(join(tmpdir(), 'webtime-timehist-test-'));
const outFile = join(out, 'time-history.mjs');
await build({
  entryPoints: ['src/shared/time-history.ts'],
  bundle: true,
  format: 'esm',
  outfile: outFile,
});
const { readTrackedTime, dayCount, TRACKED_TIME_VERSION } =
  await import(pathToFileURL(outFile).href);

const HISTORY = { '2026-01-01': { 'a.com': 120 } };

test('a fresh install reads as empty, not as an error', () => {
  for (const raw of [undefined, null, 'nonsense', 42]) {
    const r = readTrackedTime(raw);
    assert.deepEqual(r.history, {});
    assert.equal(r.fromFuture, false);
  }
});

test('a pre-versioning store is read as v1', () => {
  // Builds before the version field wrote a bare object. That data is v1 --
  // the field was added around an unchanged shape -- so it must still load.
  const r = readTrackedTime({ lastDate: '2026-01-01', timeHistory: HISTORY });
  assert.deepEqual(r.history, HISTORY);
  assert.equal(r.lastDate, '2026-01-01');
  assert.equal(r.fromFuture, false);
});

test('a current-version store round-trips', () => {
  const r = readTrackedTime({
    lastDate: '2026-01-01', timeHistory: HISTORY, version: TRACKED_TIME_VERSION,
  });
  assert.deepEqual(r.history, HISTORY);
  assert.equal(r.fromFuture, false);
});

test('a store from a NEWER build is refused, not partially read', () => {
  // The dangerous case. Reading the fields we recognise and ignoring the rest
  // would let this build keep saving, overwriting a newer store with a lossy
  // copy. Empty history is recoverable; a clobbered store is not.
  const r = readTrackedTime({
    lastDate: '2026-01-01', timeHistory: HISTORY, version: TRACKED_TIME_VERSION + 1,
  });
  assert.deepEqual(r.history, {}, 'must not surface data it cannot fully read');
  assert.equal(r.fromFuture, true, 'caller needs this to know not to overwrite');
});

test('a corrupt version is not mistaken for the future', () => {
  // A non-numeric version is damage, not a format from ahead. There is nothing
  // to preserve, so the caller is free to write over it.
  const r = readTrackedTime({ timeHistory: HISTORY, version: 'two' });
  assert.deepEqual(r.history, {});
  assert.equal(r.fromFuture, false, 'corrupt must not block writes forever');
});

test('a missing timeHistory reads as empty', () => {
  const r = readTrackedTime({ lastDate: '2026-01-01', version: 1 });
  assert.deepEqual(r.history, {});
});

test('the clock recovery anchor survives the read', () => {
  // These drive recovery of time lost when the worker died mid-count. Dropping
  // them silently loses the user real minutes.
  const r = readTrackedTime({
    lastDate: '2026-01-01', timeHistory: HISTORY, version: 1,
    runningSince: 1700000000000, runningDomain: 'a.com',
  });
  assert.equal(r.runningSince, 1700000000000);
  assert.equal(r.runningDomain, 'a.com');
});

test('a malformed anchor reads as absent rather than as a number', () => {
  const r = readTrackedTime({
    timeHistory: HISTORY, version: 1, runningSince: 'soon', runningDomain: 7,
  });
  assert.equal(r.runningSince, null);
  assert.equal(r.runningDomain, null);
});

test('dayCount counts days', () => {
  assert.equal(dayCount({}), 0);
  assert.equal(dayCount({ '2026-01-01': {}, '2026-01-02': {} }), 2);
});
