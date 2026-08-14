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
 * Which gate decided, named. `running` and `audible` mean the clock runs; every
 * other value is the specific gate that stopped it.
 *
 * This exists because "the clock stopped" is not a diagnosis — the interesting
 * question during a stutter is always WHICH condition flipped, and a bare
 * boolean cannot answer it after the fact.
 */
export type ClockVerdict =
  | 'running'
  | 'audible'
  | 'unfocused'
  | 'untracked'
  | 'cooldown'
  | 'end-session-confirm'
  | 'average-popup'
  | 'locked'
  | 'os-idle'
  | 'tab-unengaged';

/**
 * The gates, in the order they must be applied.
 *
 * Audible playback is checked BEFORE the idle gate and short-circuits to true.
 * A locked machine still wins over audio — a video playing to a locked screen
 * is not time the user is spending.
 */
export function clockVerdict(g: GateInput): ClockVerdict {
  if (!g.browserIsFocused) return 'unfocused';
  if (!g.trackedDomain) return 'untracked';
  if (g.inCooldown) return 'cooldown';
  if (g.endSessionConfirmOpen) return 'end-session-confirm';
  if (g.averagePopupOpen) return 'average-popup';

  // Locked: nobody is watching anything, audible or not.
  if (g.osIdleState === 'locked') return 'locked';

  // Audio separates "watching" from "walked away". It has to outrank idleness,
  // because sitting still through a video is indistinguishable from absence by
  // input alone.
  if (g.activeTabAudible) return 'audible';

  if (g.osIdleState === 'idle') return 'os-idle';
  if (!g.tabIsEngaged) return 'tab-unengaged';

  return 'running';
}

/** Whether the clock should run. The verdict, collapsed to the decision. */
export function shouldClockRun(g: GateInput): boolean {
  const v = clockVerdict(g);
  return v === 'running' || v === 'audible';
}
