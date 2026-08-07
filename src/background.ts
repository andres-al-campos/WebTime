import { Constants } from './shared/constants.js';
import { extractDomain, getLocalDateStr, log, compute7DayStats } from './shared/utils.js';
import {
  type ActiveSession,
  startSession,
  displayFor,
  naturalEnd,
  endEarly as computeEndEarly,
  changeLength,
  nextNudgeToFire,
  markNudgeFired,
  windDownState,
  scheduleFor,
  shouldScheduleWakes,
} from './shared/session-model.js';
import {
  type ClockState,
  createClock,
  isRunning,
  totalSeconds,
  start,
  stop,
  setTotal,
  bank,
} from './shared/time-clock.js';
import type {
  TimeHistory,
  Domain,
  DateString,
  InterventionState,
  InterventionSettings,
  WebTimeSettings,
  ExtensionMessage,
  SessionStartStats
} from './types.js';

declare const browser: typeof chrome;

// State variables
//
// The daily total is held as a timestamp-based clock rather than a counter
// that gets incremented once a second. Under MV3 nothing is guaranteed to run
// every second — the service worker dies after ~30s idle — so elapsed time is
// derived from wall-clock timestamps and the tick is only a display refresh.
// See src/shared/time-clock.ts for the reasoning and the measurements.
//
// The daily total is now read through dailyTotal() rather than a variable, so
// every read reflects the current instant; transitions are explicit, via
// clockStart() / clockStop() / setDailyTotal().
let dailyClock: ClockState = createClock(0);

/** Seconds spent on the tracked domain today, as of right now. */
function dailyTotal(): number {
  return totalSeconds(dailyClock, Date.now());
}

/**
 * Start the daily clock if the user is genuinely spending time right now.
 * Idempotent, so every "user is active" signal can call it freely.
 */
function clockStart(): void {
  if (!shouldClockRun()) return;
  if (isRunning(dailyClock)) return;
  dailyClock = start(dailyClock, Date.now());
  log('Clock started.');
  onClockTransition();
}

/**
 * Stop the daily clock, banking elapsed time. Persists immediately: the probe
 * showed storage writes being lost when the worker is torn down, so a stop
 * that lives only in memory can vanish.
 */
function clockStop(): void {
  if (!isRunning(dailyClock)) return;
  dailyClock = stop(dailyClock, Date.now());
  log(`Clock stopped at ${dailyClock.banked}s.`);
  saveTimeData();
  onClockTransition();
}

/** Set the daily total from outside (load, domain switch, day rollover). */
function setDailyTotal(seconds: number): void {
  dailyClock = setTotal(dailyClock, seconds, Date.now());
}

/**
 * Re-derive whatever depends on "when will the clock reach X".
 *
 * Session deadlines are stored as session-relative seconds but scheduled as
 * absolute instants, and that conversion is only valid while the clock runs.
 * So every start/stop invalidates the schedule and it must be rebuilt.
 */
function onClockTransition(): void {
  void rescheduleWakes();
}

let activeTabId: number | null = null;
const trackedTabIds = new Set<number>();
let timerInterval: ReturnType<typeof setInterval> | null = null;

const SAVE_INTERVAL_SECONDS = Constants.SAVE_INTERVAL_SECONDS;
const tabLastActivity: Record<number, number> = {};
let trackedTabDomain: Domain | null = null;
// Whether the browser is the foreground OS app. When you alt-tab to another
// application (editor, Slack, …) all browser windows lose focus and we stop
// counting — even audible tabs — since you're not actually using the page.
// Defaults true so a fresh service-worker wake counts until told otherwise.
let browserIsFocused = true;
let inactivityThresholdMs = Constants.INACTIVITY_THRESHOLD_MS;
const ACTIVITY_CHECK_INTERVAL_MS = Constants.ACTIVITY_CHECK_INTERVAL_MS;

let currentDateStr: DateString = getLocalDateStr();
let timeHistory: TimeHistory = {};
let dayResetTime = 0;
let isSaving = false;

let interventionState: InterventionState = {
  averagePopupShown: {}
};

// Session limit state.
//
// `sessions[domain]` is the single source of truth for the *current* session of
// that domain: its start anchor (daily seconds when it began), base length,
// carryover, grace, and which nudges have fired. All session math (remaining,
// nudges, wind-down) derives from it via the pure helpers in session-model.ts.
// A domain has no entry until its first session is started (lazily, on the
// first tick / settings change while it's the tracked domain).
const sessions: Record<Domain, ActiveSession> = {};

// Sessions whose rules were toggled OFF mid-session. We KEEP the object here
// (out of `sessions`, so the tick/cooldown logic ignores it) instead of deleting
// it, so flipping rules back ON resumes the SAME session rather than starting a
// fresh Session 1. The clock is NOT frozen while suspended — elapsed time still
// accrues against startDaily — so toggling off can't be used to dodge the limit;
// it only suspends *enforcement*, not the count.
const suspendedSessions: Record<Domain, ActiveSession> = {};

// Inter-session / UI state — deliberately NOT on the session object, since it
// describes the gap *between* sessions or transient overlay state:
//   cooldownEndTime[domain]   = ms epoch when the active cooldown ends (absent = not in cooldown).
//   cooldownTotalSec[domain]  = the FULL length (s) of the active cooldown, captured when it fired.
//                               The blocker progress bar is remaining/total; recomputing the total
//                               elsewhere (sessionNum × increment) is fragile — if the increment
//                               setting reads as 0 the bar collapses to 100%. So store it once.
//   cooldownTickers[domain]   = the 1s setInterval that drives the blocker countdown UI.
//   windDownActive[domain]    = whether the wind-down overlay is currently shown.
// nudgeCount rides along because rescheduleWakes() is synchronous with respect
// to clock transitions and must not await a settings read to arm alarms.
const cachedDomainSessionLimit: Record<Domain, { sessionLimitSeconds: number; cooldownIncrementSeconds?: number; nudgeCount?: number }> = {};
const cooldownEndTime: Record<Domain, number> = {};
const cooldownTotalSec: Record<Domain, number> = {};
const cooldownTickers: Record<Domain, ReturnType<typeof setInterval>> = {};
const windDownActive: Record<Domain, boolean> = {};

// Cache previous intervention settings per domain to detect actual changes
const previousInterventionSettings: Record<Domain, string> = {};

// True while the end-session-early confirmation popup is open on any tab.
// Freezes the timer (no daily increment) so the user has time to decide.
let endSessionConfirmOpen = false;

// True while the 7-day-average popup is open. Like the confirmation popup, it
// blurs the page and pauses media, so the clock should freeze too — otherwise
// time keeps accruing against a page the user can't actually use.
let averagePopupOpen = false;

// Whether the active tab currently counts as engaged: recent user input, or
// audible playback. Maintained by handleTimerState (the only place that can
// see the tab object) and read by shouldClockRun, so the engagement test and
// the freeze gates are one predicate rather than two that can disagree.
let activeTabIsEngaged = false;

