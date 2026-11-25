#!/usr/bin/env node
// Dev loop: get each dev build into the Firefox you develop in, without
// clicking through Install Add-on From File. Release builds never come here.
//
//   node scripts/install-local.mjs package   (every dev ./build.sh)
//   node scripts/install-local.mjs install   (./build.sh install)
//
// package writes artifacts/local/web_time.zip.
// install restarts that Firefox and waits for its profile to report the build.
//
// The browser does the installing. An enterprise policy names the zip as a
// file: URL, and Firefox's policy code reinstalls a file: URL on every start.
// It skips the install when the version is unchanged, so the local zip is the
// store zip with a build number as a fourth version part: 2.10.0.14 is the
// 14th dev build of 2.10.0. The count starts over when the version moves.
//
// One-time setup:
//
//   1. Pick a Firefox that accepts unsigned add-ons: Developer Edition,
//      Nightly, or a fork. Release Firefox requires Mozilla's signature.
//   2. Name it in .env.local (gitignored; see .env.local.example):
//        WEBTIME_FIREFOX="/Applications/Firefox Developer Edition.app"
//   3. Run ./build.sh install. The first run prints two `defaults write`
//      commands that set the policy; run them, then ./build.sh install again.
//
// The policy lives in that Firefox's macOS preferences domain, not in a
// policies.json inside the app. A browser update replaces the app bundle and
// the file with it (the first real run lost it that way), and macOS refuses
// writes into another app's bundle without App Management permission.
//
// normal_installed removes the add-on's uninstall button in that Firefox; it
// can still be disabled. To undo: `defaults delete <bundle id> ExtensionSettings`,
// the same for EnterprisePoliciesEnabled, then restart the browser.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localDir = join(root, 'artifacts', 'local');
const localZip = join(localDir, 'web_time.zip');
const browser = process.env.WEBTIME_FIREFOX;
const browserName = browser ? basename(browser, '.app') : '';

// The count lives beside the zip, gitignored with the rest of artifacts/.
const buildCountFile = join(localDir, 'build-number.json');

/** The next dev build number for `version`, saved as used. */
function nextBuildNumber(version) {
  let last = { version, n: 0 };
  try { last = JSON.parse(readFileSync(buildCountFile, 'utf8')); } catch { /* first build */ }
  const n = last.version === version && Number.isInteger(last.n) ? last.n + 1 : 1;
  writeFileSync(buildCountFile, JSON.stringify({ version, n }));
  return n;
}

