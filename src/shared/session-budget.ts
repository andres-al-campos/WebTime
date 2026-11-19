// How many sessions a site holds.
//
// A site with rules on gets a fixed row of sessions each day. Starting a session
// uses one whole dot, and nothing else moves the row until the day resets, so
// the count can be planned against. Sessions left when the day ends go to the
// bank, up to its size; the bank is spent last and doesn't expire.
//
// The row is stored as how many were used, not how many are left: lowering a
// setting and raising it again then gives back the same row by construction.
//
// Pure functions only. `today` is always passed, never read, so a test or a
// drive can stand on any day.

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a site holds: `used` of the row on logical day `day`, and its bank. */
export interface Budget {
  used: number;
  bank: number;
  day: string;
}

export interface BudgetRules {
  /** The row of sessions each day brings. */
  sessionsPerDay: number;
  /** The most the bank keeps. */
  bankSessions: number;
}

export const DEFAULT_SESSIONS_PER_DAY = 3;
/** Sessions that can be saved up beyond a day's worth. */
export const DEFAULT_BANK_SESSIONS = 1;

/** A site's rules from its settings, with the defaults filled in. */
export function budgetRules(cfg?: { sessionsPerDay?: number; bankSessions?: number; maxSessions?: number }): BudgetRules {
  const sessionsPerDay = cfg?.sessionsPerDay ?? DEFAULT_SESSIONS_PER_DAY;
  return { sessionsPerDay, bankSessions: bankOf(cfg, sessionsPerDay) };
}

/** The bank setting, or one derived from a total stored before the bank existed. */
export function bankOf(cfg: { bankSessions?: number; maxSessions?: number } | undefined, sessionsPerDay: number): number {
  if (cfg?.bankSessions !== undefined) return Math.max(0, cfg.bankSessions);
  if (cfg?.maxSessions !== undefined) return Math.max(0, cfg.maxSessions - sessionsPerDay);
  return DEFAULT_BANK_SESSIONS;
}

function capsOf(rules: BudgetRules): { perDay: number; bankMax: number } {
  return {
    perDay: Math.max(0, Math.floor(rules.sessionsPerDay)),
    bankMax: Math.max(0, Math.floor(rules.bankSessions)),
  };
}

/** A site that has never spent anything: a full row and a full bank. */
export function fullBudget(rules: BudgetRules, today: string): Budget {
  return { used: 0, bank: capsOf(rules).bankMax, day: today };
}

/**
 * A budget as read from storage. One stored while sessions refilled through the
 * day has `sessions` and `at` instead: it stays on today, with any part-refilled
 * session rounded up so the change takes nothing away.
 */
export function readBudget(stored: unknown, rules: BudgetRules, today: string): Budget {
  const s = (stored ?? {}) as { used?: unknown; bank?: unknown; day?: unknown; sessions?: unknown };
  if (typeof s.used === 'number' && typeof s.bank === 'number' && typeof s.day === 'string') {
    return { used: s.used, bank: s.bank, day: s.day };
  }
  if (typeof s.sessions !== 'number') return fullBudget(rules, today);
  const { perDay } = capsOf(rules);
  const held = Math.max(0, s.sessions);
  const bank = Math.min(held, Math.max(0, typeof s.bank === 'number' ? s.bank : held - perDay));
  return { used: Math.max(0, perDay - Math.ceil(held - bank)), bank: Math.ceil(bank), day: today };
}

/** Whole days from one logical day to another; negative if the clock went back. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) || 0;
}

/**
 * The budget as it stands on `today`. Each day that ended banks what its row had
 * left, and a day with no visit left its whole row. A bank already over a lowered
 * setting keeps what it has and takes no more.
 */
export function settle(b: Budget, rules: BudgetRules, today: string): Budget {
  const days = daysBetween(b.day, today);
  if (days <= 0) return b;
  const { perDay, bankMax } = capsOf(rules);
  const saved = Math.max(0, perDay - b.used) + perDay * (days - 1);
  return { used: 0, bank: b.bank >= bankMax ? b.bank : Math.min(bankMax, b.bank + saved), day: today };
}

/** What is held on `today`: the day's row and the bank, within the current settings. */
export function heldAt(b: Budget, rules: BudgetRules, today: string): { daily: number; bank: number } {
  const { perDay, bankMax } = capsOf(rules);
  const now = settle(b, rules, today);
  return { daily: Math.max(0, perDay - now.used), bank: Math.min(bankMax, now.bank) };
}

/** Whether a session can start on `today`. */
export function canStart(b: Budget, rules: BudgetRules, today: string): boolean {
  const { daily, bank } = heldAt(b, rules, today);
  return daily >= 1 || bank >= 1;
}

/**
 * The dots the gate shows for `budget`, filled as `shown` holds them: the same
 * budget, or what it becomes once a start that is counting down is spent, so
 * the dot drains in place. The reserve (the bank) is a backup, not something to
 * plan the day around, so it is shown only once the day's row is empty, and
 * then in the row's place, every slot of it.
 */
export function dotsShown(b: Budget, rules: BudgetRules, today: string, shown: Budget = b):
  { kind: 'row' | 'reserve'; held: number; slots: number } {
  const { perDay, bankMax } = capsOf(rules);
  const before = heldAt(b, rules, today);
  const after = heldAt(shown, rules, today);
  if (before.daily === 0 && before.bank > 0) return { kind: 'reserve', held: after.bank, slots: bankMax };
  return { kind: 'row', held: after.daily, slots: perDay };
}

/** Start a session: one from the row, or from the bank once the row is empty. */
export function spend(b: Budget, rules: BudgetRules, today: string): Budget | null {
  const now = settle(b, rules, today);
  const { daily, bank } = heldAt(now, rules, today);
  if (daily >= 1) return { ...now, used: now.used + 1 };
  return bank >= 1 ? { ...now, bank: bank - 1 } : null;
}