// --- Scheduled wakes -------------------------------------------------------
//
// Under MV3 nothing of ours is guaranteed to be running when a session ends:
// the worker dies after ~30s idle, and video playback does not keep it alive
// (measured — 7 deaths in 10 untouched minutes, tools/mv3-probe). A blocker
// that fires whenever the worker next happens to wake is not a timer.
//
// So each deadline gets a chrome.alarms one-shot at its absolute instant.
// Alarms wake a dead worker and fire on time regardless of its state — the
// probe measured ~1s from a cold start, and that second is the cold start
// itself, not alarm imprecision. `alarms.create({when})` has no 30s floor;
// that limit applies only to periodInMinutes.
//
// Two properties keep this honest:
//
//   - Alarms are a WAKE mechanism, never a source of truth. Every handler
//     re-derives from the clock via checkForInterventions(), so an alarm that
//     fires early, late, or spuriously cannot cause a wrong action — at worst
//     it costs a wake. This is why the alarm handler has no session logic of
//     its own.
//   - The schedule is rebuilt on every clock transition, because a paused
//     clock means every future instant has moved. Pausing therefore CANCELS
//     the alarms rather than leaving them to fire against a frozen clock.

const WAKE_ALARM_PREFIX = 'webtime-wake-';

/** Drop every scheduled wake. Called before rebuilding, and when paused. */
async function clearWakes(): Promise<void> {
  const all = await browser.alarms.getAll();
  await Promise.all(
    all
      .filter(a => a.name.startsWith(WAKE_ALARM_PREFIX))
      .map(a => browser.alarms.clear(a.name))
  );
}

/**
 * Rebuild the alarm set for the tracked domain's current session.
 *
 * Arms one alarm per future deadline rather than only the next one: if a wake
 * is missed, everything after it still fires on its own schedule. Nudge
 * catch-up (nextNudgeToFire returns the LATEST overdue nudge) collapses a
 * backlog into a single nudge, so redundant alarms cannot produce a burst.
 */
async function rescheduleWakes(): Promise<void> {
  await clearWakes();

  if (!trackedTabDomain) return;
  const domain = trackedTabDomain;
  const session = sessions[domain];

  // A stopped clock means no deadline has a knowable instant — time is not
  // advancing toward any of them. Leaving alarms armed would fire them against
  // a frozen clock, where checkForInterventions correctly does nothing; better
  // not to wake the worker at all. Same for a cooldown: the session is paused.
  const ok = shouldScheduleWakes({
    clockRunning: isRunning(dailyClock),
    hasSession: Boolean(session),
    inCooldown: (cooldownEndTime[domain] || 0) > Date.now(),
  });
  if (!ok || !session) return;

  const nudgeCount = cachedDomainSessionLimit[domain]?.nudgeCount;
  const wakes = scheduleFor(session, dailyTotal(), Date.now(), nudgeCount);

  for (const w of wakes) {
    browser.alarms.create(`${WAKE_ALARM_PREFIX}${w.kind}-${w.sessionTime}`, { when: w.at });
  }
  log(`Scheduled ${wakes.length} wake(s) for ${domain}.`);
}

/**
 * Every wake runs the same derivation the 1-second tick used to run. The alarm
 * only guarantees that SOMETHING is running at this instant; what to do is
 * decided entirely from current state.
 */
function handleAlarm(alarm: chrome.alarms.Alarm): void {
  if (!alarm.name.startsWith(WAKE_ALARM_PREFIX)) return;
  log(`Wake: ${alarm.name}`);
  void checkForInterventions();
}

/**
 * Get the current session for a domain, lazily starting one anchored at the
 * current daily total if none exists yet. Runs on the first tick after a domain
 * switch / extension load / settings change. `baseLength` is the live limit in
 * seconds; callers only invoke this when baseLength > 0.
 */
function getOrStartSession(domain: Domain, anchorDaily: number, baseLength: number): ActiveSession {
  let s = sessions[domain];
  if (!s) {
    s = startSession({ dailyTotal: anchorDaily, baseLength });
    sessions[domain] = s;
    saveSessionState(); // persist the freshly-started session (incl. its sessionNum)
  }
  return s;
}

/**
 * Drop the wind-down overlay for a domain. Forgetting the flag and telling the
 * page to hide must happen together — clearing the flag alone leaves the bar
 * painted, since the content script holds whatever it last drew until told
 * otherwise. Route every "wind-down is over" path through here so the two can't
 * drift (the stale-bar-after-rollover bug was exactly that drift).
 */
function clearWindDown(domain: Domain): void {
  if (!windDownActive[domain]) return;
  delete windDownActive[domain];
  sendMessageToAllTabsOfDomain(domain, { type: 'HIDE_WIND_DOWN' });
}

function clearAllCooldowns(): void {
  for (const domain of Object.keys(cooldownTickers)) {
    clearInterval(cooldownTickers[domain]);
    delete cooldownTickers[domain];
  }
  for (const domain of Object.keys(cooldownEndTime)) {
    // Drop the blocker on any page still showing the cooldown screen. As with
    // wind-down, deleting the state only makes the background forget — the
    // content script keeps the blur painted until told to hide. Without this, a
    // page left mid-cooldown keeps the blocker after the day rolls over.
    sendHideBlockerToAllTabsOfDomain(domain);
    delete cooldownEndTime[domain];
    delete cooldownTotalSec[domain];
  }
  syncClock(); // cooldown gates lifted for every domain
}

// --- Session-state persistence -------------------------------------------
//
// In MV3 the background is a service worker that is killed on idle (and
// definitely on browser close), wiping all in-memory state. Without this,
// closing the browser (or just walking away during a cooldown) loses the
// session number, carryover, grace, and any in-progress cooldown — so the
// next visit starts at "session 1" again mid-day. We persist the current
// day's session objects + active cooldowns to storage.local and rehydrate on
// startup. Only the current day is stored (keyed by date); it's a few KB at
// most and is discarded automatically when the date no longer matches.
const SESSION_STATE_KEY = 'webTimeSessionState';

function saveSessionState(): void {
  // Only persist domains that actually have a session or a live cooldown.
  const activeCooldowns: Record<Domain, number> = {};
  const activeCooldownTotals: Record<Domain, number> = {};
  for (const domain of Object.keys(cooldownEndTime)) {
    if ((cooldownEndTime[domain] || 0) > Date.now()) {
      activeCooldowns[domain] = cooldownEndTime[domain];
      // Persist the full length too, so the bar's denominator survives a
      // worker restart instead of collapsing to "remaining at rehydrate".
      activeCooldownTotals[domain] = cooldownTotalSec[domain] || 0;
    }
  }
  browser.storage.local.set({
    [SESSION_STATE_KEY]: {
      date: currentDateStr,
      sessions,
      cooldownEndTime: activeCooldowns,
      cooldownTotalSec: activeCooldownTotals,
    },
  }).catch(err => console.warn('Failed to persist session state:', err));

  // Every scheduled wake is derived from the session, so any change that is
  // worth persisting is also a change that can have moved a deadline: a live
  // length change, a nudge firing, a cooldown starting or ending, a new
  // session. Rebuilding here rather than at each of those call sites means a
  // future one cannot forget to reschedule — the alarms follow the state by
  // construction. Rebuilds are cheap and idempotent.
  void rescheduleWakes();
}

