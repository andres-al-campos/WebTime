// Timestamp accounting for the daily total.
//
// WHY THIS EXISTS
//
// The MV2 version counted time by doing `todaysTotalTimeInActiveDomain++`
// inside a 1-second setInterval. Under Chrome MV3 the background is a service
// worker that Chrome kills after ~30 seconds idle, and a pending setInterval
// neither keeps it alive nor survives it. Measured: 7 worker deaths in 10
// minutes of untouched video playback (tools/mv3-probe). Tick-counting there
// doesn't run slow, it stops — the daily total freezes and the session never
// ends.
//
// So elapsed time is derived from wall-clock timestamps instead:
//
//     total = banked + (running ? (now - runningSince) / 1000 : 0)
//
// `banked` is seconds already committed; `runningSince` is the instant the
// clock last started. Nothing has to run in between for the total to stay
// correct — a worker can die mid-session and the next wake reads the right
// number. The 1-second tick becomes purely a UI refresh, and losing it costs
// display smoothness rather than correctness.
//
// The clock runs only while the user is actually spending time on the tracked
// domain: browser focused, not idle, not in a cooldown or a modal freeze. Each
// of those transitions calls start()/stop() rather than skipping a tick.
//
// Pure and dependency-free (time comes in as an argument), so the accounting
// is unit-testable with no browser. See test/time-clock.test.mjs.

export interface ClockState {
  /** Seconds already committed to the daily total. */
  banked: number;
  /** Epoch ms when the clock started running, or null when stopped. */
  runningSince: number | null;
}

export function createClock(banked = 0): ClockState {
  return { banked, runningSince: null };
}

export function isRunning(c: ClockState): boolean {
  return c.runningSince !== null;
}

/**
 * Current total in seconds: banked plus any time accrued since the clock
 * started.
 *
 * Fractional by nature (it is a wall-clock difference), floored so callers see
 * the same whole-second semantics the tick counter had — the session model,
 * nudge times and the display are all integer seconds.
 */
export function totalSeconds(c: ClockState, nowMs: number): number {
  if (c.runningSince === null) return Math.floor(c.banked);
  const elapsed = (nowMs - c.runningSince) / 1000;
  // A backwards clock (NTP correction, DST, machine sleep) must never make the
  // total go down: time already spent was still spent. Clamp at zero.
  return Math.floor(c.banked + Math.max(0, elapsed));
}

/**
 * Start the clock. No-op when already running, so callers can call this from
 * several independent "user is active" signals without double-counting.
 */
export function start(c: ClockState, nowMs: number): ClockState {
  if (c.runningSince !== null) return c;
  return { banked: c.banked, runningSince: nowMs };
}

/**
 * Stop the clock, folding elapsed time into `banked`.
 *
 * This is the only place time becomes permanent, which is why every stop must
 * be persisted immediately rather than batched: the probe showed writes being
 * lost when the worker is torn down, so a stop that is only in memory is a
 * stop that can vanish.
 */
export function stop(c: ClockState, nowMs: number): ClockState {
  if (c.runningSince === null) return c;
  return { banked: totalSeconds(c, nowMs), runningSince: null };
}

/**
 * Set the clock to a known total, preserving whether it is running.
 *
 * For load-from-storage and domain switches, where the total comes from
 * outside rather than from elapsed time. Restarting a running clock from
 * `nowMs` discards the un-banked remainder on purpose: that time belonged to
 * the previous domain or the previous day.
 */
export function setTotal(c: ClockState, seconds: number, nowMs: number): ClockState {
  return { banked: seconds, runningSince: c.runningSince === null ? null : nowMs };
}

/**
 * Fold elapsed time into `banked` without stopping — a checkpoint.
 *
 * Used before persisting while the clock keeps running, so what gets written
 * is a plain number rather than a number plus a timestamp that has to be
 * re-interpreted correctly on the other side.
 */
export function bank(c: ClockState, nowMs: number): ClockState {
  if (c.runningSince === null) return c;
  return { banked: totalSeconds(c, nowMs), runningSince: nowMs };
}

/**
 * Reconstruct a clock from a persisted total plus the anchor it was running
 * from, recovering the time that accrued after the last write.
 *
 * This is what makes worker death non-lossy. Chrome kills the worker with no
 * teardown callback, so the seconds between the last save and the death are
 * never written. Restoring only the saved number silently discards them; every
 * idle-and-return cycle loses up to a full save interval, repeatedly.
 *
 * `anchor` is the epoch ms the clock was running from at save time (null if it
 * was stopped). Passing it back here credits `now - anchor` and keeps running.
 *
 * `maxGapMs` bounds what a gap is allowed to mean. Crediting an unbounded gap
 * would count a machine that was asleep for hours, or a clock moved backwards,
 * as time on the site. Beyond the bound we keep the saved total and drop the
 * remainder — undercounting is the honest failure here, since the user
 * demonstrably wasn't there.
 */
export function restore(
  savedSeconds: number,
  anchor: number | null,
  nowMs: number,
  maxGapMs: number
): ClockState {
  if (anchor === null) return { banked: savedSeconds, runningSince: null };
  const gap = nowMs - anchor;
  if (gap < 0 || gap > maxGapMs) {
    // Implausible gap: keep the total, resume from now rather than crediting it.
    return { banked: savedSeconds, runningSince: nowMs };
  }
  return { banked: savedSeconds + gap / 1000, runningSince: nowMs };
}
