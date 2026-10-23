// Law: every doc, Principle and Call is stamped with a real time and a version
// extension/manifest.json has had, and every "Applies *Name*." names a Principle in AGENTS.md.
// The pre-commit hook writes the stamps; this catches a commit made with the hook off. The
// check itself is the hook's --check, so it can't drift from what the hook writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('every doc, Principle and Call is stamped, and every citation names a Principle', () => {
  const hook = fileURLToPath(new URL('../hooks/stamp-docs.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [hook, '--check', 'extension/manifest.json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