async function loadSessionState(): Promise<void> {
  try {
    const data = await browser.storage.local.get(SESSION_STATE_KEY);
    const stored = data[SESSION_STATE_KEY];
    if (!stored || stored.date !== currentDateStr) return; // absent or stale (new day)

    if (stored.sessions) {
      for (const [domain, session] of Object.entries(stored.sessions)) {
        sessions[domain] = session as ActiveSession;
      }
    }

    // Re-arm any cooldown still in the future; drop expired ones.
    const settingsData = await browser.storage.local.get('webTimeSettings');
    const settings: WebTimeSettings = settingsData.webTimeSettings || { global: {}, domains: {} };
    for (const [domain, endTime] of Object.entries(stored.cooldownEndTime || {})) {
      if ((endTime as number) <= Date.now()) continue; // expired during downtime
      cooldownEndTime[domain] = endTime as number;
      // Reconstruct the blocker-UI args. The session stored for this domain is
      // the NEXT session (created when the cooldown fired), so the session that
      // is cooling down is sessionNum - 1.
      const nextSession = sessions[domain];
      const endedSessionNum = nextSession ? Math.max(1, nextSession.sessionNum - 1) : 1;
      const incrementSec = (settings.domains?.[domain]?.cooldownIncrement || 0) * 60;
      const remainingSec = Math.ceil(((endTime as number) - Date.now()) / 1000);
      // Restore the bar's denominator: prefer the persisted full length, then
      // reconstruct from the formula, then fall back to remaining (last resort,
      // bar starts full but at least drains correctly).
      const storedTotal = (stored.cooldownTotalSec || {})[domain] as number | undefined;
      const totalCooldownSec = storedTotal && storedTotal > 0
        ? storedTotal
        : (incrementSec > 0 ? endedSessionNum * incrementSec : remainingSec);
      cooldownTotalSec[domain] = totalCooldownSec;
      startCooldownTicker(domain, totalCooldownSec, endedSessionNum, incrementSec);
      log(`Rehydrated active cooldown for ${domain}: ${remainingSec}s left of ${totalCooldownSec}s total`);
    }
    log(`Session state rehydrated for ${currentDateStr} (${Object.keys(sessions).length} domains)`);
  } catch (err) {
    console.warn('Failed to load session state:', err);
  }
}

function clearSessionState(): void {
  browser.storage.local.remove(SESSION_STATE_KEY).catch(() => {});
}


function getLocalDateStrWithReset(): DateString {
  return getLocalDateStr(dayResetTime);
}

function initDefaultTimeData(): void {
  setDailyTotal(0);
  timeHistory = {};
  log("Initialized with default values");
}

async function saveTimeData(): Promise<void> {
  if (isSaving) {
    log('Save already in progress, skipping...');
    return;
  }

  isSaving = true;
  // Checkpoint the clock so what we persist and what we hold in memory are the
  // same number. dailyTotal() would be correct either way — it is derived, not
  // additive — but banking here keeps a later stop() from re-deriving across an
  // interval that has already been written.
  dailyClock = bank(dailyClock, Date.now());
  log(`saveTimeData() ${currentDateStr}: ${dailyTotal()} seconds`);

  try {
    if (!timeHistory[currentDateStr]) {
      timeHistory[currentDateStr] = {};
    }

    if (trackedTabDomain) {
      timeHistory[currentDateStr][trackedTabDomain] = dailyTotal();
    }

    const storageData = {
      lastDate: currentDateStr,
      timeHistory: timeHistory,
      version: 1,
    };

    await browser.storage.local.set({
      trackedTime: storageData,
    });
    log("Time data successfully saved with history.");
  } catch (error) {
    console.error("Error saving time data to storage:", error);
  } finally {
    isSaving = false;
  }
}

async function loadTimeData(): Promise<void> {
  try {
    const storedData = await browser.storage.local.get("trackedTime");
    const trackedTime = storedData.trackedTime;

    if (!trackedTime || !trackedTime.lastDate || !trackedTime.timeHistory) {
      initDefaultTimeData();
      return;
    }

    timeHistory = trackedTime.timeHistory;

    if (currentDateStr !== trackedTime.lastDate) {
      log(
        `New day detected (Last: ${trackedTime.lastDate}, Now: ${currentDateStr})`
      );
      setDailyTotal(0);
    } else {
      const todaysData = timeHistory[currentDateStr] || {};
      setDailyTotal(trackedTabDomain ? (todaysData[trackedTabDomain] || 0) : 0);
    }

    log(
      `Loaded data for ${currentDateStr}, time: ${dailyTotal()}`
    );
  } catch (error) {
    console.error("Error loading time data:", error);
    initDefaultTimeData();
  }
}

/**
 * If the day has rolled over, reset the daily total and all session state.
 * Returns true if a rollover happened.
 *
 * MUST run before the freeze gates below: a cooldown (or an open popup) that
 * spans midnight would otherwise return early every tick and the day would
 * never reset — leaving the timer stuck on yesterday's total and session state
 * anchored to a stale daily. That was the "frozen after midnight, sessions look
 * disabled" bug.
 */
function rolloverIfNewDay(): boolean {
  const newDateStr = getLocalDateStrWithReset();
  if (newDateStr === currentDateStr) return false;

  saveTimeData();
  currentDateStr = newDateStr;
  setDailyTotal(0);
  interventionState = {
    averagePopupShown: {}
  };
  // Reset session limit state on day rollover. The session object collapses
  // what used to be seven parallel maps into one delete.
  clearAllCooldowns();
  for (const domain of Object.keys(sessions)) delete sessions[domain];
  for (const domain of Object.keys(windDownActive)) clearWindDown(domain);
  clearSessionState(); // drop persisted state for the old day
  log("New day, reset timer.");
  return true;
}

/**
 * Whether time should be accruing right now.
 *
 * These were the freeze gates inside the old 1-second tick, where each one
 * meant "skip this increment". With timestamp accounting they mean "the clock
 * must not be running", so they are evaluated at transitions instead — but the
 * conditions themselves are unchanged.
 */
function shouldClockRun(): boolean {
  // Foreground gate: if the browser isn't the current OS app, don't count —
  // the user is in another application, not spending time on the page.
  if (!browserIsFocused) return false;

  // There has to be a trackable domain to count against.
  if (!trackedTabDomain) return false;

  // Cooldown gate: if the current domain is in an active cooldown, freeze the
  // timer entirely. No daily increment, no interventions, nothing. The
  // cooldown ticker (startCooldownTicker) handles the blocker UI countdown.
  if ((cooldownEndTime[trackedTabDomain] || 0) > Date.now()) return false;

  // End-session confirmation popup is open — freeze daily count so the
  // displayed remaining/elapsed time stays put while the user decides.
  if (endSessionConfirmOpen) return false;

  // Average popup is open — same deal: the page is blurred and media paused,
  // so don't count time the user can't spend.
  if (averagePopupOpen) return false;

  // Activity gate: an idle user on an open tab isn't spending time on it. This
  // used to live only in handleTimerState (deciding whether the interval ran),
  // but the clock is what counts now, so the test has to be part of this
  // predicate — otherwise a display tick would restart a clock that was
  // deliberately stopped for inactivity.
  if (!activeTabIsEngaged) return false;

  return true;
}

