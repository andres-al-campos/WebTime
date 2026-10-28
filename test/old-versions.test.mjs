// build.sh moves other versions' zips into artifacts/old_versions/ and leaves this
// version's alone. Archiving its own zips, a rebuild at the same version left a copy of
// itself in old_versions/ (Chronicle's build did). The test runs build.sh's own archive
// block on scratch zips, since a full build takes the whole suite with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('a build archives other versions and never its own', () => {
  const build = readFileSync('build.sh', 'utf8');
  const block = build.match(/^mkdir -p artifacts\/old_versions\n[\s\S]*?^shopt -u nullglob$/m);
  assert.ok(block, 'build.sh has no archive block from "mkdir -p artifacts/old_versions" to ' +
    '"shopt -u nullglob". If it moved, update this test to find it.');

  const dir = mkdtempSync(path.join(tmpdir(), 'webtime-old-versions-'));
  try {
    mkdirSync(path.join(dir, 'artifacts'));
    const names = ['web_time-9.0.0.zip', 'web_time-chrome-9.0.0.zip', 'web_time-9.1.0.zip', 'web_time-chrome-9.1.0.zip'];
    for (const n of names) writeFileSync(path.join(dir, 'artifacts', n), '');
    execFileSync('bash', ['-c', `VERSION=9.1.0\n${block[0]}`], { cwd: dir, stdio: 'ignore' });

    const kept = readdirSync(path.join(dir, 'artifacts')).filter((f) => f.endsWith('.zip')).sort();
    const old = readdirSync(path.join(dir, 'artifacts/old_versions')).sort();
    assert.deepEqual(kept, ['web_time-9.1.0.zip', 'web_time-chrome-9.1.0.zip'],
      "this version's zips must stay in artifacts/: the archive loop in build.sh should skip them");
    assert.deepEqual(old, ['web_time-9.0.0.zip', 'web_time-chrome-9.0.0.zip'],
      "other versions' zips must move to artifacts/old_versions/: look at the archive loop in build.sh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
