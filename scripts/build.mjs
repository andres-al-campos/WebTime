import * as esbuild from 'esbuild';
import { rm } from 'node:fs/promises';
import { buildChrome } from './manifest-chrome.mjs';

// Start from a clean dist so stale orphans from older build layouts can't
// linger and ship inside the packaged extension. (A previous tsc-based build
// emitted one .js per source file; esbuild now bundles to just three outputs,
// and the leftovers — e.g. an old ui-manager.js — were getting flagged by
// AMO's linter even though nothing loads them.)
await rm('extension/dist', { recursive: true, force: true });

// Debug logging is on for a plain `./build.sh` and off for a release build.
// It used to be a constant edited by hand, which meant every debugging session
// ended one forgotten flip away from shipping the full trace to AMO — or, more
// often, from wondering why nothing logs. WEBTIME_DEBUG=0 forces it off.
const DEBUG_ENABLED = process.env.WEBTIME_DEBUG !== '0';

// Source maps are a local debugging aid, and they are big — half a megabyte
// across the four bundles, which is most of what a user downloads. They ride
// along with debug logging: present for `./build.sh`, absent for release.sh.
// Not merely excluded from the zip, because a map that exists but is not
// packaged leaves a //# sourceMappingURL pointing at a 404.
const SOURCEMAPS = DEBUG_ENABLED;

const commonOptions = {
  bundle: true,
  sourcemap: SOURCEMAPS,
  target: 'es2020',
  format: 'iife',
  define: {
    __WEBTIME_DEBUG__: JSON.stringify(DEBUG_ENABLED),
  },
};

await Promise.all([
  esbuild.build({
    ...commonOptions,
    entryPoints: ['src/background.ts'],
    outfile: 'extension/dist/background.js',
  }),
  esbuild.build({
    ...commonOptions,
    entryPoints: ['src/content.ts'],
    outfile: 'extension/dist/content.js',
  }),
  esbuild.build({
    ...commonOptions,
    entryPoints: ['src/popup/popup-init.ts'],
    outfile: 'extension/dist/popup/popup-bundle.js',
  }),
  // Chrome-only keep-alive. Bundled unconditionally because the Firefox build
  // simply never loads it — a persistent background page has nothing to keep
  // alive, and Firefox has no chrome.offscreen API to create the document with
  // — so the file sits inert in extension/dist/. A second build path would be
  // more to get wrong than a few unused kilobytes. src/offscreen.ts explains
  // what the document does and why Chrome needs it.
  esbuild.build({
    ...commonOptions,
    entryPoints: ['src/offscreen.ts'],
    outfile: 'extension/dist/offscreen.js',
  }),
]);

// Assemble the Chrome build from what we just bundled. Runs here rather than
// as a separate script step so it can't be ordered before the bundle exists.
await buildChrome();

console.log('Build complete.');