/**
 * Re-evaluate the gates and start or stop the clock to match.
 *
 * Every input to shouldClockRun() calls this when it changes, which is what
 * replaces the per-tick gate checks. Both directions are idempotent, so
 * calling it more often than strictly necessary is harmless.
 */
function syncClock(): void {
  if (shouldClockRun()) clockStart();
  else clockStop();
}

/**
 * Display refresh. Under MV3 this is no longer what makes time count — the
 * clock advances on its own — so a missed tick costs smoothness, not accuracy.
 */
function incrementTimer(): void {
  // Roll the day FIRST — before any freeze gate — so midnight always resets even
  // mid-cooldown. On a rollover we reset and bail; the next tick counts normally
  // against the fresh day.
  if (rolloverIfNewDay()) {
    updateTimerDisplay(dailyTotal());
    return;
  }

  syncClock();
  if (!isRunning(dailyClock)) return;

  const total = dailyTotal();
  updateTimerDisplay(total);

  if (total % SAVE_INTERVAL_SECONDS === 0) {
    saveTimeData();
  }

  checkForInterventions();
}

function startTimer(): void {
  // Resume counting even if the interval is already up: the clock and the
  // display refresh are separate concerns now, and only the clock is load-bearing.
  syncClock();

  if (timerInterval) return;

  timerInterval = setInterval(incrementTimer, 1000);
  log("Timer started.");
}

function stopTimer(): void {
  // Stop the clock first, unconditionally. clockStop() banks and persists, so
  // this also covers the case where the interval was already gone (a worker
  // that was killed and revived) but the clock was still nominally running.
  clockStop();

  if (!timerInterval) return;

  clearInterval(timerInterval);
  timerInterval = null;
  saveTimeData();
}

function updateTimerDisplay(updatedTime: number): void {
  // Include session time info if a session limit is configured for this domain
  const message: { type: string; time: number; sessionTime?: number; sessionLimitSeconds?: number; sessionNum?: number; cooldownIncrementSeconds?: number } = {
    type: "TIME_UPDATE",
    time: updatedTime
  };

  if (trackedTabDomain) {
    const data = cachedDomainSessionLimit[trackedTabDomain];
    const baseLimitSec = data?.sessionLimitSeconds || 0;
    if (baseLimitSec > 0) {
      const session = getOrStartSession(trackedTabDomain, updatedTime, baseLimitSec);
      const display = displayFor(session, updatedTime);
      message.sessionTime = display.sessionTime;
      message.sessionLimitSeconds = display.sessionLimitSeconds;
      message.sessionNum = session.sessionNum;
      message.cooldownIncrementSeconds = data?.cooldownIncrementSeconds || 0;
      log(
        `[timer] domain=${trackedTabDomain} daily=${updatedTime}s ` +
        `start=${session.startDaily}s base=${session.baseLength}s ` +
        `carryover=${session.carryover}s grace=${session.graceSeconds}s ` +
        `effLimit=${display.sessionLimitSeconds}s sessionTime=${display.sessionTime}s ` +
        `→ remaining=${display.remaining}s`
      );
    }
  }

  trackedTabIds.forEach((tabId) => {
    browser.tabs.sendMessage(tabId, message).catch(() => {
      console.warn(`Failed to send TIME_UPDATE to tab ${tabId}. Removing from tracking.`);
      trackedTabIds.delete(tabId);
      delete tabLastActivity[tabId];
    });
  });
}

async function updateTimingState(tabId: number): Promise<void> {
  try {
    const activeTab = await browser.tabs.get(tabId);
    if (!activeTab || !activeTab.url) {
      log(`Tab ${tabId} was closed or has no URL`);
      stopTimer();
      return;
    }

    handleDomainSwitch(activeTab.url);
    handleTimerState(activeTab, tabId);

  } catch (error) {
    console.error(`Error in updateTimingState for tab ${tabId}:`, error);
    stopTimer();
  }
}

function handleDomainSwitch(url: string): void {
  const domain = extractDomain(url);
  if (domain === trackedTabDomain) { return; }

  // Stop the clock BEFORE saving, so the time accrued since the last
  // transition is banked against the domain that actually earned it. With
  // timestamp accounting the un-banked remainder lives in the clock, not in a
  // counter, so saving without stopping would drop it.
  clockStop();

  if (trackedTabDomain) {
    saveTimeData();
  }

  trackedTabDomain = domain;

  if (!trackedTabDomain) {
    log(`Switched to non-trackable URL: ${url}`);
    setDailyTotal(0);
    updateTimerDisplay(0);
    return;
  }

  const todayData = timeHistory[currentDateStr] || {};
  setDailyTotal(todayData[trackedTabDomain] || 0);
  // The new domain may have a cooldown or other gate of its own, so re-evaluate
  // rather than assuming the clock should resume.
  syncClock();
  // NOTE: We deliberately do NOT clear the session for this domain here. An
  // earlier version reset session state on every domain switch to handle
  // settings changes made for an inactive domain — but that wiped legitimate
  // mid-cooldown carryover/grace state when the user briefly switched away and
  // back. Settings changes are handled in the SETTINGS_UPDATED handler, which
  // touches only the changed domain. So domain switches safely preserve the
  // session object across tabs of the same domain.
  log(`Switched to domain: ${trackedTabDomain}, time: ${dailyTotal()}`);
  updateTimerDisplay(dailyTotal());
}

function handleTimerState(activeTab: chrome.tabs.Tab, tabId: number): void {
  const isWebUrl = activeTab.url?.startsWith('http://') || activeTab.url?.startsWith('https://');
  if (!isWebUrl) {
    activeTabIsEngaged = false;
    stopTimer();
    return;
  }

  const lastActivity = tabLastActivity[tabId] || 0;
  const isUserActive = (Date.now() - lastActivity) < inactivityThresholdMs;

  activeTabIsEngaged = Boolean(activeTab.audible) || isUserActive;

  if (activeTabIsEngaged) {
    startTimer();
  } else {
    stopTimer();
  }
}

// Fires when browser-window OS focus changes. windowId === WINDOW_ID_NONE means
// every browser window lost focus (user switched to another app). We flip the
// foreground flag; incrementTimer's gate stops/resumes counting on the next
// tick. We also re-run the active tab's timer-state so startTimer/stopTimer
// stays consistent for the non-audible path.
function handleWindowFocusChanged(windowId: number): void {
  browserIsFocused = windowId !== browser.windows.WINDOW_ID_NONE;
  log(`Browser focus changed: ${browserIsFocused ? 'foreground' : 'background'}`);
  // Act on the gate now rather than waiting for the next tick: under MV3 the
  // tick may never come, and losing focus is exactly when the worker goes idle.
  syncClock();
  if (activeTabId !== null) updateTimingState(activeTabId);
}

