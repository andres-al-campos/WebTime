// Tests for src/shared/time-clock.ts.
// Run with: npm test  (or: node --test test/time-clock.test.mjs)
//
// The headline case is the one that motivated the module: a long gap with
// nothing running (a dead MV3 service worker) must not lose time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = mkdtempSync(join(tmpdir(), 'webtime-clock-test-'));
const outFile = join(out, 'time-clock.mjs');
await build({
  entryPoints: ['src/shared/time-clock.ts'],
  bundle: true,
  format: 'esm',
  outfile: outFile,
  platform: 'node',
});
const {
  createClock, isRunning, totalSeconds, exactSeconds, start, stop, setTotal, bank, restore,
} = await import(pathToFileURL(outFile).href);

const T = 1_700_000_000_000;
const s = (n) => n * 1000;

test('a fresh clock is stopped at zero', () => {
  const c = createClock();
  assert.equal(isRunning(c), false);
  assert.equal(totalSeconds(c, T), 0);
});

test('a stopped clock does not advance with wall time', () => {
  const c = createClock(120);
  assert.equal(totalSeconds(c, T), 120);
  assert.equal(totalSeconds(c, T + s(600)), 120);
});

test('a running clock advances with wall time', () => {
  const c = start(createClock(10), T);
  assert.equal(totalSeconds(c, T), 10);
  assert.equal(totalSeconds(c, T + s(30)), 40);
});

// The reason this module exists.
test('time is not lost across a long gap with nothing running', () => {
  // Clock starts, then the service worker dies for 10 minutes and nothing
  // ticks. On the next wake the total must include the full 10 minutes.
  const c = start(createClock(0), T);
  assert.equal(totalSeconds(c, T + s(600)), 600);
});

test('stop banks elapsed time and freezes the total', () => {
  const c = stop(start(createClock(0), T), T + s(45));
  assert.equal(isRunning(c), false);
  assert.equal(c.banked, 45);
  assert.equal(totalSeconds(c, T + s(9999)), 45);
});

test('start is idempotent — a second start does not reset the origin', () => {
  const c1 = start(createClock(0), T);
  const c2 = start(c1, T + s(20));
  assert.equal(c2.runningSince, T);
  assert.equal(totalSeconds(c2, T + s(30)), 30);
});

test('stop is idempotent — stopping twice does not double-bank', () => {
  const c1 = stop(start(createClock(0), T), T + s(45));
  const c2 = stop(c1, T + s(90));
  assert.equal(c2.banked, 45);
});

test('start/stop cycles accumulate only the running spans', () => {
  let c = createClock(0);
  c = start(c, T);
  c = stop(c, T + s(30));           // +30 running
  c = start(c, T + s(300));         // 4.5 minutes idle, not counted
  c = stop(c, T + s(330));          // +30 running
  assert.equal(totalSeconds(c, T + s(999)), 60);
});

test('totalSeconds floors rather than rounding', () => {
  const c = start(createClock(0), T);
  assert.equal(totalSeconds(c, T + 1999), 1);
  assert.equal(totalSeconds(c, T + 999), 0);
});

test('a backwards wall clock never decreases the total', () => {
  // NTP correction / DST / machine sleep can move Date.now() backwards.
  const c = start(createClock(100), T);
  assert.equal(totalSeconds(c, T - s(60)), 100);
});

test('setTotal replaces the total and keeps the running flag', () => {
  const running = setTotal(start(createClock(500), T), 20, T + s(10));
  assert.equal(isRunning(running), true);
  assert.equal(totalSeconds(running, T + s(10)), 20);
  // Restarted from the given instant: no leftover from the previous domain.
  assert.equal(totalSeconds(running, T + s(40)), 50);

  const stopped = setTotal(createClock(500), 0, T);
  assert.equal(isRunning(stopped), false);
  assert.equal(totalSeconds(stopped, T + s(60)), 0);
});

test('bank checkpoints without stopping the clock', () => {
  const c = bank(start(createClock(0), T), T + s(30));
  assert.equal(isRunning(c), true);
  assert.equal(c.banked, 30);
  assert.equal(totalSeconds(c, T + s(40)), 40);
});

test('bank on a stopped clock is a no-op', () => {
  const c = createClock(75);
  assert.deepEqual(bank(c, T + s(500)), c);
});

// --- restore(): recovering time lost to worker death -----------------------
//
// The bug these pin down: Chrome kills the service worker with no teardown
// callback, so seconds between the last save and the death were never written.
// Reloading only the saved number discarded them — with a 60s save interval and
// a worker dying every ~30s, that loss repeated all day.

const MAX_GAP = s(300);

test('restore credits time that accrued after the last save', () => {
  // Saved 100s while running, worker died, 45s passed before this boot.
  const c = restore(100, T, T + s(45), MAX_GAP);
  assert.equal(totalSeconds(c, T + s(45)), 145);
});

test('restore keeps the clock running so counting continues', () => {
  const c = restore(100, T, T + s(45), MAX_GAP);
  assert.equal(isRunning(c), true);
  assert.equal(totalSeconds(c, T + s(55)), 155);
});

