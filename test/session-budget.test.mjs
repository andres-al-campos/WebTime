// Tests for src/shared/session-budget.ts.
// Run with: npm test  (or: node --test test/session-budget.test.mjs)
//
// The headline promise: the row only moves when a session starts or the day
// resets, and what a day leaves unused is saved in the bank.
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
  fullBudget, settle, spend, canStart, budgetRules, heldAt, readBudget, dotsShown,
} = await import(pathToFileURL(outFile).href);

const D1 = '2026-11-18';
const D2 = '2026-11-19';
const D3 = '2026-11-20';
const D5 = '2026-11-22';
const rules = { sessionsPerDay: 3, bankSessions: 1 };
const roomy = { sessionsPerDay: 3, bankSessions: 3 };

test('a new site starts with a full row and a full bank', () => {
  assert.deepEqual(heldAt(fullBudget(rules, D1), rules, D1), { daily: 3, bank: 1 });
});

test('each start takes exactly one from the row', () => {
  let b = fullBudget(rules, D1);
  for (const left of [2, 1, 0]) {
    b = spend(b, rules, D1);
    assert.deepEqual(heldAt(b, rules, D1), { daily: left, bank: 1 });
  }
});

test('the bank is spent only once the row is empty', () => {
  const empty = { used: 3, bank: 1, day: D1 };
  assert.deepEqual(heldAt(spend(empty, rules, D1), rules, D1), { daily: 0, bank: 0 });
});

test('a banked session can start when the row is empty', () => {
  assert.equal(canStart({ used: 3, bank: 1, day: D1 }, rules, D1), true);
});

test('with the row and the bank empty nothing starts until the day resets', () => {
  const out = { used: 3, bank: 0, day: D1 };
  assert.equal(canStart(out, rules, D1), false);
  assert.equal(spend(out, rules, D1), null);
  assert.equal(canStart(out, rules, D2), true);
});

test('a new day brings a full row whatever was used', () => {
  assert.equal(heldAt({ used: 3, bank: 0, day: D1 }, rules, D2).daily, 3);
});

test('what the day left goes to the bank', () => {
  // The owner's plan: a bank of 3, emptied, is refilled by ending a day with 3 left.
  assert.deepEqual(heldAt({ used: 0, bank: 0, day: D1 }, roomy, D2), { daily: 3, bank: 3 });
  assert.deepEqual(heldAt({ used: 2, bank: 1, day: D1 }, roomy, D2), { daily: 3, bank: 2 });
});

test('a full bank keeps no more', () => {
  assert.equal(heldAt({ used: 0, bank: 3, day: D1 }, roomy, D2).bank, 3);
});

test('a day with no visit saves its whole row', () => {
  // D1 left 1; D2 was skipped and left 3.
  assert.equal(settle({ used: 2, bank: 0, day: D1 }, { sessionsPerDay: 3, bankSessions: 9 }, D3).bank, 4);
  assert.equal(settle({ used: 3, bank: 0, day: D1 }, roomy, D5).bank, 3);
});

test('settling twice on one day banks once', () => {
  const once = settle({ used: 1, bank: 0, day: D1 }, roomy, D2);
  assert.deepEqual(settle(once, roomy, D2), once);
  assert.deepEqual(once, { used: 0, bank: 2, day: D2 });
});

test('a clock set back takes nothing away', () => {
  const b = { used: 1, bank: 1, day: D2 };
  assert.deepEqual(settle(b, rules, D1), b);
});

test('the first start of a new day banks yesterday before using today', () => {
  const after = spend({ used: 1, bank: 0, day: D1 }, roomy, D2);
  assert.deepEqual(after, { used: 1, bank: 2, day: D2 });
});

test('lowering a setting and raising it again keeps what was held', () => {
  const seven = { sessionsPerDay: 7, bankSessions: 2 };
  const three = { sessionsPerDay: 3, bankSessions: 1 };
  const b = { used: 2, bank: 2, day: D1 };
  assert.deepEqual(heldAt(b, three, D1), { daily: 1, bank: 1 });
  assert.deepEqual(heldAt(b, seven, D1), { daily: 5, bank: 2 });
});

test('a bank over a lowered setting is not topped up, and is not cut at the reset', () => {
  assert.equal(settle({ used: 0, bank: 3, day: D1 }, rules, D2).bank, 3);
});

test('a start from a lowered bank uses what is shown', () => {
  const after = spend({ used: 3, bank: 3, day: D1 }, rules, D1);
  assert.equal(after.bank, 0);
});

test('the bank setting falls back to a total stored before it existed', () => {
  assert.deepEqual(budgetRules({}), { sessionsPerDay: 3, bankSessions: 1 });
  assert.deepEqual(budgetRules({ sessionsPerDay: 2, bankSessions: 0 }), { sessionsPerDay: 2, bankSessions: 0 });
  assert.deepEqual(budgetRules({ sessionsPerDay: 3, maxSessions: 5 }), { sessionsPerDay: 3, bankSessions: 2 });
});

test('nothing stored reads as a full budget', () => {
  assert.deepEqual(readBudget(undefined, rules, D1), fullBudget(rules, D1));
});

test('a stored budget reads back unchanged', () => {
  const b = { used: 2, bank: 1, day: D1 };
  assert.deepEqual(readBudget(b, rules, D2), b);
});

test('a budget from the refilling design keeps its dots, part-refilled ones rounded up', () => {
  assert.deepEqual(readBudget({ sessions: 2.4, at: 1, bank: 1 }, rules, D1), { used: 1, bank: 1, day: D1 });
  assert.deepEqual(readBudget({ sessions: 0.2, at: 1, bank: 0 }, rules, D1), { used: 2, bank: 0, day: D1 });
  // Stored before the bank was its own bucket: what is over a day's worth was it.
  assert.deepEqual(readBudget({ sessions: 4, at: 1 }, rules, D1), { used: 0, bank: 1, day: D1 });
});

test('the gate shows the row while it has any left, and nothing of the bank', () => {
  assert.deepEqual(dotsShown({ used: 2, bank: 3, day: D1 }, roomy, D1), { kind: 'row', held: 1, slots: 3 });
});

test('once the row is used up the bank takes its place, every slot of it', () => {
  assert.deepEqual(dotsShown({ used: 3, bank: 2, day: D1 }, roomy, D1), { kind: 'bank', held: 2, slots: 3 });
});

test('a start counting down drains its dot in place', () => {
  const lastOfRow = { used: 2, bank: 2, day: D1 };
  assert.deepEqual(dotsShown(lastOfRow, roomy, D1, spend(lastOfRow, roomy, D1)), { kind: 'row', held: 0, slots: 3 });
  const fromBank = { used: 3, bank: 2, day: D1 };
  assert.deepEqual(dotsShown(fromBank, roomy, D1, spend(fromBank, roomy, D1)), { kind: 'bank', held: 1, slots: 3 });
});

test('with the row and the bank empty the gate shows the spent row', () => {
  assert.equal(dotsShown({ used: 3, bank: 0, day: D1 }, roomy, D1).kind, 'row');
});