function handleTabActivated(activeInfo: chrome.tabs.TabActiveInfo): void {
  log(`handleTabActivated called for tab ${activeInfo.tabId}`);
  activeTabId = activeInfo.tabId;
  updateTimingState(activeTabId);
}

function handleTabUpdated(
  tabId: number,
  changeInfo: chrome.tabs.TabChangeInfo,
  _tab: chrome.tabs.Tab
): void {
  if (changeInfo.url !== undefined) {
    const domain = extractDomain(changeInfo.url);
    if (domain) {
      trackedTabIds.add(tabId);
      log(`Added tab ${tabId} to tracked tabs`);
    } else {
      trackedTabIds.delete(tabId);
      delete tabLastActivity[tabId];
      log(`Removed tab ${tabId} from tracked tabs`);
    }
  }
  // When audio stops, treat it as a fresh activity event so the inactivity
  // timeout starts from now rather than cutting off immediately.
  if (changeInfo.audible === false) {
    tabLastActivity[tabId] = Date.now();
  }

  const hasRelevantChanges = changeInfo.url !== undefined || changeInfo.audible !== undefined;
  if (tabId === activeTabId && hasRelevantChanges) {
    updateTimingState(tabId);
  }
}

function handleTabRemoved(tabId: number, _removeInfo: chrome.tabs.TabRemoveInfo): void {
  if (tabId === activeTabId) {
    stopTimer();
    activeTabId = null;
  }
  trackedTabIds.delete(tabId);
  delete tabLastActivity[tabId];
}

function handleMessageReceived(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
  _sendResponse: (response?: unknown) => void
): void {
  log(`handleMessage()`, message, sender);

  if (message.type === "CONTENT_SCRIPT_READY" && sender.tab?.id) {
    trackedTabIds.add(sender.tab.id);
    updateTimerDisplay(dailyTotal());

    // If the domain is currently in cooldown, immediately show the blocker on
    // this new tab with the SAME text every other tab shows (correct session
    // number + breakdown), reconstructed from existing state.
    if (sender.tab.url) {
      const domain = extractDomain(sender.tab.url);
      if (domain && (cooldownEndTime[domain] || 0) > Date.now()) {
        void sendBlockerToLateJoiningTab(sender.tab.id, domain);
      }
    }
  }

  if (message.type === "USER_ACTIVE" && sender.tab?.id) {
    tabLastActivity[sender.tab.id] = Date.now();
    // Resume immediately rather than waiting for the activity poll. This
    // message is also the main thing that wakes the worker under MV3, so
    // handling it here is what makes "the user came back" take effect at all
    // when nothing of ours has been running.
    if (sender.tab.id === activeTabId) syncClock();
  }

  if (message.type === "END_SESSION_EARLY") {
    void endSessionEarly();
  }

  if (message.type === "SHOW_END_SESSION_CONFIRM") {
    // Popup asks us to open the confirmation overlay on the active tab (instead
    // of ending immediately). The popup closes itself; the user confirms there.
    if (activeTabId !== null) {
      browser.tabs.sendMessage(activeTabId, { type: "SHOW_END_SESSION_CONFIRM" })
        .catch(() => { /* tab may have closed or have no content script */ });
    }
  }

  if (message.type === "END_SESSION_CONFIRM_OPEN") {
    endSessionConfirmOpen = true;
    syncClock();
  }

  if (message.type === "END_SESSION_CONFIRM_CLOSE") {
    endSessionConfirmOpen = false;
    syncClock();
  }

  if (message.type === "AVERAGE_POPUP_OPEN") {
    averagePopupOpen = true;
    syncClock();
  }

  if (message.type === "AVERAGE_POPUP_CLOSE") {
    averagePopupOpen = false;
    syncClock();
  }

  // A tab is asking for the current blocker state — typically on visibilitychange
  // after waking from a discarded/hidden state. Respond with SHOW or HIDE so the
  // tab's UI matches reality (it may have missed the original HIDE_BLOCKER while
  // suspended).
  if (message.type === "REQUEST_BLOCKER_STATE" && sender.tab?.id && sender.tab?.url) {
    const tabId = sender.tab.id;
    const domain = extractDomain(sender.tab.url);
    if (domain) {
      // sendBlockerToLateJoiningTab handles both cases: SHOW with correct
      // reconstructed text if in cooldown, HIDE otherwise.
      void sendBlockerToLateJoiningTab(tabId, domain);
    }
  }


  if (message.type === "SETTINGS_UPDATED") {
    browser.storage.local.get('webTimeSettings').then(data => {
      const settings: WebTimeSettings = data.webTimeSettings || { global: {}, domains: {} };

      inactivityThresholdMs = (settings.global?.inactivityTimeoutS ?? 30) * 1000;
      log(`Inactivity threshold: ${inactivityThresholdMs}ms`);

      const newResetTime = settings.global?.dayResetTime || 0;
      if (newResetTime !== dayResetTime) {
        dayResetTime = newResetTime;
        log(`Day reset time updated to: ${dayResetTime}:00`);
        const newDateStr = getLocalDateStrWithReset();
        if (newDateStr !== currentDateStr) {
          saveTimeData();
          currentDateStr = newDateStr;
          const todayData = timeHistory[currentDateStr] || {};
          setDailyTotal(trackedTabDomain ? (todayData[trackedTabDomain] || 0) : 0);
          updateTimerDisplay(dailyTotal());
          log(`Date changed to ${currentDateStr} due to reset time change`);
        }
      }

      // For every domain that we have prior fingerprints for OR for the
      // currently tracked domain, detect actual changes. Only reset session
      // state for domains whose intervention settings *actually* changed.
      const allDomainsToCheck = new Set<Domain>([
        ...Object.keys(previousInterventionSettings),
        ...(trackedTabDomain ? [trackedTabDomain] : []),
      ]);

      for (const domain of allDomainsToCheck) {
        const domainCfg = settings.domains?.[domain];
        const fingerprint = JSON.stringify({
          sessionLimitEnabled: domainCfg?.sessionLimitEnabled,
          sessionLimit: domainCfg?.sessionLimit,
          cooldownIncrement: domainCfg?.cooldownIncrement
        });
        const prev = previousInterventionSettings[domain];
        const slEnabled = domainCfg?.sessionLimitEnabled || false;
        const settingsActuallyChanged = prev !== undefined && prev !== fingerprint;
        // First time we've seen this domain's fingerprint: normally we just
        // record it and wait. But if rules are ALREADY on for the tracked tab
        // and no session is running, act now — otherwise the first toggle-on of
        // a fresh domain does nothing until a refresh re-runs init.
        const firstSeenNeedsStart = prev === undefined && slEnabled
          && domain === trackedTabDomain && !sessions[domain];
        previousInterventionSettings[domain] = fingerprint;

        if (!settingsActuallyChanged && !firstSeenNeedsStart) continue;
        const newLimitSeconds = slEnabled ? (domainCfg?.sessionLimit || 0) * 60 : 0;
        const cooldownIncrementSeconds = slEnabled ? (domainCfg?.cooldownIncrement || 0) * 60 : 0;
        cachedDomainSessionLimit[domain] = { sessionLimitSeconds: newLimitSeconds, cooldownIncrementSeconds };

        if (newLimitSeconds <= 0) {
          // Rules turned OFF. Don't delete the session — SUSPEND it (stash the
          // object) so re-enabling resumes the same one instead of restarting at
          // Session 1. Enforcement stops; the clock keeps running (no exploit).
          if (sessions[domain]) {
            suspendedSessions[domain] = sessions[domain];
            delete sessions[domain];
          }
          clearWindDown(domain);
          saveSessionState();
          if (domain === trackedTabDomain) updateTimerDisplay(dailyTotal());
          continue;
        }

        if (domain !== trackedTabDomain) {
          // Inactive domain: don't mutate a live session it isn't running. Its
          // session (if any) re-derives lazily next time it becomes tracked.
          continue;
        }

        let existing = sessions[domain];
        if (!existing && suspendedSessions[domain]) {
          // Rules toggled back ON — resume the suspended session (same number,
          // carryover, grace, anchor). It may have run past its end while off,
          // which the changeLength/expired path below handles like any overrun.
          existing = suspendedSessions[domain];
          sessions[domain] = existing;
          delete suspendedSessions[domain];
        }
        if (!existing) {
          // No session ever existed — start one NOW (not "next tick"), so the
          // timer appears immediately on the tracked tab instead of after a
          // refresh. Anchored at the current daily total.
          existing = getOrStartSession(domain, dailyTotal(), newLimitSeconds);
          updateTimerDisplay(dailyTotal());
        }

        // Live length change. Anchored to startDaily, so elapsed time is
        // preserved: shrinking the limit by N shrinks remaining by N.
        const { session: updated, expired } = changeLength(existing, {
          dailyTotal: dailyTotal(),
          newBaseLength: newLimitSeconds,
        });
        sessions[domain] = updated;

        if (expired) {
          // The new (shorter) limit puts the user at/past the end → end now.
          // Treat it as a natural end of the (now-expired) session.
          const result = naturalEnd(updated, {
            dailyTotal: dailyTotal(),
            cooldownIncrement: cooldownIncrementSeconds,
          });
          fireCooldown(domain, result.nextSession, result.cooldownSeconds, cooldownIncrementSeconds, updated.sessionNum);
          log(
            `Session limit shrunk past elapsed for ${domain}: session ended immediately ` +
            `(daily=${dailyTotal()}s, newLimit=${newLimitSeconds}s)`
          );
        } else {
          saveSessionState(); // persist the live-resized session
          const display = displayFor(updated, dailyTotal());
          updateTimerDisplay(dailyTotal());
          log(
            `Session limit changed for ${domain}: ` +
            `effLimit=${display.sessionLimitSeconds}s remaining=${display.remaining}s ` +
            `(daily=${dailyTotal()}s, base=${newLimitSeconds}s, ` +
            `carryover=${updated.carryover}s, grace=${updated.graceSeconds}s)`
          );
        }
      }
    });
  }
}

