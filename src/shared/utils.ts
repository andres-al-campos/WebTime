import type { TimeHistory, Domain, DateString, SessionDayStat, SessionStartStats } from '../types.js';

/**
 * Extract domain from URL, removing www. prefix
 */
export function extractDomain(url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    let hostname = parsedUrl.hostname;

    if (hostname.startsWith('www.')) {
      hostname = hostname.substring(4);
    }

    return hostname;
  } catch (error) {
    console.error("Error parsing URL:", error);
    return null;
  }
}

/**
 * Format time in seconds to HH:MM format
 */
export function formatTime(totalTime: number): string {
  const hours = Math.floor(totalTime / 3600);
  const minutes = Math.floor((totalTime % 3600) / 60);

  const formattedHours = hours.toString().padStart(2, '0');
  const formattedMinutes = minutes.toString().padStart(2, '0');

  return `${formattedHours}:${formattedMinutes}`;
}

/**
 * Format a DURATION (seconds) as unit-labelled "4h 36m" / "25m" / "0m".
 * Used for popup display numbers (hero stats, session card) where the colon
 * "HH:MM" format is ambiguous against the on-screen timer's "MM:SS" clock.
 * No colons → no confusion with a ticking timer. Always shows minutes; rounds
 * down (these are elapsed/total figures, not a countdown to a deadline).
 */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/**
 * Like formatDuration but ALWAYS shows the hours part ("0h 3m"), so a column of
 * durations keeps a consistent "Xh Ym" shape even under an hour. Used by the
 * usage card where the two figures sit side by side.
 */
export function formatDurationHM(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  return `${hours}h ${minutes}m`;
}


/**
 * Format a DURATION (seconds) as a clock "M:SS" / "H:MM:SS". Used in the session
 * card, where the value is a live session/cooldown countdown and seconds matter —
 * unlike the hero stats (daily totals) which use the unit-labelled formatDuration.
 * Minutes are unpadded when there's no hours part ("4:05"), padded after hours
 * ("1:04:05"); seconds always padded.
 */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const ss = seconds.toString().padStart(2, '0');
  if (hours > 0) {
    const mm = minutes.toString().padStart(2, '0');
    return `${hours}:${mm}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

/**
 * Get current date as YYYY-MM-DD string in local timezone,
 * adjusted for custom day reset time
 */
export function getLocalDateStr(resetHour: number = 0): string {
  const now = new Date();

  if (now.getHours() < resetHour) {
    now.setDate(now.getDate() - 1);
  }

  const monthNum = now.getMonth() + 1;
  const yyyy = now.getFullYear();
  const mm = String(monthNum).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Parse a YYYY-MM-DD date string safely in local time (avoids UTC midnight timezone issues).
 */
function parseDateLocal(dateStr: DateString): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0); // noon local time
}

/**
 * Format date string for display (e.g., "2025-01-15" -> "Jan 15")
 */
export function formatDateForDisplay(dateString: string): string {
  const date = parseDateLocal(dateString);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getMonth()]} ${date.getDate()}`;
}

/**
 * Day-of-week abbreviation (e.g. "2025-01-15" -> "Wed") for a YYYY-MM-DD string.
 */
export function getDayOfWeek(dateString: string): string {
  const date = parseDateLocal(dateString);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days[date.getDay()];
}

/**
 * Format a date string with its weekday (e.g. "2025-01-15" -> "Jan 15 (Wed)").
 */
export function formatDateWithDayOfWeek(dateString: string): string {
  return `${formatDateForDisplay(dateString)} (${getDayOfWeek(dateString)})`;
}

/**
 * Debug logging: the full trace (tab switches, saves, ticks, session and
 * cooldown lifecycle).
 *
 * Set by build.mjs — on for a normal build, off when WEBTIME_DEBUG=0, which is
 * what release/ uses. esbuild substitutes the literal, so a release build drops
 * these calls entirely rather than shipping dead branches.
 */
declare const __WEBTIME_DEBUG__: boolean;

// typeof guard, not a bare read: tests bundle these modules without the define,
// where a bare __WEBTIME_DEBUG__ is a ReferenceError rather than undefined. This
// keeps log() safe to call from anything a test imports, and esbuild still
// folds the whole branch away once the literal is substituted.
const DEBUG_ENABLED =
  typeof __WEBTIME_DEBUG__ !== 'undefined' && __WEBTIME_DEBUG__;

export function log(...args: unknown[]): void {
  if (DEBUG_ENABLED) {
    console.log('[WebTime Debug]:', ...args);
  }
}

/**
 * Format time in seconds to a compact human-readable string (e.g. "1h 23m", "45m")
 */
export function formatTimeCompact(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

/**
 * Compute 7-day stats for a domain, excluding today.
 * Returns per-day breakdown, mean seconds over days with data, and count of days with data.
 * averageSeconds = 0 and daysWithData = 0 if no history exists.
 *
 * Uses local-time date arithmetic to avoid UTC midnight timezone issues.
 */
export function compute7DayStats(
  timeHistory: TimeHistory,
  domain: Domain,
  currentDateStr: DateString
): SessionStartStats {
  const days: SessionDayStat[] = [];
  const baseDate = parseDateLocal(currentDateStr);

  for (let i = 1; i <= 7; i++) {
    const date = new Date(baseDate);
    date.setDate(date.getDate() - i);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const dateStr: DateString = `${yyyy}-${mm}-${dd}`;

    const seconds = timeHistory[dateStr]?.[domain] ?? 0;
    days.unshift({ date: dateStr, seconds });
  }

  const daysWithDataArr = days.filter(d => d.seconds > 0);
  const daysWithData = daysWithDataArr.length;
  const averageSeconds = daysWithData > 0
    ? Math.round(daysWithDataArr.reduce((sum, d) => sum + d.seconds, 0) / daysWithData)
    : 0;

  return { days, averageSeconds, daysWithData };
}

