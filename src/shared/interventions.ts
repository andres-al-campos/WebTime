// What should happen to a session right now — decided, not done.
//
// These answer "which intervention is due", and nothing else. Sending messages
// to tabs, starting cooldown tickers and persisting state are the caller's job,
// because those need the browser and this needs to be testable without one.
//
// The split follows session-model.ts and clock-gates.ts: arithmetic and
// decisions live in src/shared, effects live in the background. It exists
// because the alternative — deciding and acting in the same function — is what
// produced two deciders for the clock, where a caller tested one condition
// while the real gate tested another.

import {
  type ActiveSession,
  type CooldownResult,
  displayFor,
  naturalEnd,
  nextNudgeToFire,
  markNudgeFired,
} from './session-model.js';

/** The session-limit check: has this session run out, and what follows if so. */
export type LimitOutcome =
  /** Nothing to do; the session continues. */
  | { kind: 'continue' }
  /**
   * Already in a cooldown. The clock gate should have prevented the caller from
   * asking, so this is defensive — but it still means "stop, don't run other
   * interventions", which is why it isn't folded into 'continue'.
   */
  | { kind: 'in-cooldown' }
  /** The session reached its end. Fire the cooldown and start the next one. */
  | { kind: 'limit-reached'; result: CooldownResult; endedSessionNum: number };

/**
 * Decide whether a session has hit its limit.
 *
 * `cooldownEndsAt` is the domain's stored cooldown expiry (0 or absent when
 * there is none), and `now` is passed rather than read so the decision stays
 * pure — the same inputs must always give the same answer.
 */
export function checkSessionLimit(opts: {
  session: ActiveSession;
  dailyTotal: number;
  sessionLimitSeconds: number;
  cooldownIncrementSeconds: number;
  cooldownEndsAt: number;
  now: number;
}): LimitOutcome {
  if (opts.sessionLimitSeconds <= 0) return { kind: 'continue' };
  if (opts.cooldownEndsAt > opts.now) return { kind: 'in-cooldown' };

  if (displayFor(opts.session, opts.dailyTotal).remaining > 0) {
    return { kind: 'continue' };
  }

  // Carryover is consumed here; the next session is a clean baseLength one
  // anchored at the current daily total.
  const result = naturalEnd(opts.session, {
    dailyTotal: opts.dailyTotal,
    cooldownIncrement: opts.cooldownIncrementSeconds,
  });

  return {
    kind: 'limit-reached',
    result,
    endedSessionNum: opts.session.sessionNum,
  };
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
  nudgeInterval?: number;
}): NudgeOutcome | null {
  if (opts.sessionLimitSeconds <= 0) return null;

  const nudgeTime = nextNudgeToFire(opts.session, opts.dailyTotal, opts.nudgeInterval);
  if (nudgeTime === null) return null;

  return { nudgeTime, session: markNudgeFired(opts.session, nudgeTime) };
}