async function checkForInterventions(): Promise<void> {
  if (!trackedTabDomain || !activeTabId) return;

  const settings = await loadInterventionSettings();
  if (!settings) return;

  checkWindDown(settings);
  if (checkSessionLimit(settings)) return;

  checkPhiNudges(settings);
  checkAveragePopup(settings);
}

async function loadInterventionSettings(): Promise<InterventionSettings | null> {
  if (!trackedTabDomain) return null;

  const data = await browser.storage.local.get('webTimeSettings');
  const settings: WebTimeSettings = data.webTimeSettings || { global: {}, domains: {} };
  const global = settings.global || {};
  const domainSettings = settings.domains?.[trackedTabDomain] || {};

  const sessionLimitEnabled = domainSettings.sessionLimitEnabled || false;
  const hasSessionLimit = sessionLimitEnabled && (domainSettings.sessionLimit || 0) > 0;

  // Cache session limit for timer display (even when returning null). The
  // cooldown increment rides along so the end-session confirm can quote the
  // cooldown it would trigger without an async settings load per tick.
  cachedDomainSessionLimit[trackedTabDomain] = {
    sessionLimitSeconds: hasSessionLimit ? (domainSettings.sessionLimit || 0) * 60 : 0,
    cooldownIncrementSeconds: hasSessionLimit ? (domainSettings.cooldownIncrement || 0) * 60 : 0,
    nudgeCount: domainSettings.nudgeCount
  };

  const { averageSeconds, daysWithData } = compute7DayStats(timeHistory, trackedTabDomain, currentDateStr);

  return {
    global,
    domainSettings,
    averageSeconds,
    daysWithData,
    timeInSeconds: dailyTotal(),
    sessionLimitSeconds: hasSessionLimit ? (domainSettings.sessionLimit || 0) * 60 : 0,
    cooldownIncrementSeconds: hasSessionLimit ? (domainSettings.cooldownIncrement || 0) * 60 : 0
  };
}

function checkPhiNudges(settings: InterventionSettings): void {
  const { sessionLimitSeconds } = settings;
  if (sessionLimitSeconds <= 0 || !trackedTabDomain) return;

  const domain = trackedTabDomain;
  const session = getOrStartSession(domain, dailyTotal(), sessionLimitSeconds);

  // Catch-up selection: the latest unfired nudge at/before now. Robust to both
  // skipped ticks and live length changes — a nudge that moved behind us after a
  // shrink just fires once here.
  const nudgeTime = nextNudgeToFire(session, dailyTotal(), settings.domainSettings.nudgeCount);
  if (nudgeTime !== null) {
    sendNudge();
    sessions[domain] = markNudgeFired(session, nudgeTime);
    saveSessionState(); // persist firedNudges so a restart doesn't re-fire
    const remaining = displayFor(sessions[domain], dailyTotal()).remaining;
    log(`φ-nudge at ${Math.round(nudgeTime / 60)}min into session (${remaining}s remaining)`);
  }
}

// Require a full week of history before the average is meaningful: all 7 days
// in the compute7DayStats window (the 7 days BEFORE today) must have usage on
// this domain. A partial week makes the "average" jumpy and the popup noisy.
const AVERAGE_POPUP_MIN_DAYS = 7;

function persistAveragePopupShown(): void {
  browser.storage.local.set({
    webTimeAveragePopupShown: {
      date: currentDateStr,
      domains: interventionState.averagePopupShown
    }
  });
}

async function loadAveragePopupShown(): Promise<void> {
  const data = await browser.storage.local.get('webTimeAveragePopupShown');
  const stored = data.webTimeAveragePopupShown;
  if (stored && stored.date === currentDateStr && stored.domains) {
    interventionState.averagePopupShown = stored.domains;
  }
}

