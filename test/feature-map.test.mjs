// The feature map is what "done" is checked against, so it can't drift from
// the code: every row has a file, every file has a row, and every file names a
// drive scenario that exists. A feature with no check says so with
// "No check yet" in its Driving section.
//
// It checks that the scenario exists, not that it checks the right thing;
// that is still the job of breaking the feature once and watching it fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { scenarios } from '../scripts/drive/scenarios.mjs';

const readme = readFileSync('features/README.md', 'utf8');
const rows = [...readme.matchAll(/^\|[^|]+\| \[[^\]]+\]\(([^)]+\.md)\)/gm)].map((m) => m[1]);
const files = readdirSync('features').filter((f) => f.endsWith('.md') && f !== 'README.md');

test('every row in the feature index has a file', () => {
  const missing = rows.filter((r) => !files.includes(r));
  assert.deepEqual(missing, [],
    `features/README.md links ${missing.join(', ')}, which don't exist. ` +
      'Fix the link or remove the row.');
});

test('every feature file has a row in the index', () => {
  const unlisted = files.filter((f) => !rows.includes(f));
  assert.deepEqual(unlisted, [],
    `${unlisted.join(', ')} ${unlisted.length > 1 ? 'have' : 'has'} no row in features/README.md. ` +
      'Add a row to the table.');
});

test('every feature names a drive scenario that exists', () => {
  const problems = [];
  for (const f of files) {
    const text = readFileSync(`features/${f}`, 'utf8');
    const driving = /^## Driving it\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)?.[1];
    if (driving === undefined) {
      problems.push(`${f} has no "## Driving it" section.`);
      continue;
    }
    if (/No check yet/.test(driving)) continue;
    const commands = [...driving.matchAll(/`npm run drive(?: -- ([^`]*))?`/g)];
    if (!commands.length) {
      problems.push(`${f} names no \`npm run drive\` command. Name its scenario, or write "No check yet" and why.`);
      continue;
    }
    for (const [, args = ''] of commands) {
      // No scenario name means the default, track.
      // Skip flag values the way scripts/drive.mjs does.
      const words = args.split(/\s+/).filter(Boolean);
      const name = words.find((a, i) => !a.startsWith('--') &&
        !/^--(seconds|limit|cooldown|ext)$/.test(words[i - 1] ?? '')) ?? 'track';
      if (!scenarios[name]) {
        problems.push(`${f} runs scenario "${name}", which scripts/drive/scenarios.mjs doesn't have ` +
          `(it has: ${Object.keys(scenarios).join(', ')}).`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});