test('a stopped clock restores to exactly what was saved', () => {
  // anchor null = the save happened with the clock stopped, so the number is
  // already complete and there is no gap to credit.
  const c = restore(100, null, T + s(9999), MAX_GAP);
  assert.equal(totalSeconds(c, T + s(9999)), 100);
  assert.equal(isRunning(c), false);
});

test('an implausibly long gap is not credited', () => {
  // Laptop closed for an hour. The user was not on the site; inventing that
  // time would be worse than losing it.
  const c = restore(100, T, T + s(3600), MAX_GAP);
  assert.equal(totalSeconds(c, T + s(3600)), 100);
});

test('a gap beyond the bound still resumes counting from now', () => {
  const c = restore(100, T, T + s(3600), MAX_GAP);
  assert.equal(isRunning(c), true);
  assert.equal(totalSeconds(c, T + s(3610)), 110);
});

test('a backwards clock is not credited', () => {
  // NTP correction or DST moving the clock back would otherwise produce a
  // negative gap and silently reduce the total.
  const c = restore(100, T, T - s(60), MAX_GAP);
  assert.equal(totalSeconds(c, T - s(60)), 100);
});

test('the gap boundary is inclusive', () => {
  assert.equal(totalSeconds(restore(0, T, T + MAX_GAP, MAX_GAP), T + MAX_GAP), 300);
  assert.equal(totalSeconds(restore(0, T, T + MAX_GAP + 1, MAX_GAP), T + MAX_GAP + 1), 0);
});

test('a typical death-and-wake cycle loses nothing', () => {
  // The real scenario: save at 60s, worker dies ~30s later, user returns after
  // 4 minutes idle. Every second on the site is still counted.
  let c = start(createClock(0), T);
  c = bank(c, T + s(60));            // periodic save
  assert.equal(c.banked, 60);
  // ...worker dies. 240s later a wake rehydrates from storage.
  const revived = restore(c.banked, T + s(60), T + s(300), MAX_GAP);
  assert.equal(totalSeconds(revived, T + s(300)), 300);
});

test('a long video is counted in full across many worker deaths', () => {
  // The bound is on the gap BETWEEN BOOTS, not on session length. The 1-minute
  // heartbeat re-anchors the clock, so watching for 30 minutes is 30 short
  // gaps, never one long one — no gap ever approaches MAX_GAP.
  let c = start(createClock(0), T);
  let saved = 0;
  let anchor = T;
  for (let minute = 1; minute <= 30; minute++) {
    const now = T + s(minute * 60);
    // Heartbeat fires: credit the gap since the last anchor, then checkpoint.
    c = restore(saved, anchor, now, MAX_GAP);
    saved = totalSeconds(c, now);
    anchor = now;
  }
  assert.equal(saved, 30 * 60);
});

// --- exactSeconds(): the handoff to the content script's clock -------------
//
// The display jumped because the two clocks were quantised differently. The
// background floored before sending; the content script extrapolated
// fractionally from that floored value, so every update discarded up to a
// second and the number stalled or stepped backward.

test('exactSeconds keeps the fraction totalSeconds throws away', () => {
  const c = start(createClock(0), T);
  assert.equal(totalSeconds(c, T + 40900), 40);
  assert.equal(exactSeconds(c, T + 40900), 40.9);
});

test('exact and floored agree on whole seconds', () => {
  const c = start(createClock(0), T);
  assert.equal(exactSeconds(c, T + s(40)), 40);
  assert.equal(totalSeconds(c, T + s(40)), 40);
});

test('a stopped clock has no fraction to preserve', () => {
  assert.equal(exactSeconds(createClock(75), T + s(999)), 75);
});

test('handing off the exact value never loses time', () => {
  // What the content script does: take the received value, add locally
  // measured elapsed, floor for display. With the exact value the displayed
  // second never repeats or reverses.
  const c = start(createClock(0), T);
  const sentAt = T + 40900;
  const received = exactSeconds(c, sentAt);       // 40.9
  // One second later the content script shows floor(40.9 + 1.0) = 41,
  // matching what the background itself would say.
  assert.equal(Math.floor(received + 1.0), totalSeconds(c, sentAt + 1000));
});

test('handing off a floored value is what lost the second', () => {
  // Pins the old behaviour as wrong: the content script would still show 40
  // a full second after the background had moved to 41.
  const c = start(createClock(0), T);
  const sentAt = T + 40900;
  const flooredHandoff = totalSeconds(c, sentAt); // 40
  assert.equal(Math.floor(flooredHandoff + 1.0), 41);
  assert.equal(totalSeconds(c, sentAt + 1000), 41);
  // ...but at the moment of the update it snapped back:
  assert.equal(Math.floor(flooredHandoff), 40);
  assert.equal(totalSeconds(c, sentAt), 40);
  // The visible defect is the ~0.9s of progress discarded on every update.
  assert.ok(Math.abs((exactSeconds(c, sentAt) - flooredHandoff) - 0.9) < 1e-6);
});
