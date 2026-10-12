import type { ConstantsType, OverlayDurations } from '../types.js';

const OVERLAY_DURATIONS: OverlayDurations = {
  // The blur and the media pause are the SAME interruption, so they share a
  // deadline: both end the moment the timer reaches full size. The shrink then
  // plays out on a clear, playing page — the blur hands off to the timer rather
  // than outlasting it, and the timer stays readable on the way back down.
  //
  // No hold at the peak. One was tried and the pause read as too aggressive:
  // the size does the work, so buying reading time by freezing the page longer
  // costs more flow than it returns.
  //
  // Because the pause ends at the peak, the GROW is the whole interruption and
  // the shrink is free — so the animation can be slow and calm (500/500) while
  // the page is only held for 500ms.
  NUDGE_GROW_MS: 500,
  NUDGE_SHRINK_MS: 500,
};


export const Constants: ConstantsType = {
  INACTIVITY_THRESHOLD_MS: 30000,
  ACTIVITY_CHECK_INTERVAL_MS: 1000,
  SAVE_INTERVAL_SECONDS: 60,
  OVERLAY_DURATIONS
};

export default Constants;
