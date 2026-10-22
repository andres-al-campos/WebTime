// Law: each feature file, the README and any guide in docs/ carries a stamp, "Updated
// YYYY-MM-DD HH:MM, at <version>.", and each Principle and Call starts "YYYY-MM-DD HH:MM,
// <version>.", with a time that isn't in the future and a version extension/manifest.json has
// had. A Call's "Applies *Name*." names a Principle in AGENTS.md. The pre-commit hook
// (hooks/stamp-docs.mjs) writes the stamps; this catches a commit made with the hook off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const STAMP = /^Updated (.+), at (\S+)\.$/m;
const md = (dir) => existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => `${dir}/${f}`) : [];
const features = md('features');
const docs = [...features, 'README.md', ...md('docs')];
const current = JSON.parse(readFileSync('extension/manifest.json', 'utf8')).version;

// Every version the manifest has had, so a typo'd version doesn't pass for a real one.
const known = new Set([current]);
try {
  const log = execFileSync('git', ['log', '-p', '--format=', '--', 'extension/manifest.json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
  for (const m of log.matchAll(/^[-+ ]\s*"version": "([^"]+)"/gm)) known.add(m[1]);
} catch { /* not a git checkout: only the current version is known */ }

const now = new Date();
const p = (n) => String(n).padStart(2, '0');
const nowStamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
const problemWith = (time, version) => {
  const m = time.match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)$/);
  const when = m && new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // Date rolls 25:00 over to the next day; a real time reads back the same.
  if (!m || when.getMonth() !== +m[2] - 1 || when.getDate() !== +m[3] || when.getHours() !== +m[4]) {
    return `"${time}" isn't a time like ${nowStamp}`;
  }
  if (when > now) return `${time} is in the future`;
  if (!known.has(version)) return `${version} is a version extension/manifest.json has never had (now ${current})`;
};

// Each line inside a Principles or Calls section, with its file and line number.
const sectionLines = () => ['AGENTS.md', ...features].flatMap((file) => {
  let inSection = false;
  return readFileSync(file, 'utf8').split('\n').flatMap((line, i) => {
    if (/^#{1,6} /.test(line)) inSection = /^## (Principles|Calls)\b/.test(line);
    return inSection ? [{ file, n: i + 1, line }] : [];
  });
});

test('every feature file, the README and each guide is stamped with a time and a version WebTime has had', () => {
  const problems = [];
  for (const doc of docs) {
    const stamp = STAMP.exec(readFileSync(doc, 'utf8'));
    if (!stamp) {
      problems.push(`${doc} has no stamp. Turn the hook on (./build.sh does it) and it adds one the next time the file is committed, or add under its title: "Updated ${nowStamp}, at ${current}."`);
      continue;
    }
    const problem = problemWith(stamp[1], stamp[2]);
    if (problem) problems.push(`${doc}'s stamp: ${problem}. Set it to when the description last changed, like "Updated ${nowStamp}, at ${current}."`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('every Principle and Call starts with a time and a version WebTime has had', () => {
  const problems = [];
  for (const { file, n, line } of sectionLines()) {
    if (!line.startsWith('- ')) continue;
    const prefix = line.match(/^- (\d{4}-\d\d-\d\d \d\d:\d\d), (\S+?)\. /);
    const problem = prefix ? problemWith(prefix[1], prefix[2])
      : `starts "${line.slice(2, 22)}…" without a time and version`;
    if (problem) problems.push(`${file}:${n}: ${problem}. Commit it with the hook on and it adds one, or start it with "- ${nowStamp}, ${current}. ".`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('every Principle a Call cites exists', () => {
  const agents = readFileSync('AGENTS.md', 'utf8');
  const section = agents.split(/^## /m).find((s) => s.startsWith('Principles')) ?? '';
  const principles = new Set([...section.matchAll(/^- [^*\n]*\*\*(.+?)\.\*\*/gm)].map((m) => m[1]));
  const problems = [];
  for (const { file, n, line } of sectionLines()) {
    for (const [, name] of line.matchAll(/Applies \*(.+?)\*\./g)) {
      if (!principles.has(name)) problems.push(`${file}:${n}: cites "${name}", which isn't a Principle in AGENTS.md (${[...principles].join('; ') || 'none named yet'}). Cite one of those, or none.`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});
