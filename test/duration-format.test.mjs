// The blocker's countdown once used a local formatter that had no hours
// rollover: a 1h4m5s cooldown rendered as "64:05", and a long one as "276:00".
// Cooldowns compound with the session count, so this was reachable in normal
// use — but only after enough sessions in a day that nobody hits it while
// testing a change.
//
// Two tests: the arithmetic one pins the rollover, the source-text one refuses
// to let a second countdown formatter reappear in content.ts. The second is
// blunt for the reason background-wiring.test.mjs is — nothing throws when a
// countdown displays 276:00, so only a browser at the right moment shows it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(mkdtempSync(join(tmpdir(), 'webtime-fmt-')), 'utils.mjs');
execFileSync('npx', ['esbuild', 'src/shared/utils.ts', '--bundle', '--format=esm', `--outfile=${out}`]);
const { formatClock } = await import(out);

test('formatClock rolls over into hours', () => {
  assert.equal(formatClock(3599), '59:59');
  assert.equal(formatClock(3600), '1:00:00');
  assert.equal(formatClock(3845), '1:04:05'); // not "64:05"
  assert.equal(formatClock(16560), '4:36:00'); // not "276:00"
});

test('formatClock pads seconds, and minutes only after an hour', () => {
  assert.equal(formatClock(45), '0:45');
  assert.equal(formatClock(90), '1:30');
  assert.equal(formatClock(3665), '1:01:05');
});

test('formatClock floors, and never renders a negative', () => {
  assert.equal(formatClock(90.9), '1:30');
  assert.equal(formatClock(-5), '0:00');
});

test('the blocker countdown uses the shared formatter, not a local one', () => {
  const src = readFileSync('src/content.ts', 'utf8');
  // The bug was a second, subtly different implementation living alongside the
  // shared one. Any locally-defined countdown/clock formatter is that bug.
  // formatTimeAdaptive is deliberately exempt: it zero-pads minutes so the
  // corner timer doesn't change width crossing 9:59, which formatClock's
  // unpadded "10:00" would. Everything else should use the shared one.
  const localFormatter = /function\s+format(Countdown|Clock|Duration|CooldownDuration)\s*\(/.exec(src);
  assert.equal(
    localFormatter,
    null,
    `content.ts defines its own ${localFormatter?.[0]} — use formatClock from shared/utils.ts`
  );
  // And the countdown element must actually be fed by it.
  const countdownAssign = /className: 'web-time-blocker-countdown'[\s\S]{0,300}?text: (\w+)\(/.exec(src);
  assert.ok(countdownAssign, 'could not find the blocker countdown element');
  assert.equal(countdownAssign[1], 'formatClock');
});
