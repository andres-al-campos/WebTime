#!/usr/bin/env node
// Drive the Chrome build headless: load dist-chrome/ into Playwright's
// Chromium, open a local page, act like a user on it, and report what the
// extension did. See features/README.md for what each scenario proves.
//
//   node scripts/drive.mjs [scenario] [options]
//
//   track (default)    Time tracking + On-page timer
//   nudges             Nudges at a 30s interval
//   end-early          End session early via Ctrl+E
//   average-popup      7-day average popup pauses the clock
//   session-rules      the popup's session-rules toggle reaches the page
//   wind-down          the page dims as a 1-minute session runs out
//   overview           all-sites breakdown lists a stored site
//   past-day           a past day's bar shows its finished sessions
//   global-settings    the gear sheet saves a setting
//   export             Your data summary and the Export download
//   all                every scenario above, each in a fresh browser
//
//   --doctor           is the stack up? (track for 6s, passes if the clock runs)
//   --headed           show the browser window
//   --ext DIR          extension dir to load (default dist-chrome/)
//   track only:
//   --seconds N        how long to stay on the page (default 15)
//   --limit M          turn session rules on for the page, M-minute sessions
//   --cooldown M       with --limit: cooldown step in minutes (session N waits N × M)
//   --popup            afterwards, open the popup and print its cards
//
// Chrome only. Firefox has no equivalent here; drive it by hand (web-ext run).

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from './drive/lib.mjs';
import { scenarios } from './drive/scenarios.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const doctor = flag('--doctor');
const opts = {
  extDir: resolve(root, opt('--ext', 'dist-chrome')),
  headed: flag('--headed'),
  doctor,
  seconds: Number(opt('--seconds', doctor ? '6' : '15')),
  limit: opt('--limit', null) === null ? null : Number(opt('--limit')),
  cooldown: Number(opt('--cooldown', '0')),
  popup: flag('--popup'),
};

const name = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.match(/^--(seconds|limit|cooldown|ext)$/)) ?? 'track';
const names = name === 'all' ? Object.keys(scenarios) : [name];
if (!names.every((n) => scenarios[n])) {
  fail(`No scenario called "${name}".`,
    `use one of: ${Object.keys(scenarios).join(', ')}, all.`);
  process.exit(1);
}

if (!existsSync(join(opts.extDir, 'manifest.json'))) {
  fail(`No built extension at ${opts.extDir}.`, 'run ./build.sh (or npm run build), then try again.');
  process.exit(1);
}

const results = [];
for (const n of names) {
  console.log(`\n▸ ${n}: ${scenarios[n].about}`);
  results.push([n, await scenarios[n].run(opts)]);
}
if (names.length > 1) {
  console.log(`\n${results.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join('\n')}`);
}