function fail(what, fix) {
  console.error(`\n❌ ${what}\n   Fix: ${fix}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function packageLocal() {
  const manifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));
  const storeZip = join(root, 'artifacts', `web_time-${manifest.version}.zip`);
  if (!existsSync(storeZip)) {
    fail(`No Firefox package at ${storeZip}.`, 'run ./build.sh, which builds it before this step.');
  }
  if (manifest.version.split('.').length > 3) {
    fail(`Version ${manifest.version} already has four parts, so there is no room for the build number.`,
      'keep extension/manifest.json at three parts (major.minor.patch).');
  }

  mkdirSync(localDir, { recursive: true });
  const version = `${manifest.version}.${nextBuildNumber(manifest.version)}`;
  copyFileSync(storeZip, localZip);
  const tmp = mkdtempSync(join(tmpdir(), 'webtime-local-'));
  try {
    writeFileSync(join(tmp, 'manifest.json'), JSON.stringify({ ...manifest, version }, null, 2));
    // -j stores it as manifest.json at the top level, replacing the store one.
    execFileSync('zip', ['-q', '-j', localZip, join(tmp, 'manifest.json')]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`   Local install:  artifacts/local/web_time.zip (${version})`);
}

function zipManifest() {
  if (!existsSync(localZip)) {
    fail(`No local package at ${localZip}.`, 'run ./build.sh install, which builds it first.');
  }
  return JSON.parse(execFileSync('unzip', ['-p', localZip, 'manifest.json'], { encoding: 'utf8' }));
}

function bundleId() {
  return execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(browser, 'Contents', 'Info.plist')],
    { encoding: 'utf8' }).trim();
}

// One key of a preferences domain, or undefined. plutil's json format only
// takes a dict or array, so a scalar key is read as raw text instead.
function readDefault(domain, key, format = 'json') {
  try {
    const plist = execFileSync('defaults', ['export', domain, '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const out = execFileSync('plutil', ['-extract', key, format, '-o', '-', '-'],
      { input: plist, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    return format === 'json' ? JSON.parse(out) : out.trim();
  } catch {
    return undefined;
  }
}

function setupCommands(domain, id) {
  // normal_installed: the browser installs it and keeps the uninstall button
  // away, but it can still be disabled from the add-ons page.
  const entry = `<dict><key>${id}</key><dict>` +
    `<key>installation_mode</key><string>normal_installed</string>` +
    `<key>install_url</key><string>${pathToFileURL(localZip).href}</string></dict></dict>`;
  return `     defaults write ${domain} EnterprisePoliciesEnabled -bool true\n` +
    `     defaults write ${domain} ExtensionSettings '${entry}'`;
}

function checkPolicy(id) {
  if (!browser) {
    fail('No Firefox to install into.',
      'name one that accepts unsigned add-ons in .env.local, e.g. WEBTIME_FIREFOX="/Applications/Firefox Developer Edition.app" (see .env.local.example).');
  }
  if (!existsSync(browser)) {
    fail(`No app at ${browser}.`, 'fix WEBTIME_FIREFOX in .env.local to point at an installed Firefox app bundle.');
  }
  const domain = bundleId();
  const enabled = readDefault(domain, 'EnterprisePoliciesEnabled', 'raw') === 'true';
  const wanted = readDefault(domain, 'ExtensionSettings')?.[id]?.install_url;
  if (enabled && wanted === pathToFileURL(localZip).href) return domain;
  fail(`${browserName} has no policy pointing at ${localZip}, so it will not install this build.`,
    `run these once (they survive browser updates), then ./build.sh install again:\n${setupCommands(domain, id)}`);
}

function running() {
  try {
    execFileSync('pgrep', ['-f', `${browser}/Contents/MacOS/`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Firefox keeps profiles under Application Support/<Profile or Name from
// application.ini>: "Firefox" for Developer Edition too, a fork's own name.
function profilesDir() {
  const ini = readFileSync(join(browser, 'Contents', 'Resources', 'application.ini'), 'utf8');
  const key = (k) => ini.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1].trim();
  return join(homedir(), 'Library', 'Application Support', key('Profile') ?? key('Name'), 'Profiles');
}

function installedVersion(id) {
  const profiles = profilesDir();
  if (!existsSync(profiles)) return null;
  const found = [];
  for (const profile of readdirSync(profiles)) {
    try {
      const { addons } = JSON.parse(readFileSync(join(profiles, profile, 'extensions.json'), 'utf8'));
      const addon = addons.find((a) => a.id === id);
      if (addon) found.push(addon.version);
    } catch {
      // A profile with no extensions.json, or one caught mid-write.
    }
  }
  return found;
}

async function install() {
  const { version, name, browser_specific_settings: { gecko: { id } } } = zipManifest();
  const domain = checkPolicy(id);

  if (running()) {
    console.log(`🔄 Restarting ${browserName}...`);
    try {
      execFileSync('osascript', ['-e', `tell application "${browser}" to quit`], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      const why = String(e.stderr ?? e.message);
      if (why.includes('-128')) {
        fail(`${browserName} didn't quit: its quit was cancelled (macOS error -128), and it is still running the old build.`,
          `that's a "Quit ${browserName}?" or "close tabs?" prompt answered with Cancel. Quit it yourself or answer the prompt with Quit, then run ./build.sh install again.`);
      }
      fail(`Asking ${browserName} to quit failed: ${why.trim()}`,
        `quit ${browserName} by hand, then run ./build.sh install again.`);
    }
    for (let i = 0; running(); i++) {
      if (i >= 60) {
        fail(`${browserName} did not quit within 30 seconds.`,
          `it may be waiting on a dialog. Quit it by hand, then run ./build.sh install again.`);
      }
      await sleep(500);
    }
  } else {
    console.log(`🚀 Starting ${browserName}...`);
  }
  execFileSync('open', ['-a', browser]);

  // The policy install runs after startup and the profile records it a moment
  // later, so poll rather than read once.
  let seen = [];
  for (let i = 0; i < 90; i++) {
    seen = installedVersion(id) ?? [];
    if (seen.includes(version)) {
      console.log(`✓ ${browserName} is running ${name} ${version}`);
      return;
    }
    await sleep(1000);
  }
  fail(`${browserName} restarted but reports ${name} ${seen.join(', ') || 'not installed'}, not ${version}.`,
    `open about:policies in ${browserName}. If its Errors tab names the install, that is the cause. ` +
    `If it lists no active policies, ${browserName} is not reading your user preferences: ` +
    `run the setup commands again with sudo and /Library/Preferences/${domain} in place of ${domain}.`);
}

const mode = process.argv[2];
if (mode === 'package') packageLocal();
else if (mode === 'install') await install();
else fail(`Unknown mode "${mode ?? ''}".`, 'use: node scripts/install-local.mjs package | install');
