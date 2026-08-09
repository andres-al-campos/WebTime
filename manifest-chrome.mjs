// Derive the Chrome MV3 manifest from the Firefox MV2 one.
//
// extension/manifest.json stays the single source of truth: version, name,
// permissions and content scripts are edited there once, and this transform
// applies only the differences MV3 requires. Keeping two hand-maintained
// manifests is how they drift — one gets a new permission and the other
// doesn't, and the bug only shows up on the browser you tested less.
//
// Everything not touched here is passed through unchanged.
import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

/** MV2 manifest object → MV3 manifest object. */
export function toMv3(mv2) {
  const mv3 = structuredClone(mv2);

  mv3.manifest_version = 3;

  // MV2's browser_action is MV3's action. Same shape.
  if (mv3.browser_action) {
    mv3.action = mv3.browser_action;
    delete mv3.browser_action;
  }

  // A background page with scripts becomes a single service worker. Our
  // background is already bundled to one file, so there is nothing to merge.
  if (mv3.background?.scripts) {
    const [worker] = mv3.background.scripts;
    if (mv3.background.scripts.length > 1) {
      throw new Error(
        `MV3 takes exactly one service worker but manifest.json lists ` +
        `${mv3.background.scripts.length} background scripts. Bundle them ` +
        `into one file in build.mjs, or the extra scripts will be dropped.`
      );
    }
    mv3.background = { service_worker: worker };
  }

  // MV3 splits host access out of "permissions" into "host_permissions".
  // Leaving a URL pattern in "permissions" is silently ignored by Chrome,
  // which is exactly the failure that is hard to notice — the extension loads
  // and simply cannot see any pages.
  const isHostPattern = p => p.includes('://') || p === '<all_urls>';
  const permissions = (mv3.permissions || []).filter(p => !isHostPattern(p));
  const hosts = (mv3.permissions || []).filter(isHostPattern);

  // "offscreen" is added here rather than in the shared manifest because the
  // API is Chrome-only and MV3-only. It backs the keep-alive document that stops
  // Chrome killing the service worker mid-count; Firefox has a persistent
  // background page and would only warn about an unknown permission.
  if (!permissions.includes('offscreen')) permissions.push('offscreen');

  mv3.permissions = permissions;
  if (hosts.length) {
    mv3.host_permissions = [...new Set([...(mv3.host_permissions || []), ...hosts])];
  }

  // Firefox-only block; Chrome warns about unrecognised keys.
  delete mv3.browser_specific_settings;

  return mv3;
}

// Everything in extension/ that ships, minus the manifest (which is derived,
// not copied). Listed explicitly rather than globbed so a new stray file in
// extension/ doesn't silently end up in the Chrome build.
const COPIED = ['dist', 'images', 'popup', 'timer.css', 'offscreen.html'];

/** Assemble dist-chrome/ — the directory Chrome loads unpacked. */
export async function buildChrome() {
  const srcDir = join(root, 'extension');
  const outDir = join(root, 'dist-chrome');

  const mv2 = JSON.parse(await readFile(join(srcDir, 'manifest.json'), 'utf8'));
  const mv3 = toMv3(mv2);

  // Rebuild from scratch. Chrome keeps serving whatever is on disk, so a file
  // deleted from extension/ but left behind here would keep working locally
  // and break for anyone else.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // .DS_Store and friends are machine-local noise; Chrome's store rejects
  // uploads containing them, and they have no business in a loadable build.
  const skip = new Set(['.DS_Store', 'Thumbs.db']);
  await Promise.all(
    COPIED.map(name => cp(join(srcDir, name), join(outDir, name), {
      recursive: true,
      filter: src => !skip.has(basename(src)),
    }))
  );
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(mv3, null, 2) + '\n');

  return { mv3, outDir };
}

// Only run when invoked directly, so the transform can be imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { mv3, outDir } = await buildChrome();
  console.log(`Chrome MV${mv3.manifest_version} build assembled at ${outDir}`);
}
