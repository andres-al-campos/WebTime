// What ends up inside the store zips.
//
// This is invisible from the outside: an extension with 1.4MB of screenshots
// and source maps in it works perfectly. It is only wrong when someone
// downloads it, so nothing but a test on the packaged layout catches it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

test('extension/images holds only what the manifest loads', () => {
  // Store screenshots live in store-assets/, outside the packaged dirs. Both
  // packagers copy images/ wholesale, so anything dropped here ships — an
  // exclusion pattern would fix today's files and leave the trap.
  const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
  const referenced = new Set(
    JSON.stringify(manifest)
      .match(/images\/[A-Za-z0-9._-]+/g)
      ?.map((p) => p.replace('images/', '')) ?? []
  );
  assert.ok(referenced.size > 0, 'the manifest must reference at least the icon');

  for (const file of readdirSync('extension/images')) {
    if (file === '.DS_Store') continue;   // Finder litter; both packagers -x it
    assert.ok(referenced.has(file),
      `extension/images/${file} is not referenced by the manifest — ` +
      `store artwork belongs in store-assets/, or it ships to every user`);
  }
});

test('the screenshots are still on disk, just not in the extension', () => {
  // Moving them must not mean losing them; the store listing needs these.
  for (const f of ['GeneralView-1280x800.png', 'SingleDomainView-1280x800.png']) {
    assert.ok(existsSync(`store-assets/${f}`), `store-assets/${f} must exist`);
  }
});

test('source maps are tied to the debug flag, not always on', () => {
  // A map excluded from the zip but still emitted leaves a sourceMappingURL
  // pointing at a 404, so the switch has to be at the bundler.
  const build = readFileSync('build.mjs', 'utf8');
  assert.match(build, /const SOURCEMAPS = DEBUG_ENABLED;/,
    'sourcemaps must follow the release/dev flag');
  assert.match(build, /sourcemap: SOURCEMAPS,/,
    'the bundler must read the flag, not a hardcoded true');
  assert.doesNotMatch(build, /sourcemap: true/,
    'no bundle may hardcode sourcemap: true');
});
