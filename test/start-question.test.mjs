// What the gate asks during the start countdown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = join(mkdtempSync(join(tmpdir(), 'webtime-question-test-')), 'utils.mjs');
await build({ entryPoints: ['src/shared/utils.ts'], bundle: true, format: 'esm', outfile: out, platform: 'node' });
const { startQuestionOf } = await import(pathToFileURL(out).href);

test('the gate asks the question that was set', () => {
  assert.equal(startQuestionOf({ startQuestion: '  Worth it?  ' }), 'Worth it?');
});

test('with nothing set, or only spaces, it asks the default', () => {
  for (const g of [undefined, {}, { startQuestion: '' }, { startQuestion: '   ' }]) {
    assert.equal(startQuestionOf(g), 'Are you sure?');
  }
});
