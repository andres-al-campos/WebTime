/**
 * Reading the tracked-time store across format versions.
 *
 * `trackedTime` has carried a `version` field since it was written, but nothing
 * ever read it back — the load path checked that `lastDate` and `timeHistory`
 * were present and trusted the rest. That is fine until the shape changes, at
 * which point a new build silently misreads old data, or an old build (a user
 * who downgrades, or syncs a profile between machines running different
 * versions) silently misreads new data.
 *
 * The second case is the one that cannot be fixed later: the build that
 * mishandles the future format has already shipped. So the reader has to exist
 * BEFORE the format changes, which is the only reason this module is here while
 * there is still just one version to read.
 */

import type { DateString, Domain, TimeHistory, TrackedTimeData } from '../types.js';

/**
 * Current shape of `trackedTime`. Bump when the stored shape changes, and add
 * the matching branch to `readTrackedTime`.
 *
 * v1: `{ lastDate, timeHistory: { date: { domain: seconds } }, version,
 *        runningSince?, runningDomain? }`
 */
export const TRACKED_TIME_VERSION = 1;

/** What a read produced, and whether the caller should trust it. */
export interface TrackedTimeRead {
  /** The history, empty when nothing was readable. */
  history: TimeHistory;
  /** The date the data was last written under, null when unknown. */
  lastDate: DateString | null;
  /** Clock anchor from an interrupted run, for recovery. */
  runningSince: number | null;
  runningDomain: Domain | null;
  /**
   * Set when the store exists but this build cannot read it. The caller must
   * NOT write over it — doing so would replace data a newer build understands
   * with whatever this one managed to parse.
   */
  fromFuture: boolean;
}

const EMPTY: TrackedTimeRead = {
  history: {}, lastDate: null, runningSince: null, runningDomain: null, fromFuture: false,
};

/**
 * Read whatever is under the `trackedTime` key into the current shape.
 *
 * Accepts what real installs actually hold:
 *
 *   - undefined/null — a fresh install.
 *   - an object with no `version` — written by a build old enough to predate
 *     the field. Treated as v1, which is what it is.
 *   - a v1 object — the current shape.
 *
 * A version NEWER than this build knows returns empty WITH `fromFuture` set,
 * rather than reading the fields it recognises and ignoring the rest. Partial
 * understanding is the dangerous case: the extension would keep running, keep
 * saving, and overwrite the newer store with a lossy copy of itself. Refusing
 * to read costs the user their history for as long as they stay on the old
 * build; reading it wrongly costs them the history permanently.
 *
 * Never throws. A corrupt store reads as empty, because failing to load history
 * must not stop the extension from tracking time.
 */
export function readTrackedTime(raw: unknown): TrackedTimeRead {
  if (!raw || typeof raw !== 'object') return EMPTY;

  const stored = raw as Partial<TrackedTimeData>;

  // A version field that is present but not a number means the store is
  // corrupt, not from the future — there is nothing to preserve.
  if ('version' in stored && typeof stored.version !== 'number') return EMPTY;

  if (typeof stored.version === 'number' && stored.version > TRACKED_TIME_VERSION) {
    return { ...EMPTY, fromFuture: true };
  }

  if (!stored.timeHistory || typeof stored.timeHistory !== 'object') return EMPTY;

  return {
    history: stored.timeHistory,
    lastDate: typeof stored.lastDate === 'string' ? stored.lastDate : null,
    runningSince: typeof stored.runningSince === 'number' ? stored.runningSince : null,
    runningDomain: typeof stored.runningDomain === 'string' ? stored.runningDomain : null,
    fromFuture: false,
  };
}

/** Days held in the history, for showing the user what they have. */
export function dayCount(history: TimeHistory): number {
  return Object.keys(history).length;
}
