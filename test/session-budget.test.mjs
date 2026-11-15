// Tests for src/shared/session-budget.ts.
// Run with: npm test  (or: node --test test/session-budget.test.mjs)
//
// The headline cases are the two promises the design makes: over a long
// stretch a site cannot use more than its rate, and ending early costs only
// the time used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = mkdtempSync(join(tmpdir(), 'webtime-budget-test-'));
const outFile = join(out, 'session-budget.mjs');
await build({
  entryPoints: ['src/shared/session-budget.ts'],
  bundle: true,
  format: 'esm',
  outfile: outFile,
  platform: 'node',
});
const {
  fullBudget, regenIntervalMs, sessionsAt, settle, canStart, spend, giveBack,
  unusedFraction, nextSessionAt,
} = await import(pathToFileURL(outFile).href);

const T = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const rules = { sessionsPerDay: 3, maxSessions: 4 };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} is not ${b}`);

test('a new site starts with a full row', () => {
  assert.equal(sessionsAt(fullBudget(rules, T), rules, T), 4);
});

test('three a day means one back every eight hours', () => {
  assert.equal(regenIntervalMs(rules), 8 * HOUR);
  near(sessionsAt({ sessions: 0, at: T }, rules, T + 8 * HOUR), 1);
  near(sessionsAt({ sessions: 0, at: T }, rules, T + 2 * HOUR), 0.25);
});

test('a long gap with nothing running regenerates in full', () => {
  near(sessionsAt({ sessions: 0.5, at: T }, rules, T + 20 * HOUR), 3);
});

test('a full row earns nothing more', () => {
  assert.equal(sessionsAt({ sessions: 4, at: T }, rules, T + 100 * HOUR), 4);
  assert.equal(sessionsAt({ sessions: 1, at: T }, rules, T + 100 * HOUR), 4);
});

test('a clock set back takes nothing away', () => {
  assert.equal(sessionsAt({ sessions: 2, at: T }, rules, T - 5 * HOUR), 2);
});

test('starting uses one whole session', () => {
  const after = spend(fullBudget(rules, T), rules, T);
  assert.deepEqual(after, { sessions: 3, at: T });
});

test('no whole session, no start', () => {
  const b = { sessions: 0.9, at: T };
  assert.equal(canStart(b, rules, T), false);
  assert.equal(spend(b, rules, T), null);
  // 0.1 of a session is 48 minutes away at this rate.
  assert.equal(canStart(b, rules, T + 0.8 * HOUR + 1), true);
});

test('a cancelled start gives the session back', () => {
  const start = { sessions: 2.4, at: T };
  const spent = spend(start, rules, T);
  near(giveBack(spent, rules, T + 5000, 1).sessions, sessionsAt(start, rules, T + 5000));
});

test('ending early costs only the time used', () => {
  // 5 of 40 minutes used: an eighth of a session.
  const spent = spend({ sessions: 2, at: T }, rules, T);
  const back = giveBack(spent, rules, T, unusedFraction(35 * 60, 40 * 60));
  near(back.sessions, 2 - 1 / 8);
});

test('eight five-minute visits add up to exactly one session', () => {
  // Two held, so each visit has a whole session to start from.
  let b = { sessions: 2, at: T };
  const frozen = { sessionsPerDay: 0, maxSessions: 4 };
  for (let i = 0; i < 8; i++) {
    b = spend(b, frozen, T);
    assert.notEqual(b, null, `visit ${i + 1} should have been able to start`);
    b = giveBack(b, frozen, T, unusedFraction(35 * 60, 40 * 60));
  }
  near(b.sessions, 1);
  assert.equal(canStart(b, frozen, T), true);
});

test('most of a session is not a session', () => {
  // The last one, used for five minutes: seven eighths remain and the gate
  // waits for the missing eighth (an hour at this rate).
  const spent = spend({ sessions: 1, at: T }, rules, T);
  const b = giveBack(spent, rules, T, unusedFraction(35 * 60, 40 * 60));
  assert.equal(canStart(b, rules, T), false);
  assert.equal(nextSessionAt(b, rules, T), T + HOUR);
});

test('giving back never passes the maximum', () => {
  assert.equal(giveBack({ sessions: 3.8, at: T }, rules, T, 1).sessions, 4);
});

test('giveBack ignores fractions outside 0..1', () => {
  assert.equal(giveBack({ sessions: 1, at: T }, rules, T, 7).sessions, 2);
  assert.equal(giveBack({ sessions: 1, at: T }, rules, T, -3).sessions, 1);
});

test('unusedFraction is the share of the session left', () => {
  assert.equal(unusedFraction(600, 2400), 0.25);
  assert.equal(unusedFraction(-5, 2400), 0);
  assert.equal(unusedFraction(9999, 2400), 1);
  assert.equal(unusedFraction(10, 0), 0);
});

test('over a week of starting whenever possible, use stays at the rate', () => {
  // Start a session the moment one is whole, checking every minute.
  let b = fullBudget(rules, T);
  let started = 0;
  const week = 7 * 24 * HOUR;
  for (let t = T; t <= T + week; t += 60_000) {
    const next = spend(b, rules, t);
    if (next) { b = next; started += 1; }
  }
  // The row it began with, plus three a day.
  assert.equal(started, 4 + 3 * 7);
});

test('settling before a rule change keeps what was already waited', () => {
  const b = { sessions: 0, at: T };
  const settled = settle(b, rules, T + 4 * HOUR); // half a session at the old rate
  near(settled.sessions, 0.5);
  const faster = { sessionsPerDay: 6, maxSessions: 4 };
  near(sessionsAt(settled, faster, T + 6 * HOUR), 1);
});

test('lowering the maximum caps what is held', () => {
  assert.equal(sessionsAt({ sessions: 4, at: T }, { sessionsPerDay: 3, maxSessions: 2 }, T), 2);
});

test('nextSessionAt is when the next whole session completes', () => {
  // None held: 0.25 there, 0.75 to go at 8h each.
  assert.equal(nextSessionAt({ sessions: 0.25, at: T }, rules, T), T + 6 * HOUR);
  // Some held: the next whole one, not the first.
  assert.equal(nextSessionAt({ sessions: 2.5, at: T }, rules, T), T + 4 * HOUR);
  // Exactly whole: a full interval to the next.
  assert.equal(nextSessionAt({ sessions: 2, at: T }, rules, T), T + 8 * HOUR);
});

test('nextSessionAt is null when full or when nothing regenerates', () => {
  assert.equal(nextSessionAt(fullBudget(rules, T), rules, T), null);
  assert.equal(nextSessionAt({ sessions: 1, at: T }, { sessionsPerDay: 0, maxSessions: 4 }, T), null);
});

test('a session can start at the instant nextSessionAt names', () => {
  const b = { sessions: 0.3, at: T };
  const at = nextSessionAt(b, rules, T);
  assert.equal(canStart(b, rules, at), true);
  assert.equal(canStart(b, rules, at - 1000), false);
});