function checkAveragePopup(settings: InterventionSettings): void {
  const { averageSeconds, daysWithData, timeInSeconds, sessionLimitSeconds } = settings;

  if (!trackedTabDomain) return;
  if (sessionLimitSeconds <= 0) return;
  if (averageSeconds === 0) return;
  if (daysWithData < AVERAGE_POPUP_MIN_DAYS) return;
  if (interventionState.averagePopupShown[trackedTabDomain]) return;

  const averagePopupThreshold = Math.round(averageSeconds * 0.8);
  if (timeInSeconds < averagePopupThreshold) return;

  interventionState.averagePopupShown[trackedTabDomain] = true;
  persistAveragePopupShown();

  const minutesLeft = Math.round((averageSeconds - timeInSeconds) / 60);
  const averageMinutes = Math.round(averageSeconds / 60);
  const stats = compute7DayStats(timeHistory, trackedTabDomain, currentDateStr);
  sendAveragePopup(Math.max(0, minutesLeft), averageMinutes, stats);
  log(`Average popup shown at ${Math.round(timeInSeconds / 60)}min (80% of avg: ${Math.round(averageSeconds / 60)}min)`);
}

function sendMessageToAllTabsOfDomain(domain: Domain, message: Record<string, unknown>): void {
  trackedTabIds.forEach(tabId => {
    browser.tabs.get(tabId).then(tab => {
      if (tab.url && extractDomain(tab.url) === domain) {
        browser.tabs.sendMessage(tabId, message).catch(() => {});
      }
    }).catch(() => {});
  });
}

function checkWindDown(settings: InterventionSettings): void {
  const { sessionLimitSeconds } = settings;
  if (sessionLimitSeconds <= 0 || !trackedTabDomain) return;

  const domain = trackedTabDomain;
  if ((cooldownEndTime[domain] || 0) > Date.now()) return;

  const session = getOrStartSession(domain, dailyTotal(), sessionLimitSeconds);
  const wd = windDownState(session, dailyTotal());

  if (wd.active && !windDownActive[domain]) {
    windDownActive[domain] = true;
    log(`Wind-down started for ${domain} (${wd.remaining}s remaining)`);
  }

  if (wd.active) {
    sendMessageToAllTabsOfDomain(domain, {
      type: 'SHOW_WIND_DOWN',
      progress: wd.progress,
      remainingSeconds: wd.remaining
    });
  } else {
    clearWindDown(domain);
  }
}


/**
 * Send a full-fidelity SHOW_BLOCKER to a single tab that joined mid-cooldown
 * (newly focused / restored). The blocker args aren't passed in — they're
 * reconstructed from existing state so the late-joiner shows the SAME text as
 * every other tab ("Session N ended" + breakdown) instead of placeholders:
 *   - ended session number = next session's sessionNum - 1 (cooldown stored the
 *     next session), same derivation the rehydrate path uses.
 *   - cooldown increment    = the domain's settings value (not on the session).
 *   - remaining / total      = derived from cooldownEndTime.
 * No-ops if the domain isn't actually in cooldown.
 */
async function sendBlockerToLateJoiningTab(tabId: number, domain: Domain): Promise<void> {
  const endTime = cooldownEndTime[domain] || 0;
  if (endTime <= Date.now()) {
    browser.tabs.sendMessage(tabId, { type: 'HIDE_BLOCKER' as const }).catch(() => {});
    return;
  }
  const remaining = Math.ceil((endTime - Date.now()) / 1000);
  const nextSession = sessions[domain];
  const endedSessionNum = nextSession ? Math.max(1, nextSession.sessionNum - 1) : 1;
  const settingsData = await browser.storage.local.get('webTimeSettings');
  const settings: WebTimeSettings = settingsData.webTimeSettings || { global: {}, domains: {} };
  const incrementSec = (settings.domains?.[domain]?.cooldownIncrement || 0) * 60;
  // The bar's denominator is the cooldown's FULL length, captured when it fired.
  // Use the stored value — recomputing it from the increment setting is exactly
  // what made the bar start at 100% when that setting read as 0 on a fresh tab.
  const totalSeconds = cooldownTotalSec[domain]
    || (incrementSec > 0 ? endedSessionNum * incrementSec : remaining);
  browser.tabs.sendMessage(tabId, {
    type: 'SHOW_BLOCKER' as const,
    cooldownRemainingSeconds: remaining,
    totalCooldownSeconds: totalSeconds,
    cooldownCount: endedSessionNum,
    cooldownIncrementSeconds: incrementSec
  }).catch(() => {});
}

function sendBlockerToAllTabsOfDomain(domain: Domain, remainingSeconds: number, totalSeconds: number, cooldownCount: number, cooldownIncrementSeconds: number): void {
  const message = {
    type: 'SHOW_BLOCKER' as const,
    cooldownRemainingSeconds: remainingSeconds,
    totalCooldownSeconds: totalSeconds,
    cooldownCount,
    cooldownIncrementSeconds
  };

  trackedTabIds.forEach(tabId => {
    browser.tabs.get(tabId).then(tab => {
      if (tab.url && extractDomain(tab.url) === domain) {
        browser.tabs.sendMessage(tabId, message).catch(() => {});
      }
    }).catch(() => {});
  });
}

function sendHideBlockerToAllTabsOfDomain(domain: Domain): void {
  const message = { type: 'HIDE_BLOCKER' as const };

  trackedTabIds.forEach(tabId => {
    browser.tabs.get(tabId).then(tab => {
      if (tab.url && extractDomain(tab.url) === domain) {
        browser.tabs.sendMessage(tabId, message).catch(() => {});
      }
    }).catch(() => {});
  });
}

function startCooldownTicker(domain: Domain, totalCooldownSeconds: number, sessionNum: number, cooldownIncrementSeconds: number): void {
  if (cooldownTickers[domain]) {
    clearInterval(cooldownTickers[domain]);
  }

  cooldownTickers[domain] = setInterval(() => {
    const endTime = cooldownEndTime[domain] || 0;
    const remaining = Math.ceil((endTime - Date.now()) / 1000);

    if (remaining <= 0) {
      clearInterval(cooldownTickers[domain]);
      delete cooldownTickers[domain];
      delete cooldownEndTime[domain];
      delete cooldownTotalSec[domain];
      saveSessionState(); // cooldown cleared — persist so a restart doesn't re-arm it
      syncClock(); // the cooldown gate just lifted — resume counting if applicable
      // The next session was already created when the cooldown was fired and
      // anchored at the daily total of that moment — nothing to start here.
      sendHideBlockerToAllTabsOfDomain(domain);
      clearWindDown(domain);
      // Push a fresh timer update so all tabs of this domain immediately show
      // the new session's full extended length (sessionTime=0, limit=base+carry).
      if (trackedTabDomain === domain) {
        updateTimerDisplay(dailyTotal());
      }
      log(`Cooldown expired for ${domain}`);
    } else {
      // Always send the stored full length as the denominator (single source of
      // truth) so every tab agrees with the late-join path; fall back to the
      // value the ticker was started with.
      const total = cooldownTotalSec[domain] || totalCooldownSeconds;
      sendBlockerToAllTabsOfDomain(domain, remaining, total, sessionNum, cooldownIncrementSeconds);
    }
  }, 1000);
}

