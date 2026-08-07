// When the content script is allowed to stand behind the number it's showing.
//
// Extracted from content.ts so it can be tested: content.ts touches browser
// globals at module scope and can't be imported by the test harness.
//
// The rule exists because under MV3 the content script renders from its own
// local clock while the service worker is dead. That extrapolation is only
// valid while the assumptions behind it hold.

export interface TrustInput {
  /** Local timestamp of the last TIME_UPDATE, or 0 if none has arrived. */
  receivedAt: number;
  /** Whether the background said time is accruing for THIS tab. */
  clockRunning: boolean;
  /** Local timestamp of the user's last real input in this tab. */
  lastActivityTime: number;
  /** How long after the last input we stop trusting a running clock. */
  staleAfterMs: number;
  nowMs: number;
}

/**
 * Whether the displayed time can still be justified.
 *
 * Three cases:
 *  - Nothing received yet: we have no number at all.
 *  - Clock stopped: the value isn't advancing, so it stays correct forever.
 *  - Clock running: valid while the user is still interacting. Their input is
 *    the evidence — the background only runs the clock when they're engaged,
 *    so ongoing input means extrapolating forward is right. Once they stop we
 *    can't see why the background might have frozen the clock (tab blurred,
 *    OS idle, cooldown began), so we stop claiming to know.
 *
 * Deliberately NOT a function of silence from the background: under MV3 the
 * worker is killed after ~30s idle, so silence is the normal case.
 */
export function displayIsVerified(input: TrustInput): boolean {
  if (input.receivedAt === 0) return false;
  if (!input.clockRunning) return true;
  return input.nowMs - input.lastActivityTime < input.staleAfterMs;
}
