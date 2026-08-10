// Self-contained session model for the session-limit feature. Replaces the
// boundary/modulo math that used to live in session-math.ts.
//
// The idea: a session is a self-contained object anchored to the daily total
// AT WHICH IT STARTED (startDaily), not to a modulo-of-daily-total boundary.
// Everything else — remaining time, nudge times, wind-down, end-of-session —
// derives from this object. Live length changes become "mutate baseLength";
// carryover and grace are fields on the session, not parallel domain maps.
//
// Pure functions only. No browser APIs. Unit-testable with `node --test`.

const PHI = (1 + Math.sqrt(5)) / 2;
export const WIND_DOWN_DURATION = 60;

// ---------------------------------------------------------------------------
// The session object
// ---------------------------------------------------------------------------

export interface ActiveSession {
  /** 1-based session number for the day. Drives cooldown length. */
  sessionNum: number;
  /** dailyTotal (seconds) at the moment this session began. The anchor. */
  startDaily: number;
  /** Base limit in seconds, AS IT APPLIES TO THIS SESSION. Live-editable. */
  baseLength: number;
  /** Rolled-over seconds from an early end of the previous session. */
  carryover: number;
  /**
   * Grace seconds baked into this session AT BIRTH (earned from the previous
   * session's early end). Part of the duration from the start — there is no
   * mid-session "grace kicks in" moment. 0 means none was earned; reads clean.
   */
  graceSeconds: number;
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
  return s.baseLength + s.carryover + s.graceSeconds;
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
  /** Grace earned from the PREVIOUS session's early end. Baked in at birth. */
  graceSeconds?: number;
}): ActiveSession {
  return {
    sessionNum: opts.sessionNum ?? 1,
    startDaily: opts.dailyTotal,
    baseLength: opts.baseLength,
    carryover: opts.carryover ?? 0,
    graceSeconds: opts.graceSeconds ?? 0,
    firedNudges: [],
    // Fresh randomness every session — the single Math.random call in this module.
    nudgeSeed: Math.floor(Math.random() * 0x7fffffff),
  };
}

export interface CooldownResult {
  cooldownSeconds: number;
  /** The session the user enters AFTER the cooldown ends. */
  nextSession: ActiveSession;
  /** Grace earned for the next session (0 if none). */
  graceEarned: number;
}

/**
 * Cooldown grows with the session number: session N → N * increment seconds.
 * If no increment is configured (0), there is no cooldown. The old code fell
 * back to `baseLength` here — a vestigial "need some number" default that tied
 * cooldown length to session length for no real reason. Dropped.
 */
export function cooldownLength(sessionNum: number, increment: number): number {
  return increment > 0 ? sessionNum * increment : 0;
}

/**
 * Natural end: the user reached the end of the session's effective length.
 * Carryover is consumed; the next session is a clean baseLength session
 * anchored at the current daily.
 */
export function naturalEnd(s: ActiveSession, opts: {
  dailyTotal: number;
  cooldownIncrement: number;
}): CooldownResult {
  const cooldownSeconds = cooldownLength(s.sessionNum, opts.cooldownIncrement);
  return {
    cooldownSeconds,
    graceEarned: 0,
    nextSession: startSession({
      dailyTotal: opts.dailyTotal,
      baseLength: s.baseLength,
      sessionNum: s.sessionNum + 1,
    }),
  };
}

/**
 * End early: the user quit with `remaining` seconds left. Those seconds roll
 * into the next session as carryover, and 10% of them is earned as grace.
 * Returns null if there's nothing to claim (already at/over the end).
 */
export function endEarly(s: ActiveSession, opts: {
  dailyTotal: number;
  cooldownIncrement: number;
}): CooldownResult | null {
  const { remaining } = displayFor(s, opts.dailyTotal);
  const carryover = Math.max(0, remaining);
  if (carryover <= 0) return null;

  const cooldownSeconds = cooldownLength(s.sessionNum, opts.cooldownIncrement);
  // 10% of the given-up time is always earned, regardless of whether this
  // session was itself grace-extended — the bonus tracks time left, not the
  // session's pedigree.
  const graceEarned = computeGraceSeconds(carryover);

  return {
    cooldownSeconds,
    graceEarned,
    // Grace and carryover are baked into the next session HERE, at birth.
    // The next session simply *is* base+carryover+grace long from second 0 —
    // there is no later "grace kicks in" moment and thus no gap.
    nextSession: startSession({
      dailyTotal: opts.dailyTotal,
      baseLength: s.baseLength,
      sessionNum: s.sessionNum + 1,
      carryover,
      graceSeconds: graceEarned,
    }),
  };
}

/**
 * Live length change. THIS is the fix for the reported bug: anchoring to
 * startDaily (not a daily modulo) means elapsed time is preserved, so
 * shrinking the limit by N shrinks remaining by N — until it would go
 * negative, in which case the caller should treat the session as ended.
 *
 * Returns the updated session. If the change pushes the user at/past the end,
 * `expired` is true and the caller fires a cooldown via naturalEnd().
 */
