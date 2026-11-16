// How many sessions a site holds, and when the next one arrives.
//
// A site with rules on holds a fractional number of sessions. They regenerate
// continuously up to a maximum; starting a session uses one, and ending one
// early returns the unused part. There is no daily reset and no cooldown: the
// regeneration rate is the whole policy, so over any stretch a site cannot use
// more than `sessionsPerDay`, while a single day can run from nothing up to
// the maximum plus what regenerates while awake.
//
// Timestamp accounting, like time-clock.ts: the held amount is stored with the
// instant it was true, and read by adding what has regenerated since. Counting
// ticks would lose every session an MV3 worker slept through.
//
// Pure functions only. `now` is always passed, never read, so a test or a
// drive can stand anywhere in time.

const DAY_MS = 24 * 60 * 60 * 1000;

// Returning 5 of 8 eighths and then using a session must not leave 0.9999…
// where the arithmetic says 1. Whole-session comparisons round at this grain,
// far below anything the row of dots could show.
const EPSILON = 1e-9;

/**
 * What a site holds: `sessions` was the amount at instant `at` (epoch ms), and
 * `bank` the part of it saved beyond a day's worth. A budget stored before the
 * bank was its own bucket has no `bank`; everything over a day's worth was it.
 */
export interface Budget {
  sessions: number;
  at: number;
  bank?: number;
}

export interface BudgetRules {
  /** Regeneration rate. One session returns every 24h / sessionsPerDay. */
  sessionsPerDay: number;
  /** The most a site can hold. A full row earns nothing more. */
  maxSessions: number;
}

export const DEFAULT_SESSIONS_PER_DAY = 3;
/** Sessions that can be saved up beyond a day's worth. */
export const DEFAULT_BANK_SESSIONS = 1;

/** A session shorter than this isn't offered; the gate waits for more. */
export const MIN_SESSION_SECONDS = 5 * 60;

/**
 * A site's rules from its settings, with the defaults filled in. The most a
 * site holds is a day's sessions plus its bank.
 */
export function budgetRules(cfg?: { sessionsPerDay?: number; bankSessions?: number; maxSessions?: number }): BudgetRules {
  const sessionsPerDay = cfg?.sessionsPerDay ?? DEFAULT_SESSIONS_PER_DAY;
  return { sessionsPerDay, maxSessions: sessionsPerDay + bankOf(cfg, sessionsPerDay) };
}

/** The bank setting, or one derived from a total stored before the bank existed. */
export function bankOf(cfg: { bankSessions?: number; maxSessions?: number } | undefined, sessionsPerDay: number): number {
  if (cfg?.bankSessions !== undefined) return Math.max(0, cfg.bankSessions);
  if (cfg?.maxSessions !== undefined) return Math.max(0, cfg.maxSessions - sessionsPerDay);
  return DEFAULT_BANK_SESSIONS;
}

/**
 * What is held at `now`, in its two buckets. Sessions refill the day's row
 * first and only what overflows a full row goes to the bank; a start uses the
 * row first and the bank last, since the bank is the reserve for when the day
 * runs out. `banked` is the whole sessions in the bank, for display.
 */
export function heldAt(b: Budget, rules: BudgetRules, now: number): { daily: number; bank: number; banked: number } {
  const { perDay, bankMax } = capsOf(rules);
  const kept = keptAt(b, rules, now);
  const daily = Math.min(perDay, kept.daily);
  const bank = Math.min(bankMax, kept.bank);
  return { daily, bank, banked: Math.floor(bank + EPSILON) };
}

function capsOf(rules: BudgetRules): { perDay: number; bankMax: number } {
  return {
    perDay: Math.max(0, Math.min(rules.sessionsPerDay, rules.maxSessions)),
    bankMax: Math.max(0, rules.maxSessions - Math.max(0, rules.sessionsPerDay)),
  };
}

/**
 * Both buckets at `now`, refilled, but not cut down to the current caps. A
 * bucket already over its cap (the setting was lowered) keeps what it had and
 * takes no refill, so lowering a setting and raising it again loses nothing.
 * Only a start commits the lower caps, so the row drops when one is used.
 */
function keptAt(b: Budget, rules: BudgetRules, now: number): { daily: number; bank: number } {
  const { perDay, bankMax } = capsOf(rules);
  const sessions = Math.max(0, b.sessions);
  const storedBank = Math.min(sessions, Math.max(0, b.bank ?? sessions - perDay));
  const storedDaily = sessions - storedBank;
  // A `now` before `at` (the clock was set back) refills nothing rather than
  // taking sessions away.
  const refilled = Math.max(0, now - b.at) / regenIntervalMs(rules);
  const room = Math.max(0, perDay - storedDaily);
  const daily = storedDaily + Math.min(room, refilled);
  const overflow = Math.max(0, refilled - room);
  const bank = storedBank >= bankMax ? storedBank : Math.min(bankMax, storedBank + overflow);
  return { daily, bank };
}

