// Self-contained session model for the session-limit feature. Replaces the
// boundary/modulo math that used to live in session-math.ts.
//
// The idea: a session is a self-contained object anchored to the daily total
// AT WHICH IT STARTED (startDaily), not to a modulo-of-daily-total boundary.
// Everything else — remaining time, nudge times, wind-down, end-of-session —
// derives from this object. Live length changes become "mutate baseLength";
// carryover is a field on the session, not a parallel domain map.
//
// Pure functions only. No browser APIs. Unit-testable with `node --test`.

export const WIND_DOWN_DURATION = 60;

// ---------------------------------------------------------------------------
// The session object
// ---------------------------------------------------------------------------

export interface ActiveSession {
  /** 1-based session number for the day, shown as "End Session N?". */
  sessionNum: number;
  /** dailyTotal (seconds) at the moment this session began. The anchor. */
  startDaily: number;
  /** Base limit in seconds, AS IT APPLIES TO THIS SESSION. Live-editable. */
  baseLength: number;
  /**
   * Seconds on top of baseLength: time an early end carried over.
   */
  carryover: number;
  /**
   * Session-relative seconds (since startDaily) of nudges already fired.
   * The only "I already did this" bookkeeping the session needs.
   */
  firedNudges: number[];
  /**
   * Per-session random seed for nudge jitter. Generated fresh at birth, so each
   * session's nudge times are unpredictable across sessions but STABLE within
   * one (the same seed → the same times every tick, which the catch-up matcher
   * relies on). Pure functions never call Math.random — only startSession does.
   */
  nudgeSeed: number;
}

/** Total allowed length of this session. */
export function effectiveLength(s: ActiveSession): number {
  return s.baseLength + s.carryover;
}

export interface SessionDisplay {
  sessionTime: number;        // elapsed in this session
  sessionLimitSeconds: number; // effectiveLength
  remaining: number;
}

