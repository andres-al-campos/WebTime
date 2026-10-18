#!/usr/bin/env node
// Get the build into the browser it is used in day to day, without clicking
// through Install Add-on From File.
//
//   node scripts/install-local.mjs package   (every ./build.sh)
//   node scripts/install-local.mjs install   (./build.sh install)
//
// package writes artifacts/local/web_time.zip.
// install restarts the browser and waits for its profile to report the build.
//
// The browser does the installing. An enterprise policy names the zip as a
// file: URL, and Firefox's policy code reinstalls a file: URL on every start.
// It skips the install when the version is unchanged, so the local zip is the
// store zip with a build stamp as a fourth version part.
//
// The policy lives in the browser's macOS preferences domain, not in a
// policies.json inside the app. A browser update replaces the app bundle and
// the file with it (the first real run lost it that way), and macOS refuses
// writes into another app's bundle without App Management permission.
// install prints the one-time setup when the policy is missing.
//
// Only browsers that accept an unsigned add-on can use this: Floorp does,
// release Firefox does not. WEBTIME_BROWSER picks the app bundle.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localDir = join(root, 'artifacts', 'local');
const localZip = join(localDir, 'web_time.zip');
const browser = process.env.WEBTIME_BROWSER ?? '/Applications/Floorp.app';
const browserName = basename(browser, '.app');

// Seconds since 2026-01-01. Firefox compares version parts as 32-bit integers,
// which a full Unix timestamp outgrows in 2038.
const STAMP_EPOCH = 1767225600;

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
    fail(`Version ${manifest.version} already has four parts, so there is no room for the build stamp.`,
      'keep extension/manifest.json at three parts (major.minor.patch).');
  }

  const version = `${manifest.version}.${Math.floor(Date.now() / 1000) - STAMP_EPOCH}`;
  mkdirSync(localDir, { recursive: true });
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
  if (!existsSync(browser)) {
    fail(`No browser at ${browser}.`, 'set WEBTIME_BROWSER to the app bundle to install into, e.g. WEBTIME_BROWSER=/Applications/Floorp.app.');
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

function installedVersion(id) {
  const profiles = join(homedir(), 'Library', 'Application Support', browserName, 'Profiles');
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
    execFileSync('osascript', ['-e', `tell application "${browser}" to quit`]);
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
