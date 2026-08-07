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
  createClock, isRunning, totalSeconds, start, stop, setTotal, bank,
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