export function displayFor(s: ActiveSession, dailyTotal: number): SessionDisplay {
  const limit = effectiveLength(s);
  const sessionTime = Math.max(0, dailyTotal - s.startDaily);
  return {
    sessionTime,
    sessionLimitSeconds: limit,
    remaining: limit - sessionTime,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle / transitions — each returns a NEW session (no mutation)
// ---------------------------------------------------------------------------

/** Begin the first session of the day (or after a full reset). */
export function startSession(opts: {
  dailyTotal: number;
  baseLength: number;
  sessionNum?: number;
  carryover?: number;
}): ActiveSession {
  return {
    sessionNum: opts.sessionNum ?? 1,
    startDaily: opts.dailyTotal,
    baseLength: opts.baseLength,
    carryover: opts.carryover ?? 0,
    firedNudges: [],
    // Fresh randomness every session — the single Math.random call in this module.
    nudgeSeed: Math.floor(Math.random() * 0x7fffffff),
  };
}

/**
 * Where a domain stands. `off`: no session rules. `gate`: rules on and no
 * session running, so the page is behind the gate. `running`: a session.
 *
 * Named because the shell used to answer this in six places, each by testing
 * its own mix of "is there a session object" and "is a cooldown running".
 */
export type SessionPhase = 'off' | 'gate' | 'running';

export function sessionPhase(opts: { rulesOn: boolean; hasSession: boolean }): SessionPhase {
  if (!opts.rulesOn) return 'off';
  return opts.hasSession ? 'running' : 'gate';
}

/**
 * The cooldown that followed session N under the old escalating cooldowns:
 * N * increment seconds. Sessions no longer have one; past-day cards still
 * read it to describe records from before.
 */
export function cooldownLength(sessionNum: number, increment: number): number {
  return increment > 0 ? sessionNum * increment : 0;
}

/**
 * Live length change. THIS is the fix for the reported bug: anchoring to
 * startDaily (not a daily modulo) means elapsed time is preserved, so
 * shrinking the limit by N shrinks remaining by N — until it would go
 * negative, in which case the caller should treat the session as ended.
 *
 * Returns the updated session. If the change pushes the user at/past the end,
 * `expired` is true and the caller ends the session.
 */
export function changeLength(s: ActiveSession, opts: {
  dailyTotal: number;
  newBaseLength: number;
}): { session: ActiveSession; expired: boolean } {
  const updated: ActiveSession = { ...s, baseLength: opts.newBaseLength };
  const { remaining } = displayFor(updated, opts.dailyTotal);
  return { session: updated, expired: remaining <= 0 };
}

// ---------------------------------------------------------------------------
// Nudges — recomputed per tick from the live effectiveLength, with catch-up.
// No precomputed schedule to invalidate.
//
// Spacing: a fixed interval, per domain. Nudge at X, 2X, 3X... into the session.
//
// This replaced a φ-decay schedule (`eff - eff/DECAY^i`) that placed nudges as
// fractions of the session limit. That only made sense when session lengths
// were fixed. Once carryover and early-ending made the effective length vary
// per session, a fraction-based schedule meant the same wall-clock moment
// nudged or didn't depending on the ceiling above it — and, since the app pays
// you to leave early, it was quietest exactly when leaving was worth most.
//
// A fixed interval says the same thing at every session length, and the count
// falls out of how long you actually stay rather than what was provisioned.
// The interval is per-domain because that is where the real variance is: a
// reading site and an entertainment site want different numbers, and no single
// value serves both.
//
// Two guards are kept from the old scheme:
//   - the wind-down window: no nudge inside the final WIND_DOWN_DURATION.
//   - a floor on the interval, so a mis-set value can't produce a metronome.
//
// Jitter: each time is nudged by up to ±NUDGE_JITTER seconds so the schedule
// isn't perfectly predictable. The jitter is DETERMINISTIC given the session's
// nudgeSeed — stable within a session (so catch-up matching works), fresh
// across sessions (because the seed is regenerated at each startSession).
// ---------------------------------------------------------------------------

/** Minutes between nudges when a domain hasn't set one. */
export const DEFAULT_NUDGE_INTERVAL_MIN = 20;

const NUDGE_JITTER_MAX = 30;  // seconds — ± ceiling, mirrors the 60s wind-down

/** Tiny seeded PRNG (mulberry32). Deterministic stream from a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Nudge times (session-relative seconds) at a fixed interval.
 *
 * `intervalMinutes` is the domain's setting; undefined means the default.
 * 0 disables nudges for that domain. `seed` drives the per-session jitter.
 */
export function computeNudgeTimes(
  effLimit: number,
  seed: number,
  intervalMinutes?: number,
): number[] {
  if (effLimit <= 0) return [];
  const minutes = intervalMinutes ?? DEFAULT_NUDGE_INTERVAL_MIN;
  if (minutes <= 0) return [];
  // Guard the loop below, not just the caller: a zero or negative interval
  // never advances `t` and hangs whatever thread computes the schedule. The
  // `minutes <= 0` check above is the intended exit; this is so a future edit
  // to it degrades into "no nudges" rather than a frozen popup.
  const interval = Math.round(minutes * 60);
  if (interval <= 0) return [];
  // Jitter is a FRACTION of the interval, not a fixed window: at ±30s a
  // one-minute interval would swing between 30s and 90s, which does not read as
  // "every minute" at all. A quarter keeps the rhythm recognisable at any
  // setting, and the ceiling keeps long intervals from wandering.
  const jitterWindow = Math.min(NUDGE_JITTER_MAX, interval / 4);

  const rnd = mulberry32(seed);
  const times: number[] = [];
  // The last slot is the one before the wind-down takes over; a nudge inside
  // that window would be talking over it.
  const latest = effLimit - WIND_DOWN_DURATION;
  for (let t = interval; t <= latest; t += interval) {
    const jitter = Math.round((rnd() * 2 - 1) * jitterWindow);
    const at = Math.round(t + jitter);
    // Jitter can push the first one under a minute or the last past the
    // wind-down edge; drop those rather than clamping them onto each other.
    if (at < 60 || at > latest) continue;
    times.push(at);
  }
  return times;
}

/**
 * Catch-up nudge selection. Returns the single nudge that should fire on this
 * tick (the latest unfired nudge at or before sessionTime), or null.
 *
 * Robust to BOTH skipped ticks and live length changes: we recompute the
 * schedule from the live limit, then pick the most-overdue unfired one. A
 * nudge time that moved behind us after a shrink simply fires now (once);
 * a tick we missed doesn't drop the nudge.
 */
export function nextNudgeToFire(s: ActiveSession, dailyTotal: number, intervalMinutes?: number): number | null {
  const { sessionTime, sessionLimitSeconds } = displayFor(s, dailyTotal);
  const times = computeNudgeTimes(sessionLimitSeconds, s.nudgeSeed, intervalMinutes);
  const fired = new Set(s.firedNudges);

  let candidate: number | null = null;
  for (const t of times) {
    if (t <= sessionTime && !fired.has(t)) candidate = t; // keep latest eligible
  }
  return candidate;
}

export function markNudgeFired(s: ActiveSession, nudgeTime: number): ActiveSession {
  if (s.firedNudges.includes(nudgeTime)) return s;
  return { ...s, firedNudges: [...s.firedNudges, nudgeTime] };
}

// ---------------------------------------------------------------------------
// Scheduling — converting session-relative seconds into wall-clock instants.
//
// Under MV3 nothing can be assumed to run every second: the service worker is
// killed after ~30s idle, so the session must be able to end (and nudge, and
// wind down) with nothing of ours running in between. The way out is to turn
// each session-relative deadline into an absolute instant that a
// chrome.alarms one-shot and a content-script setTimeout can both be aimed at.
//
// The conversion holds only while the clock is RUNNING — the session's elapsed
// time advances with wall-clock time only when the user is actually on the
// tracked domain, focused and not idle. So every deadline must be recomputed
// whenever the clock stops or starts. `secondsUntil` is deliberately separate
// from `instantFor` to make that dependency explicit at the call site: the
// caller passes the `now` it is scheduling from.
// ---------------------------------------------------------------------------

/** Session-relative second at which the session ends. */
export function endsAtSessionTime(s: ActiveSession): number {
  return effectiveLength(s);
}

/** Session-relative second at which the wind-down bar should appear. */
export function windDownAtSessionTime(s: ActiveSession): number {
  return Math.max(0, effectiveLength(s) - WIND_DOWN_DURATION);
}

/**
 * Seconds of RUNNING CLOCK from now until a session-relative deadline.
 * Negative or zero means the deadline is already due.
 */
export function secondsUntil(
  s: ActiveSession,
  dailyTotal: number,
  targetSessionTime: number,
): number {
  const { sessionTime } = displayFor(s, dailyTotal);
  return targetSessionTime - sessionTime;
}

/**
 * Absolute epoch-ms instant for a session-relative deadline, assuming the
 * clock runs continuously from `nowMs`. Null when the deadline is already due
 * (the caller should act immediately rather than schedule).
 */
export function instantFor(
  s: ActiveSession,
  dailyTotal: number,
  targetSessionTime: number,
  nowMs: number,
): number | null {
  const secs = secondsUntil(s, dailyTotal, targetSessionTime);
  if (secs <= 0) return null;
  return nowMs + secs * 1000;
}

/**
 * Whether wakes should be armed at all right now.
 *
 * Separated from scheduleFor so the "should we schedule" decision is testable
 * without an alarms API. Each false case means the session is not advancing
 * toward any deadline, so an armed alarm could only wake the worker to
 * discover there is nothing to do.
 */
export function shouldScheduleWakes(opts: {
  clockRunning: boolean;
  hasSession: boolean;
}): boolean {
  return opts.clockRunning && opts.hasSession;
}

export interface ScheduledWake {
  /** What is due at this instant. */
  kind: 'nudge' | 'windDown' | 'sessionEnd';
  /** Session-relative second of the deadline. */
  sessionTime: number;
  /** Epoch ms, assuming the clock runs continuously from nowMs. */
  at: number;
}

/**
 * Every future deadline for this session as absolute instants, soonest first.
 *
 * Returns the whole list rather than just the next one so the caller can arm
 * one alarm per deadline. Arming only the next would mean a missed wake
 * silently drops everything after it; with all of them armed, an alarm that
 * fires late still fires, and the catch-up logic in nextNudgeToFire collapses
 * a backlog into a single nudge.
 *
 * Already-fired nudges are excluded, so this is safe to call on every
 * clock-start without re-firing history.
 */
export function scheduleFor(
  s: ActiveSession,
  dailyTotal: number,
  nowMs: number,
  intervalMinutes?: number,
): ScheduledWake[] {
  const wakes: ScheduledWake[] = [];
  const fired = new Set(s.firedNudges);

  const push = (kind: ScheduledWake['kind'], t: number) => {
    const at = instantFor(s, dailyTotal, t, nowMs);
    if (at !== null) wakes.push({ kind, sessionTime: t, at });
  };

  for (const t of computeNudgeTimes(effectiveLength(s), s.nudgeSeed, intervalMinutes)) {
    if (!fired.has(t)) push('nudge', t);
  }
  push('windDown', windDownAtSessionTime(s));
  push('sessionEnd', endsAtSessionTime(s));

  return wakes.sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------------------
// Wind-down — also derived live.
// ---------------------------------------------------------------------------

/**
 * Wind-down progress for the numbers the on-page timer shows, or null outside
 * the final minute. The page renders the bar from this, so the bar is the timer
 * drawn as a line: it pauses when the clock pauses and leaves when time is added.
 */
export function windDownProgress(sessionTime: number, sessionLimitSeconds: number): number | null {
  const remaining = sessionLimitSeconds - sessionTime;
  if (sessionLimitSeconds < WIND_DOWN_DURATION || remaining > WIND_DOWN_DURATION) return null;
  return Math.min(1, 1 - Math.max(0, remaining) / WIND_DOWN_DURATION);
}

export function windDownState(s: ActiveSession, dailyTotal: number): {
  active: boolean; progress: number; remaining: number;
} {
  const { sessionTime, sessionLimitSeconds } = displayFor(s, dailyTotal);
  const progress = windDownProgress(sessionTime, sessionLimitSeconds);
  return {
    active: progress !== null,
    progress: progress ?? 0,
    remaining: Math.max(0, sessionLimitSeconds - sessionTime),
  };
}
