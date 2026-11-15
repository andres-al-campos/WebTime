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

/** What a site holds: `sessions` was the amount at instant `at` (epoch ms). */
export interface Budget {
  sessions: number;
  at: number;
}

export interface BudgetRules {
  /** Regeneration rate. One session returns every 24h / sessionsPerDay. */
  sessionsPerDay: number;
  /** The most a site can hold. A full row earns nothing more. */
  maxSessions: number;
}

/** A site that has never spent anything: a full row. */
export function fullBudget(rules: BudgetRules, now: number): Budget {
  return { sessions: Math.max(0, rules.maxSessions), at: now };
}

/** Milliseconds for one session to regenerate; Infinity when the rate is 0. */
export function regenIntervalMs(rules: BudgetRules): number {
  return rules.sessionsPerDay > 0 ? DAY_MS / rules.sessionsPerDay : Infinity;
}

/**
 * Sessions held at `now`, fractional.
 *
 * A `now` before `at` (the system clock was set back) regenerates nothing
 * rather than taking sessions away.
 */
export function sessionsAt(b: Budget, rules: BudgetRules, now: number): number {
  const max = Math.max(0, rules.maxSessions);
  const elapsed = Math.max(0, now - b.at);
  const regenerated = elapsed / regenIntervalMs(rules);
  return Math.min(max, Math.max(0, b.sessions) + regenerated);
}

/**
 * The same budget restated at `now`.
 *
 * Call this BEFORE the rules change: the time already waited was waited at
 * the old rate, and reading it back at a new one would rewrite it.
 */
export function settle(b: Budget, rules: BudgetRules, now: number): Budget {
  return { sessions: sessionsAt(b, rules, now), at: now };
}

/** Whether a whole session is there to start. */
export function canStart(b: Budget, rules: BudgetRules, now: number): boolean {
  return sessionsAt(b, rules, now) >= 1 - EPSILON;
}

/** Use one session. Null when there isn't a whole one. */
export function spend(b: Budget, rules: BudgetRules, now: number): Budget | null {
  if (!canStart(b, rules, now)) return null;
  return { sessions: Math.max(0, sessionsAt(b, rules, now) - 1), at: now };
}

/**
 * Return part of a session: 1 for a start that was cancelled, the unused
 * fraction for one ended early. Never past the maximum.
 */
export function giveBack(b: Budget, rules: BudgetRules, now: number, fraction: number): Budget {
  const part = Math.min(1, Math.max(0, fraction));
  const max = Math.max(0, rules.maxSessions);
  return { sessions: Math.min(max, sessionsAt(b, rules, now) + part), at: now };
}

/** The share of a session left unused, for giveBack. */
export function unusedFraction(remainingSeconds: number, lengthSeconds: number): number {
  if (lengthSeconds <= 0) return 0;
  return Math.min(1, Math.max(0, remainingSeconds / lengthSeconds));
}

/**
 * The instant the next whole session completes, or null when the row is full
 * or nothing regenerates. With none held this is when the gate can come back;
 * with some held it is the "Next session in" on the gate.
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
