// Tests for src/shared/data-export.ts.
//
// An export file is read back by a human or a future build, long after the
// extension that wrote it. Its shape is therefore a compatibility surface, and
// these tests pin it as one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = mkdtempSync(join(tmpdir(), 'webtime-export-test-'));
const outFile = join(out, 'data-export.mjs');
await build({
  entryPoints: ['src/shared/data-export.ts'],
  bundle: true,
  format: 'esm',
  outfile: outFile,
});
const { buildExport, exportFilename, EXPORT_FORMAT_VERSION } =
  await import(pathToFileURL(outFile).href);

const HISTORY = { '2026-09-18': { 'youtube.com': 120 }, '2026-09-19': { 'github.com': 45 } };
const AT = new Date('2026-09-19T14:03:00Z');

test('the payload identifies itself', () => {
  const p = buildExport(HISTORY, {}, AT);
  // Without these three, a stray json file in a downloads folder is
  // unidentifiable and therefore not a backup.
  assert.equal(p.app, 'WebTime');
  assert.equal(p.exportFormat, EXPORT_FORMAT_VERSION);
  assert.equal(p.exportedAt, '2026-09-19T14:03:00.000Z');
});

test('the time history is carried through unchanged', () => {
  const p = buildExport(HISTORY, {}, AT);
  assert.deepEqual(p.trackedTime.timeHistory, HISTORY);
  assert.equal(p.trackedTime.version, 1, 'the store version travels with the store');
});

test('sessions are carried, with their own version', () => {
  const sessions = { '2026-09-19': { 'youtube.com': [[1, 2, 3, 'ended']] } };
  const p = buildExport(HISTORY, sessions, AT);
  assert.equal(p.sessionHistory.version, 1);
  // Not just truthy: an empty object is truthy and is exactly the bug.
  assert.deepEqual(Object.keys(p.sessionHistory.history), ['2026-09-19']);
  assert.ok(
    JSON.stringify(p.sessionHistory.history).includes('youtube.com'),
    'the sessions themselves must travel, not an empty shell'
  );
});

test('an empty profile still exports a valid envelope', () => {
  const p = buildExport({}, {}, AT);
  assert.equal(p.app, 'WebTime');
  assert.deepEqual(p.trackedTime.timeHistory, {});
});

test('the payload survives a JSON round-trip', () => {
  // It is written with JSON.stringify and read with JSON.parse; anything that
  // does not survive that (undefined, a Map, a Date) is silently lost.
  const p = buildExport(HISTORY, { '2026-09-19': { 'a.com': [[1, 2, 3, 'ended']] } }, AT);
  assert.deepEqual(JSON.parse(JSON.stringify(p)), p);
});

test('the filename is dated and zero-padded', () => {
  // Zero-padding is what makes a folder of these sort chronologically.
  assert.equal(exportFilename(new Date(2026, 8, 19)), 'webtime-backup-2026-09-19.json');
  assert.equal(exportFilename(new Date(2026, 0, 5)), 'webtime-backup-2026-01-05.json');
  assert.match(exportFilename(new Date(2026, 11, 31)), /^webtime-backup-2026-12-31\.json$/);
});
