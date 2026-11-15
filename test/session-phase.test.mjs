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

const T = 1_700_000_000_000;

test('no session and no block is none', () => {
  assert.equal(sessionPhase({ hasSession: false, blockedUntil: 0, now: T }), 'none');
});

test('a session with no block is running', () => {
  assert.equal(sessionPhase({ hasSession: true, blockedUntil: 0, now: T }), 'running');
});

test('a block outranks the session that waits behind it', () => {
  assert.equal(sessionPhase({ hasSession: true, blockedUntil: T + 1, now: T }), 'blocked');
  assert.equal(sessionPhase({ hasSession: false, blockedUntil: T + 1, now: T }), 'blocked');
});

test('a block that has lifted no longer blocks', () => {
  assert.equal(sessionPhase({ hasSession: true, blockedUntil: T, now: T }), 'running');
  assert.equal(sessionPhase({ hasSession: false, blockedUntil: T - 1, now: T }), 'none');
});
