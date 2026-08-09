// When the content script is allowed to stand behind the number it's showing.
//
// Extracted from content.ts so it can be tested: content.ts touches browser
// globals at module scope and can't be imported by the test harness.
//
// The content script smooths between updates by extrapolating from a local
// anchor. That's only honest while updates are actually arriving.

export interface TrustInput {
  /** Local timestamp of the last TIME_UPDATE, or 0 if none has arrived. */
  receivedAt: number;
  /** Whether the background said time is accruing for THIS tab. */
  clockRunning: boolean;
  /** How long after the last update we stop trusting a running clock. */
  staleAfterMs: number;
  nowMs: number;
}

/**
 * Whether the displayed time can still be justified.
 *
 * Three cases:
 *  - Nothing received yet: we have no number at all.
 *  - Clock stopped: the value isn't advancing, so it stays correct forever.
 *  - Clock running: valid while updates keep arriving. The background sends one
 *    per second, so continued silence means we can no longer tell whether time
 *    is still accruing — and a number that might be wrong is worse than none.
 *
 * Keyed on background silence, not on local input. Local input was a stand-in
 * for this signal during the window when the MV3 worker died every ~30s and
 * silence carried no information; the keep-alive document ended that, and the
 * stand-in had its own visible cost — it hid the timer on a schedule unrelated
 * to the inactivity setting the user had chosen.
 */
export function displayIsVerified(input: TrustInput): boolean {
  if (input.receivedAt === 0) return false;
  if (!input.clockRunning) return true;
  return input.nowMs - input.receivedAt < input.staleAfterMs;
}

/**
 * How much to add to the last received value while waiting for the next update.
 *
 * Smoothing, not timekeeping: it fills the gap between one-second updates so the
 * display doesn't visibly step. Capped at one interval because past that point
 * it is guessing, and guessing high is what made the timer look like it ran
 * backwards — the number climbed off a frozen anchor, then snapped down to the
 * truth when a real update arrived.
 *
 * Returns 0 when the clock is stopped: a frozen number is correct, and adding to
 * it would invent time the background is deliberately not counting.
 */
export function localElapsed(
  clockRunning: boolean,
  receivedAt: number,
  nowMs: number,
  capSeconds: number,
): number {
  if (!clockRunning || receivedAt === 0) return 0;
  const elapsed = (nowMs - receivedAt) / 1000;
  if (elapsed < 0) return 0;   // clock moved backwards (NTP, DST)
  return Math.min(elapsed, capSeconds);
}