/** The smallest share of a session worth starting, for a given full length. */
export function minFractionFor(sessionLengthSeconds: number): number {
  if (sessionLengthSeconds <= 0) return 1;
  return Math.min(1, MIN_SESSION_SECONDS / sessionLengthSeconds);
}

/** A site that has never spent anything: a full row. */
export function fullBudget(rules: BudgetRules, now: number): Budget {
  const max = Math.max(0, rules.maxSessions);
  return { sessions: max, at: now, bank: Math.max(0, max - Math.max(0, rules.sessionsPerDay)) };
}

/** Milliseconds for one session to regenerate; Infinity when the rate is 0. */
export function regenIntervalMs(rules: BudgetRules): number {
  return rules.sessionsPerDay > 0 ? DAY_MS / rules.sessionsPerDay : Infinity;
}

/** Sessions held at `now`, fractional: both buckets together. */
export function sessionsAt(b: Budget, rules: BudgetRules, now: number): number {
  const { daily, bank } = heldAt(b, rules, now);
  return daily + bank;
}

/**
 * The same budget restated at `now`.
 *
 * Call this BEFORE the rules change: the time already waited was waited at
 * the old rate, and reading it back at a new one would rewrite it.
 */
export function settle(b: Budget, rules: BudgetRules, now: number): Budget {
  const { daily, bank } = keptAt(b, rules, now);
  return { sessions: daily + bank, at: now, bank };
}

/**
 * How much of a session a start would use right now. The row is used before
 * the bank: a whole session from the row, else the row's last partial session
 * when it is at least `minFraction`, else a whole one from the bank, else
 * whatever is held when that is at least `minFraction`; otherwise 0.
 *
 * A partial start exists so that ending early loses nothing all the way down:
 * seven eighths left over from a short visit is a 35-minute session, not an
 * hour's wait for the missing eighth. `minFraction` keeps the gate from
 * offering a session too short to be one.
 */
export function startable(b: Budget, rules: BudgetRules, now: number, minFraction = 1): number {
  const { daily, bank } = heldAt(b, rules, now);
  const floor = Math.min(1, Math.max(0, minFraction));
  const enough = (x: number) => x > EPSILON && x >= floor - EPSILON;
  if (daily >= 1 - EPSILON) return 1;
  if (enough(daily)) return daily;
  if (bank >= 1 - EPSILON) return 1;
  const held = daily + bank;
  return held >= 1 - EPSILON ? 1 : enough(held) ? held : 0;
}

/**
 * Start a session: use what `startable` offers. `fraction` is how much of a
 * full-length session was bought. Null when nothing can start.
 */
export function spend(
  b: Budget,
  rules: BudgetRules,
  now: number,
  minFraction = 1,
): { budget: Budget; fraction: number } | null {
  const fraction = startable(b, rules, now, minFraction);
  if (fraction <= 0) return null;
  const { daily, bank } = heldAt(b, rules, now);
  // A row too short to start keeps filling, and a whole session comes from
  // the bank; mixing the two would strand a fraction in the bank.
  const fromBank = daily >= fraction - EPSILON ? 0
    : bank >= fraction - EPSILON ? fraction
    : fraction - daily;
  const fromDaily = fraction - fromBank;
  const leftInBank = Math.max(0, bank - fromBank);
  return {
    budget: { sessions: Math.max(0, daily - fromDaily) + leftInBank, at: now, bank: leftInBank },
    fraction,
  };
}

/**
 * The instant a session can next start, or null when one can start now or
 * nothing regenerates. This is the wait the out-of-sessions screen counts.
 */
export function nextStartAt(b: Budget, rules: BudgetRules, now: number, minFraction = 1): number | null {
  if (startable(b, rules, now, minFraction) > 0) return null;
  const interval = regenIntervalMs(rules);
  if (!Number.isFinite(interval)) return null;
  const floor = Math.min(1, Math.max(0, minFraction));
  const target = Math.min(Math.max(0, rules.maxSessions), Math.max(floor, EPSILON * 2));
  const missing = target - sessionsAt(b, rules, now);
  if (missing <= 0) return null;
  return now + missing * interval;
}

/**
 * The instant the next whole session completes, or null when the row is full
 * or nothing regenerates: the "Next session in" on the gate.
 */
export function nextSessionAt(b: Budget, rules: BudgetRules, now: number): number | null {
  const held = sessionsAt(b, rules, now);
  const max = Math.max(0, rules.maxSessions);
  const target = Math.min(max, Math.floor(held + EPSILON) + 1);
  const missing = target - held;
  if (missing <= EPSILON) return null;
  const interval = regenIntervalMs(rules);
  if (!Number.isFinite(interval)) return null;
  return now + missing * interval;
}
