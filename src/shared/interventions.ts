// What should happen to a session right now — decided, not done.
//
// These answer "which intervention is due", and nothing else. Sending messages
// to tabs, ending sessions and persisting state are the caller's job,
// because those need the browser and this needs to be testable without one.
//
// The split follows session-model.ts and clock-gates.ts: arithmetic and
// decisions live in src/shared, effects live in the background. It exists
// because the alternative — deciding and acting in the same function — is what
// produced two deciders for the clock, where a caller tested one condition
// while the real gate tested another.

import {
  type ActiveSession,
  displayFor,
  nextNudgeToFire,
  markNudgeFired,
} from './session-model.js';

/** The session-limit check: has this session run out. */
export type LimitOutcome =
  /** Nothing to do; the session continues. */
  | { kind: 'continue' }
  /** The session reached its end; the caller ends it and the gate comes up. */
  | { kind: 'limit-reached'; endedSessionNum: number };

/** Decide whether a session has hit its limit. */
export function checkSessionLimit(opts: {
  session: ActiveSession;
  dailyTotal: number;
  sessionLimitSeconds: number;
}): LimitOutcome {
  if (opts.sessionLimitSeconds <= 0) return { kind: 'continue' };
  if (displayFor(opts.session, opts.dailyTotal).remaining > 0) return { kind: 'continue' };
  return { kind: 'limit-reached', endedSessionNum: opts.session.sessionNum };
}

/** A φ-nudge came due, with the session advanced to record that it fired. */
export interface NudgeOutcome {
  /** Session time the nudge was scheduled for, for logging. */
  nudgeTime: number;
  /** The session with this nudge marked fired — persist it, or it re-fires. */
  session: ActiveSession;
}

/**
 * Decide whether a φ-nudge is due.
 *
 * Returns the latest unfired nudge at or before now, so a tick that was skipped
 * (or a session that shrank under a live settings change, moving a nudge behind
 * the current position) fires once here rather than being lost or repeating.
 */
export function checkNudge(opts: {
  session: ActiveSession;
  dailyTotal: number;
  sessionLimitSeconds: number;
  nudgeCount?: number;
}): NudgeOutcome | null {
  if (opts.sessionLimitSeconds <= 0) return null;

  const nudgeTime = nextNudgeToFire(opts.session, opts.dailyTotal, opts.nudgeCount);
  if (nudgeTime === null) return null;

  return { nudgeTime, session: markNudgeFired(opts.session, nudgeTime) };
}
