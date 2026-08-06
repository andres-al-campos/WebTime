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
}

/** Storage format for trackedTime key */
export interface StorageData {
  trackedTime?: TrackedTimeData;
  webTimeSettings?: WebTimeSettings;
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
  cooldownIncrement?: number; // Minutes (may be fractional, e.g. 3.5 = 3m30s) — each successive cooldown grows by this amount
  nudgeCount?: number; // Number of phi-spaced nudges per session (0 = disabled, undefined = auto)
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
  cooldownIncrementSeconds: number;
}

// ============================================
// Message Types (Background <-> Content Script)
// ============================================

export interface TimeUpdateMessage {
  type: 'TIME_UPDATE';
  time: number;
  sessionTime?: number;       // seconds elapsed in current session (only when session limit is active)
  sessionLimitSeconds?: number; // the session limit in seconds (only when session limit is active)
  sessionNum?: number;         // which session number (1-based)
  cooldownIncrementSeconds?: number; // per-session cooldown step, for quoting the cooldown in the end-session confirm
}

export interface ContentScriptReadyMessage {
  type: 'CONTENT_SCRIPT_READY';
}

export interface UserActiveMessage {
  type: 'USER_ACTIVE';
}

export interface SettingsUpdatedMessage {
  type: 'SETTINGS_UPDATED';
}

export interface NudgeMessage {
  type: 'NUDGE';
}

export interface ShowAveragePopupMessage {
  type: 'SHOW_AVERAGE_POPUP';
  minutesLeft: number;
  averageMinutes: number;
  stats: SessionStartStats;
}

export interface ShowBlockerMessage {
  type: 'SHOW_BLOCKER';
  cooldownRemainingSeconds: number;
  totalCooldownSeconds: number;
  cooldownCount: number; // how many cooldowns triggered today
  cooldownIncrementSeconds: number; // the per-cooldown increment in seconds (may include a sub-minute part)
}

export interface HideBlockerMessage {
  type: 'HIDE_BLOCKER';
}

export interface EndSessionEarlyMessage {
  type: 'END_SESSION_EARLY';
}

/** Popup → background → active tab: open the end-session confirmation overlay
 *  (the same one the keyboard shortcut shows) instead of ending immediately, so
 *  an accidental click on the popup button is recoverable. */
export interface ShowEndSessionConfirmMessage {
  type: 'SHOW_END_SESSION_CONFIRM';
}

export interface EndSessionConfirmOpenMessage {
  type: 'END_SESSION_CONFIRM_OPEN';
}

export interface EndSessionConfirmCloseMessage {
  type: 'END_SESSION_CONFIRM_CLOSE';
}

export interface AveragePopupOpenMessage {
  type: 'AVERAGE_POPUP_OPEN';
}

export interface AveragePopupCloseMessage {
  type: 'AVERAGE_POPUP_CLOSE';
}

export interface RequestBlockerStateMessage {
  type: 'REQUEST_BLOCKER_STATE';
}

export interface ShowWindDownMessage {
  type: 'SHOW_WIND_DOWN';
  progress: number;
  remainingSeconds: number;
}

export interface HideWindDownMessage {
  type: 'HIDE_WIND_DOWN';
}

export type ExtensionMessage =
  | TimeUpdateMessage
  | ContentScriptReadyMessage
  | UserActiveMessage
  | SettingsUpdatedMessage
  | NudgeMessage
  | ShowAveragePopupMessage
  | ShowBlockerMessage
  | HideBlockerMessage
  | EndSessionEarlyMessage
  | ShowEndSessionConfirmMessage
  | EndSessionConfirmOpenMessage
  | EndSessionConfirmCloseMessage
  | AveragePopupOpenMessage
  | AveragePopupCloseMessage
  | RequestBlockerStateMessage
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

export interface ProcessedDayData {
  date: DateString;
  domains: Record<Domain, number>;
  total: number;
}

export interface DomainRanking {
  domain: Domain;
  totalSeconds: number;
  color: string;
}

// ============================================
// UI State
// ============================================

export type ViewMode = 'general' | 'detail';

export interface PopupState {
  currentView: ViewMode;
  selectedDomain: Domain | null;
  chartInstance: unknown | null; // Chart.js instance
}

// ============================================
// Constants Types
// ============================================

export interface OverlayDurations {
  NUDGE_MS: number;
}

export interface ChartConfig {
  movingAverageDays: number;
  daysToDisplay: number;
  initAnimationDuration: number;
  topDomainsLimit: number;
}

export interface MovingAverageColors {
  background: string;
  border: string;
  width: number;
}

export interface CurrentDomainColors {
  background: string;
  border: string;
}

export interface Colors {
  domains: string[];
  others: string;
  movingAverage: MovingAverageColors;
  currentDomain: CurrentDomainColors;
}

export interface ConstantsType {
  INACTIVITY_THRESHOLD_MS: number;
  ACTIVITY_CHECK_INTERVAL_MS: number;
  SAVE_INTERVAL_SECONDS: number;
  OVERLAY_DURATIONS: OverlayDurations;
  CHART_CONFIG: ChartConfig;
  COLORS: Colors;
}

// Chart.js types (simplified for this project)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ChartInstance = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ChartConfiguration = any;
