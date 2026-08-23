import type { ConstantsType, OverlayDurations, ChartConfig, Colors } from '../types.js';

const OVERLAY_DURATIONS: OverlayDurations = {
  // The blur and the media pause are the SAME interruption, so they share a
  // deadline: both end the moment the timer reaches full size. The shrink then
  // plays out on a clear, playing page — the blur hands off to the timer rather
  // than outlasting it, and the timer stays readable on the way back down.
  //
  // No hold at the peak. One was tried and the pause read as too aggressive:
  // at 8x the size does the work, so buying reading time by freezing the page
  // longer costs more flow than it returns.
  NUDGE_GROW_MS: 350,
  NUDGE_SHRINK_MS: 350,
};

const CHART_CONFIG: ChartConfig = {
  movingAverageDays: 7,
  daysToDisplay: 30,
  initAnimationDuration: 600,
  topDomainsLimit: 7
};

const COLORS: Colors = {
  domains: [
    'rgba(69, 113, 231, 0.7)',
    'rgba(255, 99, 132, 0.7)',
    'rgba(255, 205, 86, 0.7)',
    'rgba(75, 192, 192, 0.7)',
    'rgba(153, 102, 255, 0.7)',
    'rgba(255, 159, 64, 0.7)',
    'rgba(199, 199, 199, 0.7)',
  ],
  others: 'rgba(150, 150, 150, 0.5)',
  movingAverage: {
    background: 'rgba(50, 100, 255, 0.7)',
    border: 'rgba(75, 150, 255, 0.7)',
    width: 2
  },
  currentDomain: {
    background: 'rgba(69, 113, 231, 0.7)',
    border: 'rgba(69, 113, 231)'
  }
};

export const Constants: ConstantsType = {
  INACTIVITY_THRESHOLD_MS: 30000,
  ACTIVITY_CHECK_INTERVAL_MS: 1000,
  SAVE_INTERVAL_SECONDS: 60,
  OVERLAY_DURATIONS,
  CHART_CONFIG,
  COLORS
};

export default Constants;
