/**
 * Finished-session records, per day per domain.
 *
 * `sessions[domain]` in the shell holds only the CURRENT session — starting
 * session 2 is the same act as discarding session 1. Nothing else kept a
 * finished session, so a day's shape was unrecoverable the moment it happened.
 * This is the list that survives it.
 *
 * Every field is read off the session at the moment it ends, never recomputed
 * from settings afterward: `cooldownSec` in particular is the cooldown that
 * actually ran, so changing the increment later cannot rewrite the past.
 */

import type { ActiveSession } from './session-model.js';

/** How a session ended. Mutually exclusive — one card, one answer. */
export type SessionEndState =
  /** Ran to its limit. */
  | 'completed'
  /** The user ended it themselves. */
  | 'early'
  /** The day rolled over while it was still running. Only ever the last one. */
  | 'dayEnded';

/**
 * One finished session. Deliberately a fixed tuple rather than an object: this
 * is written once per session forever, and the key names would outweigh the
 * data. ~20 bytes each.
 *
 * [used, effectiveLength, cooldownSec, endState]
 */
export type SessionRecord = [
  /** Seconds actually spent in the session. */
  used: number,
  /** Its full length: baseLength + carryover + graceSeconds. */
  effectiveLength: number,
  /** The cooldown that followed, in seconds. 0 when none ran. */
  cooldownSec: number,
  endState: SessionEndState,
];

/** date → domain → the day's finished sessions, in the order they happened. */
export type SessionHistory = Record<string, Record<string, SessionRecord[]>>;

/**
 * Current shape of the stored history. Bump ONLY when a stored record or the
 * map around it changes shape, and add the matching branch to `readStored`.
 *
 * Versioned because this is the one store that accumulates: two years of
 * records that are never discarded, unlike session state (dropped daily) or
 * settings (additive). `SessionRecord` is a fixed tuple, so appending a field
 * makes every older record one element short with nothing in the data itself
 * to say so. The version is what tells them apart.
 */
export const SESSION_HISTORY_VERSION = 1;

/**
 * How the history sits in storage.local.
 *
 * The envelope exists to carry the version; `history` is the same map it
 * always was.
 */
export interface StoredSessionHistory {
  version: number;
  history: SessionHistory;
}

/**
 * Read whatever is in storage into the current shape.
 *
 * Accepts three things, because all three exist on real installs:
 *
 *   - undefined/null — nothing stored yet (every fresh install, and any
 *     profile that predates the history feature).
 *   - a bare `SessionHistory` — every build before versioning. Treated as v1,
 *     which it is: the envelope was added around an unchanged record shape.
 *   - a `StoredSessionHistory` envelope — v1 and later.
 *
 * A version NEWER than this build understands returns empty rather than
 * guessing at a shape from the future: an older build reading newer data would
 * otherwise write malformed records back over it. Empty history degrades the
 * session cards; misread history corrupts the store.
 *
 * Never throws. A corrupt store returns empty, because failing to load history
 * must not stop the extension from tracking time.
 */
export function readStored(raw: unknown): SessionHistory {
  if (!raw || typeof raw !== 'object') return {};

  // Pre-versioning: a bare date → domain → records map, no envelope.
  if (!('version' in raw)) return raw as SessionHistory;

  const stored = raw as Partial<StoredSessionHistory>;
  if (typeof stored.version !== 'number') return {};
  if (stored.version > SESSION_HISTORY_VERSION) return {};
  if (!stored.history || typeof stored.history !== 'object') return {};
  return stored.history;
}

/** Wrap the history for storage. The only thing that should write this key. */
export function toStored(history: SessionHistory): StoredSessionHistory {
  return { version: SESSION_HISTORY_VERSION, history };
}

/** The session's full length — what `used` is measured against. */
export function effectiveLengthOf(s: ActiveSession): number {
  return s.baseLength + s.carryover + s.graceSeconds;
}

/**
 * Seconds spent in `s` given the daily total when it ended.
 *
 * Clamped to the session's own length: a session that overran its limit between
 * ticks would otherwise render as a bar fuller than its track.
 */
export function usedSecondsOf(s: ActiveSession, dailyTotalAtEnd: number): number {
  const raw = dailyTotalAtEnd - s.startDaily;
  return Math.max(0, Math.min(raw, effectiveLengthOf(s)));
}

/** Build the record for a session that just ended. */
export function toRecord(
  s: ActiveSession,
  dailyTotalAtEnd: number,
  cooldownSec: number,
  endState: SessionEndState
): SessionRecord {
  return [usedSecondsOf(s, dailyTotalAtEnd), effectiveLengthOf(s), cooldownSec, endState];
}

/**
 * Append `record` to (date, domain), returning a new history.
 *
 * Pure so the shell's three end points share one definition of "a session
 * finished" — the shell only decides when, never how.
 */
export function appendRecord(
  history: SessionHistory,
  date: string,
  domain: string,
  record: SessionRecord
): SessionHistory {
  const day = history[date] || {};
  const existing = day[domain] || [];
  return { ...history, [date]: { ...day, [domain]: [...existing, record] } };
}

/**
 * Drop days outside the newest `keepDays` distinct dates.
 *
 * At ~120 bytes/day this buys nothing against a 10MB quota for years; it exists
 * so the structure has a defined ceiling rather than growing untended.
 */
export function pruneHistory(history: SessionHistory, keepDays: number): SessionHistory {
  const dates = Object.keys(history).sort();
  if (dates.length <= keepDays) return history;
  const keep = dates.slice(dates.length - keepDays);
  const out: SessionHistory = {};
  for (const d of keep) out[d] = history[d];
  return out;
}

/** A day's sessions for one domain, oldest first. Empty when nothing is stored. */
export function sessionsFor(history: SessionHistory, date: string, domain: string): SessionRecord[] {
  return history[date]?.[domain] || [];
}

/**
 * Running total after each session, for the card footers.
 *
 * This domain's sessions only — it is deliberately NOT the all-sites figure in
 * the usage card above, and will not match it.
 */
export function runningTotals(records: SessionRecord[]): number[] {
  let run = 0;
  return records.map(r => (run += r[0]));
}
