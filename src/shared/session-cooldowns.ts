// The cooldown after a session: how long a site stays behind the gate before the
// next session can start.
//
// Cooldowns are what keep a day's sessions from running back to back into one
// sitting. They grow with each session, so a binge gets slower the longer it
// goes, but by √n rather than n: at six sessions a day linear cooldowns add up to
// an hour and a quarter of waiting, √n to about forty minutes.
//
// An early end takes the cooldown in proportion to what was used. A full cooldown
// after stopping at five minutes would read as a penalty for stopping, and
// stopping early is what the app rewards.
//
// Pure functions only.

/** Minutes of the first cooldown when a site hasn't set one. */
export const DEFAULT_COOLDOWN_MIN = 5;

/**
 * Seconds of cooldown after session `sessionNum` (1-based) of the day.
 * `share` is how much of the session was used, 0–1; 1 for one that ran out.
 * 0 minutes means no cooldowns.
 */
export function cooldownSeconds(sessionNum: number, baseMinutes: number, share = 1): number {
  if (!(baseMinutes > 0) || !(sessionNum >= 1)) return 0;
  const used = Math.min(1, Math.max(0, share));
  return Math.round(baseMinutes * 60 * Math.sqrt(sessionNum) * used);
}

/** Seconds left of a cooldown that ends at `until` (epoch ms), 0 once over. */
export function cooldownLeft(until: number | undefined, now: number): number {
  return until && until > now ? Math.ceil((until - now) / 1000) : 0;
}