export function changeLength(s: ActiveSession, opts: {
  dailyTotal: number;
  newBaseLength: number;
}): { session: ActiveSession; expired: boolean } {
  const updated: ActiveSession = { ...s, baseLength: opts.newBaseLength };
  const { remaining } = displayFor(updated, opts.dailyTotal);
  return { session: updated, expired: remaining <= 0 };
}

/** 10% of given-up time is earned as grace for the next session. */
export function computeGraceSeconds(remainingSeconds: number): number {
  return Math.floor(remainingSeconds * 0.1);
}

// ---------------------------------------------------------------------------
// Nudges — recomputed per tick from the live effectiveLength, with catch-up.
// No precomputed schedule to invalidate.
//
// Spacing: each nudge sits at `eff - eff/DECAY^i`, so the *remaining* time
// shrinks by a constant factor (DECAY) each nudge — sparse early, accelerating
// toward the end. DECAY=1.8 is between φ (gentle) and 2.0 (halving).
//
// Two guards keep the tail from getting annoying:
//   - NUDGE_MIN_GAP: no two nudges closer than this (self-caps the count; a
//     larger requested count just gets pruned down to what fits).
//   - the wind-down window: no nudge inside the final WIND_DOWN_DURATION.
//
// Jitter: each time is nudged by up to ±NUDGE_JITTER seconds so the schedule
// isn't perfectly predictable. The jitter is DETERMINISTIC given the session's
// nudgeSeed — stable within a session (so catch-up matching works), fresh
// across sessions (because the seed is regenerated at each startSession).
// ---------------------------------------------------------------------------

const NUDGE_DECAY = 1.8;
const NUDGE_MIN_GAP = 120; // seconds — anti-bunching floor
const NUDGE_JITTER = 30;   // seconds — ± window, mirrors the 60s wind-down

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
 * Nudge times (session-relative seconds) for the current effective length.
 * `seed` drives the per-session jitter; `overrideCount` (the user's nudgeCount
 * setting) caps how many we *attempt* before the min-gap floor prunes.
 */
export function computeNudgeTimes(effLimit: number, seed: number, overrideCount?: number): number[] {
  if (effLimit <= 0) return [];
  const attempt = overrideCount !== undefined
    ? overrideCount
    : Math.round(PHI * Math.sqrt(effLimit / 60 / 15));
  if (attempt <= 0) return [];

  const rnd = mulberry32(seed);
  const times: number[] = [];
  for (let i = 1; i <= attempt; i++) {
    const base = effLimit - effLimit / Math.pow(NUDGE_DECAY, i);
    const jitter = Math.round((rnd() * 2 - 1) * NUDGE_JITTER);
    const t = Math.round(base + jitter);
    if (t < 60 || t > effLimit - WIND_DOWN_DURATION) continue;
    // Greedy min-gap prune: drop a nudge that lands too close to the last kept.
    if (times.length && t - times[times.length - 1] < NUDGE_MIN_GAP) continue;
    times.push(t);
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
export function nextNudgeToFire(s: ActiveSession, dailyTotal: number, overrideCount?: number): number | null {
  const { sessionTime, sessionLimitSeconds } = displayFor(s, dailyTotal);
  const times = computeNudgeTimes(sessionLimitSeconds, s.nudgeSeed, overrideCount);
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
  inCooldown: boolean;
}): boolean {
  return opts.clockRunning && opts.hasSession && !opts.inCooldown;
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
  overrideCount?: number,
): ScheduledWake[] {
  const wakes: ScheduledWake[] = [];
  const fired = new Set(s.firedNudges);

  const push = (kind: ScheduledWake['kind'], t: number) => {
    const at = instantFor(s, dailyTotal, t, nowMs);
    if (at !== null) wakes.push({ kind, sessionTime: t, at });
  };

  for (const t of computeNudgeTimes(effectiveLength(s), s.nudgeSeed, overrideCount)) {
    if (!fired.has(t)) push('nudge', t);
  }
  push('windDown', windDownAtSessionTime(s));
  push('sessionEnd', endsAtSessionTime(s));

  return wakes.sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------------------
// Wind-down — also derived live.
// ---------------------------------------------------------------------------

export function windDownState(s: ActiveSession, dailyTotal: number): {
  active: boolean; progress: number; remaining: number;
} {
  const { sessionTime, sessionLimitSeconds } = displayFor(s, dailyTotal);
  const start = sessionLimitSeconds - WIND_DOWN_DURATION;
  if (sessionTime < start || sessionLimitSeconds < WIND_DOWN_DURATION) {
    return { active: false, progress: 0, remaining: sessionLimitSeconds - sessionTime };
  }
  const elapsed = sessionTime - start;
  return {
    active: true,
    progress: Math.min(1, elapsed / WIND_DOWN_DURATION),
    remaining: Math.max(0, sessionLimitSeconds - sessionTime),
  };
}