/**
 * Begin a cooldown for `domain`: store the next session, start the blocker UI
 * countdown, and notify all tabs. `nextSession` is the session the user enters
 * once the cooldown expires (already anchored at the current daily total).
 * `endedSessionNum` is the number of the session that just ended — it drives the
 * blocker's displayed count. Shared by natural end, early end, and shrink-past.
 */
function fireCooldown(
  domain: Domain,
  nextSession: ActiveSession,
  cooldownSeconds: number,
  cooldownIncrementSeconds: number,
  endedSessionNum: number
): void {
  cooldownEndTime[domain] = Date.now() + cooldownSeconds * 1000;
  cooldownTotalSec[domain] = cooldownSeconds; // the bar's denominator — never recompute it
  // Freeze the clock before adopting the next session: that session is anchored
  // at the current daily total, so any time still accruing here would land in
  // the new session's elapsed count and eat into a limit the user hasn't begun.
  syncClock();
  sessions[domain] = nextSession;
  clearWindDown(domain);
  saveSessionState(); // persist new session number + active cooldown

  sendBlockerToAllTabsOfDomain(domain, cooldownSeconds, cooldownSeconds, endedSessionNum, cooldownIncrementSeconds);
  startCooldownTicker(domain, cooldownSeconds, endedSessionNum, cooldownIncrementSeconds);
  updateTimerDisplay(dailyTotal());
}

/**
 * End the current session early. The unused time is "carried over" so the next
 * session lasts (limit + carryover), and 10% of it is earned as grace baked
 * into that next session. The cooldown is for the session that just ended.
 */
async function endSessionEarly(): Promise<void> {
  if (!trackedTabDomain) return;
  const domain = trackedTabDomain;

  // Don't end if already in cooldown
  if ((cooldownEndTime[domain] || 0) > Date.now()) return;

  const settings = await loadInterventionSettings();
  if (!settings) return;
  const { sessionLimitSeconds, cooldownIncrementSeconds } = settings;
  if (sessionLimitSeconds <= 0) return;

  const session = getOrStartSession(domain, dailyTotal(), sessionLimitSeconds);

  const result = computeEndEarly(session, {
    dailyTotal: dailyTotal(),
    cooldownIncrement: cooldownIncrementSeconds,
  });
  if (!result) return; // no time left to claim — normal cooldown will fire on its own

  fireCooldown(domain, result.nextSession, result.cooldownSeconds, cooldownIncrementSeconds, session.sessionNum);
  log(
    `Session ${session.sessionNum} ended early for ${domain} ` +
    `(daily=${dailyTotal()}s, carryoverToNext=${result.nextSession.carryover}s, ` +
    `graceEarned=${result.graceEarned}s, cooldown=${result.cooldownSeconds}s)`
  );
}

function checkSessionLimit(settings: InterventionSettings): boolean {
  const { sessionLimitSeconds, cooldownIncrementSeconds } = settings;
  if (sessionLimitSeconds <= 0 || !trackedTabDomain) return false;

  const domain = trackedTabDomain;

  // Defensive: if a cooldown is already active, the incrementTimer() gate
  // should have prevented us from getting here at all, but return true to
  // short-circuit any other intervention work just in case.
  if ((cooldownEndTime[domain] || 0) > Date.now()) return true;

  // Lazily start the session for this domain. Runs once on the first tick after
  // a domain switch / extension load / settings change.
  const session = getOrStartSession(domain, dailyTotal(), sessionLimitSeconds);

  // Not at the end yet → session continues. Grace and carryover are already
  // baked into the session's effective length, so there's no mid-session
  // "extend the boundary" step anymore.
  if (displayFor(session, dailyTotal()).remaining > 0) return false;

  // Reached the end — natural cooldown. Carryover is consumed; next session is
  // a clean baseLength session anchored at the current daily total.
  const result = naturalEnd(session, {
    dailyTotal: dailyTotal(),
    cooldownIncrement: cooldownIncrementSeconds,
  });

  fireCooldown(domain, result.nextSession, result.cooldownSeconds, cooldownIncrementSeconds, session.sessionNum);
  log(
    `Session ${session.sessionNum} limit reached for ${domain} ` +
    `(daily=${dailyTotal()}s, cooldown=${result.cooldownSeconds}s, ` +
    `nextSession=${result.nextSession.sessionNum})`
  );
  return true;
}

function sendNudge(): void {
  if (!activeTabId) return;

  browser.tabs.sendMessage(activeTabId, {
    type: 'NUDGE'
  }).catch(err => console.warn('Failed to send nudge:', err));
}

function sendAveragePopup(minutesLeft: number, averageMinutes: number, stats: SessionStartStats): void {
  if (!activeTabId) return;

  browser.tabs.sendMessage(activeTabId, {
    type: 'SHOW_AVERAGE_POPUP',
    minutesLeft,
    averageMinutes,
    stats
  }).catch(err => console.warn('Failed to send average popup:', err));
}

async function init(): Promise<void> {
  browser.tabs.onActivated.addListener(handleTabActivated);
  browser.tabs.onUpdated.addListener(handleTabUpdated);
  browser.tabs.onRemoved.addListener(handleTabRemoved);
  browser.windows.onFocusChanged.addListener(handleWindowFocusChanged);
  browser.runtime.onMessage.addListener(handleMessageReceived);
  browser.alarms.onAlarm.addListener(handleAlarm);



  const settingsData = await browser.storage.local.get('webTimeSettings');
  const settings: WebTimeSettings = settingsData.webTimeSettings || { global: {}, domains: {} };
  dayResetTime = settings.global?.dayResetTime || 0;
  inactivityThresholdMs = (settings.global?.inactivityTimeoutS ?? 30) * 1000;
  log(`Day reset time loaded: ${dayResetTime}:00`);
  log(`Inactivity threshold: ${inactivityThresholdMs}ms`);

  currentDateStr = getLocalDateStrWithReset();

  // Sync foreground state on wake: a service worker can start while the browser
  // is in the background, so don't assume it's focused. getLastFocused throws if
  // no window is focused — treat that as background.
  try {
    const win = await browser.windows.getLastFocused();
    browserIsFocused = win.focused === true;
  } catch {
    browserIsFocused = false;
  }

  await loadTimeData();
  await loadAveragePopupShown();
  await loadSessionState(); // rehydrate session numbers / cooldowns after a worker restart

  const trackedTabs = await browser.tabs.query({ url: ["http://*/*", "https://*/*"] });
  trackedTabs.forEach((tab) => {
    if (tab.id) trackedTabIds.add(tab.id);
  });

  const activeTabs = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (activeTabs.length > 0 && activeTabs[0].id) {
    activeTabId = activeTabs[0].id;
    updateTimingState(activeTabId);
  }

  setInterval(() => {
    if (activeTabId) {
      updateTimingState(activeTabId);
    }
  }, ACTIVITY_CHECK_INTERVAL_MS);
  log("Initialization complete.");
}

init();
