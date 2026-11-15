// Tests for sessionPhase in src/shared/session-model.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = mkdtempSync(join(tmpdir(), 'webtime-phase-test-'));
const outFile = join(out, 'session-model.mjs');
await build({
  entryPoints: ['src/shared/session-model.ts'],
  bundle: true,
  format: 'esm',
  outfile: outFile,
  platform: 'node',
});
const { sessionPhase } = await import(pathToFileURL(outFile).href);

test('no rules is off, whatever is stored', () => {
  assert.equal(sessionPhase({ rulesOn: false, hasSession: false }), 'off');
  assert.equal(sessionPhase({ rulesOn: false, hasSession: true }), 'off');
});

test('rules on with no session is the gate', () => {
  assert.equal(sessionPhase({ rulesOn: true, hasSession: false }), 'gate');
});

test('rules on with a session is running', () => {
  assert.equal(sessionPhase({ rulesOn: true, hasSession: true }), 'running');
});
