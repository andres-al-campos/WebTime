// Whether time should be accruing right now.
//
// Extracted from background.ts so the ordering can be tested. The ordering is
// the whole point: these gates are not independent, and getting them in the
// wrong sequence has caused the same class of bug three times — most recently
// the OS idle gate sitting ahead of the audible check, which stopped the clock
// ~30s into every video because watching one looks exactly like an idle machine.

export interface GateInput {
  /** The browser is the foreground OS application. */
  browserIsFocused: boolean;
  /** A trackable domain is active; null means nothing to count against. */
  trackedDomain: string | null;
  /** The active domain is in a cooldown period. */
  inCooldown: boolean;
  /** The end-session confirmation dialog is open. */
  endSessionConfirmOpen: boolean;
  /** The weekly-average popup is open. */
  averagePopupOpen: boolean;
  /** OS-level idle state from chrome.idle. */
  osIdleState: 'active' | 'idle' | 'locked';
  /** The active tab is playing audio. */
  activeTabAudible: boolean;
  /** Recent user input in the active tab (see engagement rules in background). */
  tabIsEngaged: boolean;
}

/**
 * The gates, in the order they must be applied.
 *
 * Audible playback is checked BEFORE the idle gate and short-circuits to true.
 * A locked machine still wins over audio — a video playing to a locked screen
 * is not time the user is spending.
 */
export function shouldClockRun(g: GateInput): boolean {
  if (!g.browserIsFocused) return false;
  if (!g.trackedDomain) return false;
  if (g.inCooldown) return false;
  if (g.endSessionConfirmOpen) return false;
  if (g.averagePopupOpen) return false;

  // Locked: nobody is watching anything, audible or not.
  if (g.osIdleState === 'locked') return false;

  // Audio separates "watching" from "walked away". It has to outrank idleness,
  // because sitting still through a video is indistinguishable from absence by
  // input alone.
  if (g.activeTabAudible) return true;

  if (g.osIdleState === 'idle') return false;
  if (!g.tabIsEngaged) return false;

  return true;
}
