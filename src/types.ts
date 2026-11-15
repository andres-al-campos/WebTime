import { MSG } from './shared/protocol.js';
import type { Budget, BudgetRules } from './shared/session-budget.js';
// ============================================
// WebTime Type Definitions
// ============================================

// Browser API types (Firefox WebExtensions)
declare const browser: typeof chrome;

// ============================================
// Time Tracking Data Structures
// ============================================

/** Date string in YYYY-MM-DD format */
export type DateString = string;

/** Domain name (e.g., "youtube.com") */
export type Domain = string;

/** Time history: date -> domain -> seconds */
export type TimeHistory = Record<DateString, Record<Domain, number>>;

/** Stored time data format */
export interface TrackedTimeData {
  lastDate: DateString;
  timeHistory: TimeHistory;
  version: number;
  /** Epoch ms the clock was running from at save time, null if stopped. Lets a
   *  restarting worker recover the seconds the save interval didn't capture. */
  runningSince?: number | null;
  /** The domain that anchor belongs to, so the gap is never credited elsewhere. */
  runningDomain?: Domain | null;
}

// ============================================
// Settings
// ============================================

export interface GlobalSettings {
  dayResetTime?: number; // Hour when day resets (0-23)
  inactivityTimeoutS?: number; // Seconds before tab considered inactive (default: 30)
  scalingPower?: number; // Chart bar scaling power (default: 0.8, range 0.3-1.0)
  endSessionShortcut?: string | null; // Keyboard shortcut to end session early; null = disabled, undefined = default (Ctrl+E)
}

export interface DomainSettings {
  sessionLimitEnabled?: boolean;
  sessionLimit?: number; // Minutes — continuous usage before cooldown triggers
  cooldownIncrement?: number; // Unused since sessions regenerate; still on disk for existing users, never read
  sessionsPerDay?: number; // How many sessions regenerate per day (undefined = default)
  maxSessions?: number; // The most sessions the site can hold (undefined = default)
  nudgeInterval?: number; // Minutes between nudges (0 = disabled, undefined = default)
}

export interface WebTimeSettings {
  global: GlobalSettings;
  domains: Record<Domain, DomainSettings>;
}

// ============================================
// Intervention System
// ============================================

export interface InterventionState {
  averagePopupShown: Record<Domain, boolean>;  // reset on day rollover
}

export interface SessionDayStat {
  date: DateString;
  seconds: number;
}

export interface SessionStartStats {
  days: SessionDayStat[];
  averageSeconds: number;
  daysWithData: number; // how many of the last 7 days had any usage
}

export interface InterventionSettings {
  global: GlobalSettings;
  domainSettings: DomainSettings;
  averageSeconds: number; // 7-day moving average in seconds (0 if no history)
  daysWithData: number; // days with usage in last 7 days
  timeInSeconds: number;
  sessionLimitSeconds: number; // 0 = disabled
}

// ============================================
// Message Types (Background <-> Content Script)
// ============================================

export interface TimeUpdateMessage {
  type: typeof MSG.TIME_UPDATE;
  time: number;
  sessionTime?: number;       // seconds elapsed in current session (only when session limit is active)
  sessionLimitSeconds?: number; // the session limit in seconds (only when session limit is active)
  sessionNum?: number;         // which session number (1-based)
}

export interface ContentScriptReadyMessage {
  type: typeof MSG.CONTENT_SCRIPT_READY;
}

export interface UserActiveMessage {
  type: typeof MSG.USER_ACTIVE;
}

export interface SettingsUpdatedMessage {
  type: typeof MSG.SETTINGS_UPDATED;
}

export interface NudgeMessage {
  type: typeof MSG.NUDGE;
}

export interface ShowAveragePopupMessage {
  type: typeof MSG.SHOW_AVERAGE_POPUP;
  minutesLeft: number;
  averageMinutes: number;
  stats: SessionStartStats;
}

/**
 * Background → content: this site has rules on and no session running. The
 * page draws the gate (or the wait, when nothing can start yet) from the
 * budget itself, so the row regenerates on screen without a message a second.
 */
export interface ShowGateMessage {
  type: typeof MSG.SHOW_GATE;
  budget: Budget;
  rules: BudgetRules;
  /** The site's full session length. */
  sessionLengthSeconds: number;
  /** The smallest share of a session the gate will offer. */
  minFraction: number;
  /** Seconds between OK and the session starting. */
  countdownSeconds: number;
}

export interface HideGateMessage {
  type: typeof MSG.HIDE_GATE;
}

/** Content → background: the countdown after OK ran out. */
export interface StartSessionMessage {
  type: typeof MSG.START_SESSION;
}

export interface EndSessionEarlyMessage {
  type: typeof MSG.END_SESSION_EARLY;
}

/** Popup → background → active tab: open the end-session confirmation overlay
 *  (the same one the keyboard shortcut shows) instead of ending immediately, so
 *  an accidental click on the popup button is recoverable. */
export interface ShowEndSessionConfirmMessage {
  type: typeof MSG.SHOW_END_SESSION_CONFIRM;
}

export interface EndSessionConfirmOpenMessage {
  type: typeof MSG.END_SESSION_CONFIRM_OPEN;
}

export interface EndSessionConfirmCloseMessage {
  type: typeof MSG.END_SESSION_CONFIRM_CLOSE;
}

export interface AveragePopupOpenMessage {
  type: typeof MSG.AVERAGE_POPUP_OPEN;
}

export interface AveragePopupCloseMessage {
  type: typeof MSG.AVERAGE_POPUP_CLOSE;
}

export interface RequestGateStateMessage {
  type: typeof MSG.REQUEST_GATE_STATE;
}

export interface ShowWindDownMessage {
  type: typeof MSG.SHOW_WIND_DOWN;
}

export interface HideWindDownMessage {
  type: typeof MSG.HIDE_WIND_DOWN;
}

export type ExtensionMessage =
  | TimeUpdateMessage
  | ContentScriptReadyMessage
  | UserActiveMessage
  | SettingsUpdatedMessage
  | NudgeMessage
  | ShowAveragePopupMessage
  | ShowGateMessage
  | HideGateMessage
  | StartSessionMessage
  | EndSessionEarlyMessage
  | ShowEndSessionConfirmMessage
  | EndSessionConfirmOpenMessage
  | EndSessionConfirmCloseMessage
  | AveragePopupOpenMessage
  | AveragePopupCloseMessage
  | RequestGateStateMessage
  | ShowWindDownMessage
  | HideWindDownMessage;

// ============================================
// Chart Types
// ============================================

export interface DomainDataset {
  label: string;
  data: number[];
  backgroundColor: string;
  borderColor?: string;
  borderWidth?: number;
  borderRadius?: number;
}

export interface ChartDataset {
  labels: string[];
  datasets: DomainDataset[];
}

// ============================================
// Constants Types
// ============================================

export interface OverlayDurations {
  NUDGE_GROW_MS: number;
  NUDGE_SHRINK_MS: number;
}

export interface ConstantsType {
  INACTIVITY_THRESHOLD_MS: number;
  ACTIVITY_CHECK_INTERVAL_MS: number;
  SAVE_INTERVAL_SECONDS: number;
  OVERLAY_DURATIONS: OverlayDurations;
}

// Chart.js types (simplified for this project)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ChartInstance = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ChartConfiguration = any;
