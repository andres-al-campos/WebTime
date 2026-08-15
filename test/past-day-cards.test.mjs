// Tests for cooldownPhrase in src/popup/past-day-cards.ts.
// Run with: npm test  (or: node --test test/past-day-cards.test.mjs)
//
// The card footer prints the arithmetic that produced the cooldown, so the
// headline case is that every equation it prints actually multiplies out. It
// cannot: the increment is stored in MINUTES and a stored 4.375 min is a true
// 262.5s, which no whole-second format can write. So the rule under test is
// "print an equation only when the printed factors hold", not "always print".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The module builds DOM nodes at call time; only the import needs `document` to
// exist. cooldownPhrase itself is pure string work and never touches it.
globalThis.document = { createElement: () => ({ style: {}, append() {}, addEventListener() {} }) };

const out = mkdtempSync(join(tmpdir(), 'webtime-cards-test-'));
const outFile = join(out, 'past-day-cards.mjs');
await build({
  entryPoints: ['src/popup/past-day-cards.ts'],
  bundle: true,
  format: 'esm',
  outfile: outFile,
  platform: 'node',
});
const { cooldownPhrase } = await import(pathToFileURL(outFile).href);

/** Read the factors back out of "4:22.5 × 4 = 17:30", or null if not an equation. */
function equationOf(phrase) {
  const m = phrase.match(/^([\d.:]+) × (\d+) = ([\d.:]+)$/);
  if (!m) return null;
  const secs = str => {
    const parts = str.split(':').map(Number);
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  };
  return { increment: secs(m[1]), sessionNum: Number(m[2]), total: secs(m[3]) };
}

test('the four cards from a real day render their true increments', () => {
  // Session 4's increment is a genuine 262.5s (a stored 4.375 min), which is
  // why the tenth is shown — a floored "4:22" would read 4:22 x 4 = 17:28.
  assert.equal(cooldownPhrase(630, 2), '5:15 × 2 = 10:30');
  assert.equal(cooldownPhrase(840, 3), '4:40 × 3 = 14:00');
  assert.equal(cooldownPhrase(1050, 4), '4:22.5 × 4 = 17:30');
  assert.equal(cooldownPhrase(1260, 5), '4:12 × 5 = 21:00');
});

test('every equation printed multiplies out exactly', () => {
  const wrong = [];
  for (let n = 2; n <= 12; n++) {
    for (let total = 1; total <= 6000; total++) {
      const eq = equationOf(cooldownPhrase(total, n));
      if (!eq) continue;
      if (Math.abs(eq.increment * eq.sessionNum - eq.total) > 0.001) {
        wrong.push(cooldownPhrase(total, n));
      }
    }
  }
  assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} equations do not hold`);
});

test('a repeating fraction falls back to the total alone', () => {
  // A third of a second cannot be written in one decimal, so no equation is
  // printed rather than one that visibly fails to hold.
  assert.equal(cooldownPhrase(1, 3), '0:01 cooldown');
  assert.equal(cooldownPhrase(4, 3), '0:04 cooldown');
  assert.equal(cooldownPhrase(7, 6), '0:07 cooldown');
});

test("session 1 states its cooldown without the x1 identity", () => {
  assert.equal(cooldownPhrase(420, 1), '7:00 cooldown');
});

test('no cooldown says so', () => {
  assert.equal(cooldownPhrase(0, 3), 'no cooldown');
  assert.equal(cooldownPhrase(0, 1), 'no cooldown');
});
