// Tests for src/shared/storage-health.ts.
//
// The thing worth pinning is that size is measured the way storage measures it:
// serialized JSON, in UTF-8 bytes. An in-memory estimate or a `.length` count
// both look right on ASCII test data and under-report real stores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = mkdtempSync(join(tmpdir(), 'webtime-storage-test-'));
const outFile = join(out, 'storage-health.mjs');
await build({
  entryPoints: ['src/shared/storage-health.ts'],
  bundle: true,
  format: 'esm',
  outfile: outFile,
});
const { storedSize, levelFor, formatBytes, QUOTA_BYTES, WARN_AT, percentFull } =
  await import(pathToFileURL(outFile).href);

test('storedSize measures the JSON, not the object', () => {
  // The serialization is what storage.local persists and what the quota counts.
  const v = { 'a.com': 120 };
  assert.equal(storedSize(v), JSON.stringify(v).length);
});

test('storedSize counts UTF-8 bytes, not characters', () => {
  // An internationalised domain is stored decoded, and its characters cost more
  // than one byte each. String length would under-report the store.
  const idn = { 'münchen.de': 1 };
  const json = JSON.stringify(idn);
  assert.equal(json.length, 16, 'ten-character domain plus the JSON around it');
  assert.equal(storedSize(idn), 17, 'the ü costs a second byte');
});

test('storedSize of nothing is zero', () => {
  assert.equal(storedSize(undefined), 0);
});

test('levelFor warns at the threshold and not before', () => {
  const at = QUOTA_BYTES * WARN_AT;
  assert.equal(levelFor(at - 1), 'ok');
  assert.equal(levelFor(at), 'warn');
  assert.equal(levelFor(QUOTA_BYTES), 'warn');
});

test('levelFor is ok for an empty store', () => {
  assert.equal(levelFor(0), 'ok');
});

test('the warning leaves real headroom', () => {
  // At a heavy user's measured ~3.2 KB/day, the gap between the banner and the
  // ceiling should be months, not days — a warning with no time to act on is
  // just an error message.
  const headroomDays = (QUOTA_BYTES - QUOTA_BYTES * WARN_AT) / 3200;
  assert.ok(headroomDays > 180, `only ${Math.round(headroomDays)} days of headroom`);
});

test('formatBytes reads as a magnitude', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(1024 * 1024 * 1.25), '1.3 MB');
});

test('percentFull rounds down, never up', () => {
  // The banner fires at exactly WARN_AT. Rounding to nearest would let it read
  // "90% full" at 89.6%, contradicting the threshold that produced it.
  assert.equal(percentFull(QUOTA_BYTES * 0.896), 89);
  assert.equal(percentFull(QUOTA_BYTES * 0.899), 89);
  assert.equal(percentFull(QUOTA_BYTES * 0.9), 90);
});

test('the number shown agrees with the banner being shown', () => {
  // The two must not disagree: anything that warns must read >= 90.
  for (const f of [0.9, 0.93, 0.97, 1.0, 1.4]) {
    const bytes = Math.round(QUOTA_BYTES * f);
    assert.equal(levelFor(bytes), 'warn', `${f} should warn`);
    assert.ok(percentFull(bytes) >= 90, `${f} should read >= 90, got ${percentFull(bytes)}`);
  }
  for (const f of [0, 0.5, 0.899]) {
    assert.equal(levelFor(Math.round(QUOTA_BYTES * f)), 'ok');
  }
});

test('percentFull clamps at 100 when over quota', () => {
  // Firefox has no real 10MB ceiling, so a store CAN exceed it. "140% full"
  // reads as a bug.
  assert.equal(percentFull(QUOTA_BYTES * 3), 100);
  assert.equal(percentFull(QUOTA_BYTES), 100);
});

test('an empty store is 0%', () => {
  assert.equal(percentFull(0), 0);
});
