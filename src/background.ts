import { Constants } from './shared/constants.js';
import { MSG, STORAGE, ALARM, PORT } from './shared/protocol.js';
import { extractDomain, getLocalDateStr, log, compute7DayStats } from './shared/utils.js';
import {
  type ActiveSession,
  startSession,
  displayFor,
  naturalEnd,
  endEarly as computeEndEarly,
  changeLength,
  cooldownLength,
  incrementSeconds,
  windDownState,
  scheduleFor,
  shouldScheduleWakes,
} from './shared/session-model.js';
import {
  checkSessionLimit as decideSessionLimit,
  checkNudge as decideNudge,
} from './shared/interventions.js';
import {
  type ClockState,
  createClock,
  isRunning,
  totalSeconds,
  exactSeconds,
  start,
  stop,
  setTotal,
  bank,
  restore,
} from './shared/time-clock.js';
import { clockVerdict as gatesVerdict, type ClockVerdict } from './shared/clock-gates.js';
import {
  type SessionHistory,
  type SessionEndState,
  toRecord,
  appendRecord,
  pruneHistory,
  readStored,
  toStored,
} from './shared/session-history.js';
import { readTrackedTime, dayCount, TRACKED_TIME_VERSION } from './shared/time-history.js';
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

// Set by loadTimeData() when the last save happened with the clock still
// running, meaning the worker died before writing the remainder. Consumed once,
// by recoverTime(), as soon as the tracked domain is known.
let pendingRecovery: { since: number; domain: Domain | null } | null = null;

// The largest gap we'll credit when recovering time after a worker death.
// Generous enough to cover any real death-and-wake cycle (measured at seconds
// to a couple of minutes), small enough that a closed laptop or a suspended
// machine never turns into hours of phantom screen time.
const MAX_RECOVERABLE_GAP_MS = 5 * 60 * 1000;
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
// nudgeInterval rides along because rescheduleWakes() is synchronous with respect
// to clock transitions and must not await a settings read to arm alarms.
const cachedDomainSessionLimit: Record<Domain, { sessionLimitSeconds: number; cooldownIncrementSeconds?: number; nudgeInterval?: number }> = {};
const cooldownEndTime: Record<Domain, number> = {};
const cooldownTotalSec: Record<Domain, number> = {};
const cooldownTickers: Record<Domain, ReturnType<typeof setInterval>> = {};
const windDownActive: Record<Domain, boolean> = {};

// Cache previous intervention settings per domain to detect actual changes
const previousInterventionSettings: Record<Domain, string> = {};

// Which tab has the end-session-early confirmation popup open (null = none).
// Freezes the timer (no daily increment) so the user has time to decide.
//
// The OWNING TAB, not a bare boolean: these gates sit above every other signal
// in shouldClockRun, so a flag left set stops the clock on every site until the
// extension is reloaded. A boolean was only ever cleared by a CLOSE message
// from the tab that opened it, and a tab can stop being able to send one —
// closed, crashed, discarded after a long spell in an unfocused window, or
// caught by an extension reload. Owning the tab id means the tab going away
// releases the gate.
let endSessionConfirmTabId: number | null = null;

// Which tab has the 7-day-average popup open. Like the confirmation popup, it
// blurs the page and pauses media, so the clock should freeze too — otherwise
// time keeps accruing against a page the user can't actually use.
let averagePopupTabId: number | null = null;

/**
 * Release any dialog gate held by `tabId`. Called wherever a tab can stop being
 * able to send its own CLOSE: removal, navigation, and a fresh content script
 * announcing itself (which means the old page — and its dialog — is gone).
 */
function releaseDialogGates(tabId: number): void {
  let released = false;
  if (endSessionConfirmTabId === tabId) { endSessionConfirmTabId = null; released = true; }
  if (averagePopupTabId === tabId) { averagePopupTabId = null; released = true; }
  if (released) {
    log(`Released dialog gate held by tab ${tabId}`);
    syncClock();
  }
}

// Whether the active tab is playing audio. This is a property of the tab, not
// of the passage of time, so caching it is safe — tabs.onUpdated fires on every
// change to it.
//
// Engagement itself is NOT cached. It used to be, and that was the bug behind
// "the timer stopped during a video and then jumped 30s": the flag was written
// only by handleTimerState, which runs on tab and focus events, so during silent
// playback nothing recomputed it. It decayed to false, the clock stopped, and
// the next mouse move both restarted it and credited the gap. Engagement is now
// derived live in activeTabIsEngaged() from timestamps that stay meaningful
// however long nothing runs.
let activeTabAudible = false;

// --- OS-level idle ---------------------------------------------------------
//
// chrome.idle reports whether the MACHINE has had input recently, which the
// content script cannot know: its events only fire while the user is doing
// something, so "no events" is ambiguous between "walked away" and "reading
// quietly". Two things make this worth a separate signal:
//
//   - It is correct on a cold start. tabLastActivity is empty on every worker
//     boot, which under MV3 is constant, so inferring activity from it alone
//     makes a reading user look idle until they happen to move the mouse.
//     queryState() answers directly.
//   - It is a wake source. onStateChanged revives a dead worker, so the
//     transition back to 'active' is noticed rather than waiting for the next
//     content-script message.
//
// It does NOT replace the per-tab test. chrome.idle's minimum detection
// interval is 15s and the user's inactivity threshold can be set as low as 1s,
// so for short thresholds the content-script events are still what provides
// the resolution. The two are complementary: chrome.idle catches "away from
// the machine", the content script catches "not interacting with this page".
//
// 'active' by default so a fresh worker counts until told otherwise, matching
// browserIsFocused. init() immediately replaces it with a real query.
let osIdleState: chrome.idle.IdleState = 'active';

/**
 * chrome.idle needs a detection interval in whole seconds, minimum 15. The
 * user's threshold can be lower, so clamp — the content-script events cover
 * the finer resolution and this stays the coarse "away from the machine" test.
 */
function idleDetectionSeconds(): number {
  return Math.max(15, Math.round(inactivityThresholdMs / 1000));
}

function applyIdleDetectionInterval(): void {
  browser.idle.setDetectionInterval(idleDetectionSeconds());
}

function handleIdleStateChanged(state: chrome.idle.IdleState): void {
  osIdleState = state;
  log(`OS idle state: ${state}`);
  // Act on it now. Going idle should stop the clock immediately rather than
  // waiting for a tick that may never come, and coming back should resume
  // without waiting for the content script to notice.
  syncClock();
}

/**
 * Read the true idle state, for a cold start where we have no history.
 *
 * Uses the callback form, which both Chrome and Firefox support — Firefox also
 * returns a promise here but Chrome's typings are callback-only, and this is
 * the one shape that works on both without a per-browser branch.
 */
function syncOsIdleState(): Promise<void> {
  return new Promise(resolve => {
    try {
      browser.idle.queryState(idleDetectionSeconds(), state => {
        osIdleState = state;
        log(`OS idle state on start: ${state}`);
        resolve();
      });
    } catch (err) {
      // Treat an unavailable idle API as "not idle" rather than freezing the
      // clock: over-counting a little beats a timer that silently stops.
      console.warn('idle.queryState failed, assuming active:', err);
      osIdleState = 'active';
      resolve();
    }
  });
}

// --- Scheduled wakes -------------------------------------------------------
//
// Under MV3 nothing of ours is guaranteed to be running when a session ends:
// the worker dies after ~30s idle, and video playback does not keep it alive
// (measured — 7 deaths in 10 untouched minutes). A blocker that fires whenever
// the worker next happens to wake is not a timer.
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


/** Drop every scheduled wake. Called before rebuilding, and when paused. */
async function clearWakes(): Promise<void> {
  const all = await browser.alarms.getAll();
  await Promise.all(
    all
      .filter(a => a.name.startsWith(ALARM.WAKE_PREFIX))
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

  const nudgeInterval = cachedDomainSessionLimit[domain]?.nudgeInterval;
  const wakes = scheduleFor(session, dailyTotal(), Date.now(), nudgeInterval);

  for (const w of wakes) {
    browser.alarms.create(`${ALARM.WAKE_PREFIX}${w.kind}-${w.sessionTime}`, { when: w.at });
  }
  log(`Scheduled ${wakes.length} wake(s) for ${domain}.`);
}

// --- Heartbeat backstop ----------------------------------------------------
//
// The scheduled wakes above are the mechanism; this is the safety net for the
// cases they structurally cannot cover:
//
//   - The day rolling over. Midnight is not a session deadline, so no wake is
//     armed for it, but the daily total has to reset.
//   - A session that exists with the clock STOPPED. rescheduleWakes()
//     deliberately arms nothing then, so if a stop was somehow missed (a
//     transition that never ran because the worker died between the event and
//     the handler) nothing would ever re-examine it.
//   - Persisting long-running time. saveTimeData() rides the display tick,
//     which stops with the worker; without this a very long uninterrupted
//     session would hold hours of un-banked time in memory only.
//
// One minute is the floor for periodInMinutes in practice and is far more
// often than any of these need. It is deliberately NOT the thing that makes
// session ends work — that is the scheduled wake — so its cost is bounded and
// it can be slow without breaking the timer.
const HEARTBEAT_PERIOD_MINUTES = 1;

// --- Keep-alive ------------------------------------------------------------
//
// Chrome kills the service worker after ~30s idle. WebTime is a timer, so a
// background that stops running is the one failure it can't absorb. An
// offscreen document holds a message port open, which keeps the worker
// resident and lets the ordinary 1-second tick do the counting.
//
// Firefox has a persistent background page and no offscreen API, so every one
// of these calls is guarded — on Firefox they no-op and nothing changes.


function supportsOffscreen(): boolean {
  return typeof chrome !== 'undefined' && chrome.offscreen !== undefined;
}

async function ensureKeepAlive(): Promise<void> {
  if (!supportsOffscreen()) return;
  try {
    // createDocument throws if one already exists, and hasDocument isn't on
    // every Chrome version — so just attempt it and treat "exists" as success.
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      // The document holds a message port and nothing else. BLOBS is the
      // closest of Chrome's fixed reason values that doesn't claim a capability
      // we don't use (no audio, no clipboard, no DOM scraping).
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification:
        'Keeps the service worker alive so the usage timer keeps counting in real time.',
    });
    log('Keep-alive document created.');
  } catch (err) {
    // Already exists is the common, benign case on a worker restart.
    log(`Keep-alive document not created: ${String(err)}`);
  }
}

/**
 * Accept the keep-alive port. Holding the reference and receiving its periodic
 * messages is what resets Chrome's idle timer; there is nothing to act on.
 */
function handleKeepAliveConnect(port: chrome.runtime.Port): void {
  if (port.name !== PORT.KEEPALIVE) return;
  log('Keep-alive port connected.');
  port.onMessage.addListener(() => { /* traffic alone is the point */ });
  port.onDisconnect.addListener(() => log('Keep-alive port disconnected.'));
}

/**
 * Re-inject the content script into tabs that lost theirs.
 *
 * A content script is injected when its page LOADS, so it belongs to whatever
 * extension version was current at that moment. Reload or update the extension
 * and every already-open tab keeps running the old script against a dead bridge:
 * the timer disappears and that tab silently stops being tracked until the user
 * happens to reload it. Chrome updates extensions on its own schedule, so this
 * is a real-world gap, not only a development annoyance.
 *
 * Injecting a second script into a tab that still has a live one is harmless —
 * the content script's init() clears leftover UI before building its own, so no
 * duplicate timers — which means this doesn't need to distinguish the two cases.
 *
 * Failures are expected and ignored per-tab: chrome:// pages, the Web Store, PDF
 * viewers and discarded tabs all reject injection, and none of that is worth
 * reporting.
 */
async function reviveOrphanedTabs(): Promise<void> {
  // MV3-only. Firefox aliases `chrome` and does ship scripting in MV2, so
  // feature-detecting the API passes there and then every injection rejects for
  // want of the permission — which the MV2 manifest deliberately omits, because
  // a persistent background page never orphans its content scripts.
  if (browser.runtime.getManifest().manifest_version < 3) return;
  if (typeof chrome === 'undefined' || !chrome.scripting) return;

  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  } catch (err) {
    log(`Could not query tabs for reinjection: ${String(err)}`);
    return;
  }

  let revived = 0;
  await Promise.all(tabs.map(async (tab) => {
    if (tab.id === undefined || tab.discarded) return;
    try {
      // CSS first: the script builds UI as soon as it runs, and the manifest's
      // declared stylesheet is not reapplied on a programmatic injection.
      // insertCSS is idempotent, so a tab that still has it is unaffected.
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['timer.css'],
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['dist/content.js'],
      });
      revived++;
    } catch {
      // Restricted URL, or the tab went away mid-flight. Neither is actionable.
    }
  }));

  log(`Reinjected content script into ${revived}/${tabs.length} tab(s).`);
}

function ensureHeartbeat(): void {
  // create() with the same name replaces any existing alarm, so this is
  // idempotent and safe to call on every worker boot.
  browser.alarms.create(ALARM.HEARTBEAT, {
    periodInMinutes: HEARTBEAT_PERIOD_MINUTES,
  });
}

function handleHeartbeat(): void {
  if (rolloverIfNewDay()) {
    updateTimerDisplay(dailyTotal());
    return;
  }

  // Re-examine the gates: if a transition was missed, this corrects it.
  syncClock();

  // Bank and persist while running, so a long session's time survives the
  // worker being killed between display ticks.
  if (isRunning(dailyClock)) {
    void saveTimeData();
    void checkForInterventions();
  }
}

/**
 * Every wake runs the same derivation the 1-second tick used to run. The alarm
 * only guarantees that SOMETHING is running at this instant; what to do is
 * decided entirely from current state.
 */
function handleAlarm(alarm: chrome.alarms.Alarm): void {
  if (alarm.name === ALARM.HEARTBEAT) {
    handleHeartbeat();
    return;
  }
  if (!alarm.name.startsWith(ALARM.WAKE_PREFIX)) return;
  log(`Wake: ${alarm.name}`);
  void checkForInterventions();
}

/**
 * Get the current session for a domain, lazily starting one anchored at the
 * current daily total if none exists yet. Runs on the first tick after a domain
 * switch / extension load / settings change. `baseLength` is the live limit in
 * seconds; callers only invoke this when baseLength > 0.
 */
function ensureSessionStarted(domain: Domain, anchorDaily: number, baseLength: number): ActiveSession {
  let s = sessions[domain];
  if (!s) {
    s = startSession({ dailyTotal: anchorDaily, baseLength });
    sessions[domain] = s;
    // Not just persistence. saveSessionState() also calls rescheduleWakes(),
    // which is what arms the alarms for this session's deadlines — and those
    // alarms are the only thing that fires the cooldown once the worker dies.
    // Without this call the session exists in memory with no armed end.
    saveSessionState();
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
  sendMessageToAllTabsOfDomain(domain, { type: MSG.HIDE_WIND_DOWN });
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
    [STORAGE.SESSION_STATE]: {
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
    const data = await browser.storage.local.get(STORAGE.SESSION_STATE);
    const stored = data[STORAGE.SESSION_STATE];
    if (!stored || stored.date !== currentDateStr) return; // absent or stale (new day)

    if (stored.sessions) {
      for (const [domain, session] of Object.entries(stored.sessions)) {
        sessions[domain] = session as ActiveSession;
      }
    }

    // Re-arm any cooldown still in the future; drop expired ones.
    const settingsData = await browser.storage.local.get(STORAGE.SETTINGS);
    const settings: WebTimeSettings = settingsData[STORAGE.SETTINGS] || { global: {}, domains: {} };
    for (const [domain, endTime] of Object.entries(stored.cooldownEndTime || {})) {
      if ((endTime as number) <= Date.now()) continue; // expired during downtime
      cooldownEndTime[domain] = endTime as number;
      // Reconstruct the blocker-UI args. The session stored for this domain is
      // the NEXT session (created when the cooldown fired), so the session that
      // is cooling down is sessionNum - 1.
      const nextSession = sessions[domain];
      const endedSessionNum = nextSession ? Math.max(1, nextSession.sessionNum - 1) : 1;
      const incrementSec = incrementSeconds(settings.domains?.[domain]?.cooldownIncrement);
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
  browser.storage.local.remove(STORAGE.SESSION_STATE).catch(() => {});
}

// ---------------------------------------------------------------------------
// FINISHED-SESSION HISTORY
//
// Deliberately NOT part of STORAGE.SESSION_STATE: that key is wiped every rollover
// by design (clearSessionState), which is exactly what history must survive.
// Its own key also keeps the blast radius off trackedTime, which is read
// everywhere.
//
// ~20 bytes per session, ~120/day — a rounding error against a 10MB quota.
// ---------------------------------------------------------------------------

/** Days of history to keep. Two years is far below any storage concern. */
const SESSION_HISTORY_KEEP_DAYS = 730;

/**
 * In-memory mirror of the stored history.
 *
 * The write path is read-modify-write against storage, but an MV3 worker can
 * die between a record and its flush; keeping the mirror means a rehydrate
 * reads storage rather than trusting memory that may have missed a write.
 */
let sessionHistory: SessionHistory = {};

// Set when the stored history could not be read — written by a newer build, or
// the read itself failed. In both cases `sessionHistory` is empty only because
// we could not see the real one, and the next recorded session would save that
// emptiness over it. So every write is skipped until the browser restarts.
let sessionHistoryReadOnly = false;

async function loadSessionHistory(): Promise<void> {
  try {
    const data = await browser.storage.local.get(STORAGE.SESSION_HISTORY);
    // readStored accepts both the pre-versioning bare map and the envelope, so
    // history written by an older build survives the upgrade untouched.
    const read = readStored(data[STORAGE.SESSION_HISTORY]);
    sessionHistory = read.history;
    if (read.fromFuture) {
      sessionHistoryReadOnly = true;
      console.warn(
        'WebTime: session history was saved by a newer version of this extension. ' +
        'Sessions will not be recorded until you update, so the existing history is not overwritten.'
      );
    }
  } catch (err) {
    sessionHistoryReadOnly = true;
    console.warn(
      'WebTime: could not read session history, so sessions will not be recorded ' +
      'this browser session (the stored history is left untouched). Restart the browser to retry.',
      err
    );
    sessionHistory = {};
  }
}

/**
 * Append the session that just ended to the history for `dateStr`.
 *
 * `dateStr` is passed rather than read from `currentDateStr` because the
 * rollover path records the ending day's last session AFTER deciding the date
 * has changed — reading the module-level value there would file it under the
 * new day. No-ops when there is no session (nothing ended).
 */
function recordFinishedSession(
  domain: Domain,
  session: ActiveSession | undefined,
  cooldownSeconds: number,
  endState: SessionEndState,
  dateStr: DateString = currentDateStr
): void {
  if (!session) return;
  if (sessionHistoryReadOnly) {
    log(`Session not recorded for ${domain}: stored history is read-only this run.`);
    return;
  }
  const record = toRecord(session, dailyTotal(), cooldownSeconds, endState);
  sessionHistory = pruneHistory(
    appendRecord(sessionHistory, dateStr, domain, record),
    SESSION_HISTORY_KEEP_DAYS
  );
  browser.storage.local.set({ [STORAGE.SESSION_HISTORY]: toStored(sessionHistory) })
    .catch(err => console.warn('Failed to persist session history:', err));
  log(
    `Recorded ${domain} session ${session.sessionNum} on ${dateStr}: ` +
    `${record[0]}s/${record[1]}s, ${record[2]}s cooldown, ${endState}`
  );
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
  if (trackedTimeReadOnly) {
    log('saveTimeData() skipped: stored history is read-only this run.');
    isSaving = false;
    return;
  }

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
      version: TRACKED_TIME_VERSION,
      // The anchor the clock is running from, so a worker death doesn't discard
      // the seconds since this write. Chrome gives no teardown callback, so
      // without this every restart silently loses up to a full save interval.
      // null when stopped — then the saved total is already complete.
      runningSince: isRunning(dailyClock) ? Date.now() : null,
      runningDomain: isRunning(dailyClock) ? trackedTabDomain : null,
    };

    await browser.storage.local.set({
      [STORAGE.TRACKED_TIME]: storageData,
    });
    log("Time data successfully saved with history.");
  } catch (error) {
    console.error("Error saving time data to storage:", error);
  } finally {
    isSaving = false;
  }
}

// Latched by loadTimeData() when the stored history could not be read — a
// format from a newer build, or a failed read. Either way the in-memory
// history is empty only because the real one was not visible, so every save
// is skipped while this is set and the store survives untouched.
let trackedTimeReadOnly = false;

async function loadTimeData(): Promise<void> {
  try {
    const storedData = await browser.storage.local.get(STORAGE.TRACKED_TIME);
    const read = readTrackedTime(storedData[STORAGE.TRACKED_TIME]);

    // A store written by a NEWER build. Reading it would be guesswork and
    // saving over it would destroy data this build cannot represent, so the
    // flag latches and every later save is skipped. The user sees an empty
    // history until they update, which is recoverable; a clobbered store is
    // not. Loud, because it is the one state where the extension is running
    // but deliberately not recording.
    if (read.fromFuture) {
      trackedTimeReadOnly = true;
      console.warn(
        'WebTime: stored data was written by a newer version of this extension. ' +
        'Time will not be recorded until you update, so the existing history is not overwritten.'
      );
      initDefaultTimeData();
      return;
    }

    if (!read.lastDate || dayCount(read.history) === 0) {
      initDefaultTimeData();
      return;
    }

    timeHistory = read.history;

    if (currentDateStr !== read.lastDate) {
      log(
        `New day detected (Last: ${read.lastDate}, Now: ${currentDateStr})`
      );
      setDailyTotal(0);
    } else {
      // Stash the unfinished-write record for recoverTime(). trackedTabDomain is
      // still null here — init() only resolves the active tab later — so the
      // recovery itself has to wait until the domain is known.
      pendingRecovery = read.runningSince
        ? { since: read.runningSince, domain: read.runningDomain }
        : null;
      const todaysData = timeHistory[currentDateStr] || {};
      setDailyTotal(trackedTabDomain ? (todaysData[trackedTabDomain] || 0) : 0);
    }

    log(
      `Loaded data for ${currentDateStr}, time: ${dailyTotal()}`
    );
  } catch (error) {
    trackedTimeReadOnly = true;
    console.error(
      'WebTime: could not read tracked time, so time will not be saved this browser ' +
      'session (the stored history is left untouched). Restart the browser to retry.',
      error
    );
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

  // Record every still-running session against the day that is ENDING, before
  // currentDateStr moves and before the deletes below discard them. Ordering is
  // load-bearing twice over: after the reassignment these file under tomorrow,
  // and after the delete loop there is nothing left to record.
  //
  // The rollover pre-empted the cooldown, so we store the one this session
  // WOULD have served rather than 0. It is a true fact about the session, and
  // storing it means changing the increment later cannot rewrite this card —
  // the same reason every other record stores its cooldown instead of a rule
  // to recompute it from. Read from the in-memory cache: this path is sync and
  // must not await a settings load.
  for (const domain of Object.keys(sessions)) {
    const session = sessions[domain];
    if (!session) continue;
    const incrementSec = cachedDomainSessionLimit[domain]?.cooldownIncrementSeconds || 0;
    const wouldHaveBeen = cooldownLength(session.sessionNum, incrementSec);
    recordFinishedSession(domain, session, wouldHaveBeen, 'dayEnded', currentDateStr);
  }

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
function currentClockVerdict(): ClockVerdict {
  // The gates and their ORDER live in shared/clock-gates.ts so they can be
  // tested. The cooldown ticker (startCooldownTicker) still handles the blocker
  // UI countdown while this returns false.
  return gatesVerdict({
    browserIsFocused,
    trackedDomain: trackedTabDomain,
    inCooldown: trackedTabDomain
      ? (cooldownEndTime[trackedTabDomain] || 0) > Date.now()
      : false,
    endSessionConfirmOpen: endSessionConfirmTabId !== null,
    averagePopupOpen: averagePopupTabId !== null,
    osIdleState,
    activeTabAudible,
    tabIsEngaged: activeTabIsEngaged(),
  });
}

function shouldClockRun(): boolean {
  const v = currentClockVerdict();
  return v === 'running' || v === 'audible';
}

/**
 * Whether the user is engaged with the active tab right now.
 *
 * Computed on every call rather than cached. The inputs are timestamps and OS
 * state, both of which stay correct across a service-worker death — unlike a
 * boolean, which is only as fresh as the last event that happened to write it.
 */
function activeTabIsEngaged(): boolean {
  // Audible playback is handled by the caller, ahead of the idle gate.
  if (activeTabId === null) return false;

  const lastActivity = tabLastActivity[activeTabId] || 0;

  // No recorded activity is AMBIGUOUS, not evidence of idleness: tabLastActivity
  // is in-memory only, so every worker boot starts empty even for a user who is
  // right there. chrome.idle is the one signal that survives the worker.
  if (lastActivity === 0) return osIdleState === 'active';

  return Date.now() - lastActivity < inactivityThresholdMs;
}

/**
 * Re-evaluate the gates and start or stop the clock to match.
 *
 * Every input to shouldClockRun() calls this when it changes, which is what
 * replaces the per-tick gate checks. Both directions are idempotent, so
 * calling it more often than strictly necessary is harmless.
 */
/**
 * The last verdict logged, so the trace records transitions rather than one
 * line per second. syncClock() runs on every display tick, and a stutter is
 * only legible if the log shows the moments the answer CHANGED.
 */
let lastLoggedVerdict: ClockVerdict | null = null;

function syncClock(): void {
  const verdict = currentClockVerdict();

  if (verdict !== lastLoggedVerdict) {
    log(`Clock verdict: ${lastLoggedVerdict ?? '(none)'} -> ${verdict}`, {
      audible: activeTabAudible,
      osIdle: osIdleState,
      engaged: activeTabIsEngaged(),
      focused: browserIsFocused,
      domain: trackedTabDomain,
    });
    lastLoggedVerdict = verdict;
  }

  if (verdict === 'running' || verdict === 'audible') clockStart();
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

/**
 * The daily total to put on the wire, with sub-second precision preserved.
 *
 * The content script extrapolates fractionally from whatever it receives, so a
 * floored value made the two clocks disagree by up to a second: it would reach
 * 40.9s, be told "40", and restart from 40.0. On screen that's a stall or a
 * step backward once a second — the jumpiness.
 *
 * Only the live clock can supply the fraction. Callers that pass a total from
 * somewhere else (a domain switch reading storage) are already whole seconds
 * and pass through unchanged; the floor check is what distinguishes them.
 */
function wireTime(updatedTime: number): number {
  if (!isRunning(dailyClock)) return updatedTime;
  const exact = exactSeconds(dailyClock, Date.now());
  return Math.floor(exact) === updatedTime ? exact : updatedTime;
}

function updateTimerDisplay(updatedTime: number): void {
  // Include session time info if a session limit is configured for this domain
  const message: { type: string; time: number; sessionTime?: number; sessionLimitSeconds?: number; sessionNum?: number; cooldownIncrementSeconds?: number; baseLengthSeconds?: number } = {
    type: MSG.TIME_UPDATE,
    time: wireTime(updatedTime)
  };

  if (trackedTabDomain) {
    const data = cachedDomainSessionLimit[trackedTabDomain];
    const baseLimitSec = data?.sessionLimitSeconds || 0;
    if (baseLimitSec > 0) {
      const session = ensureSessionStarted(trackedTabDomain, updatedTime, baseLimitSec);
      const display = displayFor(session, updatedTime);
      message.sessionTime = display.sessionTime;
      message.sessionLimitSeconds = display.sessionLimitSeconds;
      message.sessionNum = session.sessionNum;
      message.cooldownIncrementSeconds = data?.cooldownIncrementSeconds || 0;
      // The base, NOT the effective limit: the end-session confirm adds this
      // session's carryover+grace to it to state what the next session will be.
      // Sending the effective limit would double-count the current carryover.
      message.baseLengthSeconds = session.baseLength;
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
    // Every tracked tab gets the number, so a background tab shows the right
    // value when you return to it. Tabs only render what they're sent; the
    // background is the single clock.
    browser.tabs.sendMessage(tabId, message).catch(() => {
      // Expected whenever a tab closes or navigates between the send and its
      // delivery, so this is log(), not console.warn() — it's routine, and the
      // tab re-announces itself if it's still alive. Dropping it here is what
      // keeps the set from growing forever.
      log(`Tab ${tabId} has no listener; removing from tracking.`);
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
    handleTimerState(activeTab);

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
    // Deliberately no broadcast. updateTimerDisplay() goes to EVERY tracked
    // tab, so sending 0 here told a video tab showing 12:34 that its total was
    // zero — the timer dropped to 0 and sprang back on the next update. The
    // other tabs' numbers didn't change just because this tab isn't trackable;
    // they keep their own last value and their local clock.
    return;
  }

  const todayData = timeHistory[currentDateStr] || {};
  setDailyTotal(todayData[trackedTabDomain] || 0);
  recoverTime();
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

/**
 * Credit time that accrued between the last save and a worker death.
 *
 * Chrome kills the service worker with no teardown callback, so the seconds
 * since the last write are never persisted. Restoring only the saved number
 * discards them, and with a 60s save interval and a worker dying every ~30s
 * that loss repeats all day.
 *
 * Runs at most once per worker boot, and only for the domain that was actually
 * being counted — crediting the gap to whatever site happens to be open now
 * would invent time on a site the user never visited.
 */
function recoverTime(): void {
  if (!pendingRecovery) return;
  const { since, domain } = pendingRecovery;
  pendingRecovery = null;   // consume regardless, so it can't double-credit

  if (!trackedTabDomain || domain !== trackedTabDomain) return;

  // Don't credit a gap we can already see the user wasn't present for. The
  // bound below rejects long absences (a closed laptop overnight), but a SHORT
  // one — a few minutes with the lid shut — falls under it and would otherwise
  // be counted as time on the site. If the machine is idle or locked right now,
  // it very likely was during the gap too, so keep the saved total.
  //
  // init() refreshes osIdleState before loadTimeData(), so this is a real
  // reading rather than the optimistic 'active' default.
  if (osIdleState !== 'active') {
    log(`Skipping recovery: machine is ${osIdleState}.`);
    return;
  }

  // The browser being in the background is the same story from the other side.
  if (!browserIsFocused) {
    log('Skipping recovery: browser not focused.');
    return;
  }

  const before = dailyTotal();
  dailyClock = restore(before, since, Date.now(), MAX_RECOVERABLE_GAP_MS);
  const recovered = dailyTotal() - before;
  if (recovered > 0) {
    log(`Recovered ${recovered}s on ${domain} lost to worker death.`);
    // Persist immediately: this worker can die just as abruptly as the last one,
    // and an unwritten recovery is the same loss over again.
    void saveTimeData();
  }
}

function handleTimerState(activeTab: chrome.tabs.Tab): void {
  const isWebUrl = activeTab.url?.startsWith('http://') || activeTab.url?.startsWith('https://');
  if (!isWebUrl) {
    activeTabAudible = false;
    stopTimer();
    return;
  }

  // Record audibility; engagement itself is derived live by shouldClockRun.
  activeTabAudible = Boolean(activeTab.audible);

  // Ask the same gate as everything else. This used to test activeTabIsEngaged()
  // directly, which made it a second decider that didn't know about audio: a
  // playing video went unengaged after the inactivity threshold and this stopped
  // the clock, even though shouldClockRun() would have kept it running. Chrome
  // hid it — the keep-alive re-derives via syncClock() constantly — but on
  // Firefox's persistent background nothing re-ran and the stop stuck.
  if (shouldClockRun()) {
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
    // Navigating away destroys any dialog the old page had open. Released here
    // rather than only on CONTENT_SCRIPT_READY because a navigation to an
    // UNTRACKABLE url never produces one, and the gate would outlive the page.
    releaseDialogGates(tabId);
    const domain = extractDomain(changeInfo.url);
    if (!domain) {
      trackedTabIds.delete(tabId);
      delete tabLastActivity[tabId];
      log(`Removed tab ${tabId} from tracked tabs`);
    }
    // A trackable URL deliberately does NOT add the tab here. changeInfo.url
    // fires when navigation STARTS, before the new document's content script
    // exists, so adding now guarantees the next sendMessage fails and drops the
    // tab again. CONTENT_SCRIPT_READY is the only signal that a listener is
    // actually there, and it re-adds the tab a moment later.
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
  releaseDialogGates(tabId);
}

/**
 * Reconcile live state with settings the popup just wrote.
 *
 * Extracted from the message dispatch, where it was 120 of its 205 lines: this
 * is a reconciliation routine, not a dispatch branch. Every decision here is
 * re-derived from stored settings, so it is safe to run on any SETTINGS_UPDATED
 * regardless of what actually changed.
 */
function applyUpdatedSettings(): void {
  void browser.storage.local.get(STORAGE.SETTINGS).then(data => {
    const settings: WebTimeSettings = data[STORAGE.SETTINGS] || { global: {}, domains: {} };

    inactivityThresholdMs = (settings.global?.inactivityTimeoutS ?? 30) * 1000;
    applyIdleDetectionInterval();
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
      const cooldownIncrementSeconds = slEnabled ? incrementSeconds(domainCfg?.cooldownIncrement) : 0;
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
        existing = ensureSessionStarted(domain, dailyTotal(), newLimitSeconds);
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
        fireCooldown(domain, result.nextSession, result.cooldownSeconds, cooldownIncrementSeconds, updated.sessionNum, 'completed');
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

/**
 * Message type -> handler. A table rather than an if/else chain: a duplicate
 * type is now a compile error (duplicate key) instead of two handlers silently
 * running for one message, and each handler is independently readable.
 *
 * Handlers that need a tab check `sender.tab?.id` themselves — a message from
 * the popup has no tab, and the guard is part of what each one means.
 */
const messageHandlers: {
  [K in ExtensionMessage['type']]: (
    message: Extract<ExtensionMessage, { type: K }>,
    sender: chrome.runtime.MessageSender,
  ) => void;
} = {
  [MSG.CONTENT_SCRIPT_READY]: (_message, sender) => {
    if (!sender.tab?.id) return;
    // A fresh content script means the previous page is gone, along with any
    // dialog it had open — and its CLOSE message with it.
    releaseDialogGates(sender.tab.id);
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
  },

  [MSG.USER_ACTIVE]: (_message, sender) => {
    if (!sender.tab?.id) return;
    // Re-adopt the tab. The worker restarts constantly under MV3 and comes back
    // with an empty trackedTabIds, but a tab loaded before that restart only
    // ever sent CONTENT_SCRIPT_READY once and will never send it again. This
    // message proves both that the tab is alive and that a listener is there,
    // so it's what makes tracking self-heal after a restart.
    trackedTabIds.add(sender.tab.id);
    tabLastActivity[sender.tab.id] = Date.now();
    // Resume immediately rather than waiting for the activity poll. This
    // message is also the main thing that wakes the worker under MV3, so
    // handling it here is what makes "the user came back" take effect at all
    // when nothing of ours has been running.
    if (sender.tab.id === activeTabId) syncClock();
  },

  [MSG.END_SESSION_EARLY]: () => {
    void endSessionEarly();
  },

  [MSG.SHOW_END_SESSION_CONFIRM]: () => {
    // Popup asks us to open the confirmation overlay on the active tab (instead
    // of ending immediately). The popup closes itself; the user confirms there.
    if (activeTabId !== null) {
      browser.tabs.sendMessage(activeTabId, { type: MSG.SHOW_END_SESSION_CONFIRM })
        .catch(() => { /* tab may have closed or have no content script */ });
    }
  },

  [MSG.END_SESSION_CONFIRM_OPEN]: (_message, sender) => {
    // Record WHICH tab, so the gate can be released if that tab goes away
    // without ever sending its CLOSE.
    if (sender.tab?.id !== undefined) endSessionConfirmTabId = sender.tab.id;
    syncClock();
  },

  [MSG.END_SESSION_CONFIRM_CLOSE]: () => {
    endSessionConfirmTabId = null;
    syncClock();
  },

  [MSG.AVERAGE_POPUP_OPEN]: (_message, sender) => {
    if (sender.tab?.id !== undefined) averagePopupTabId = sender.tab.id;
    syncClock();
  },

  [MSG.AVERAGE_POPUP_CLOSE]: () => {
    averagePopupTabId = null;
    syncClock();
  },

  [MSG.REQUEST_BLOCKER_STATE]: (_message, sender) => {
    // A tab is asking for the current blocker state — typically on
    // visibilitychange after waking from a discarded/hidden state. Respond with
    // SHOW or HIDE so the tab's UI matches reality (it may have missed the
    // original HIDE_BLOCKER while suspended).
    if (!sender.tab?.id || !sender.tab?.url) return;
    const tabId = sender.tab.id;
    const domain = extractDomain(sender.tab.url);
    if (domain) {
      // sendBlockerToLateJoiningTab handles both cases: SHOW with correct
      // reconstructed text if in cooldown, HIDE otherwise.
      void sendBlockerToLateJoiningTab(tabId, domain);
    }
  },

  [MSG.SETTINGS_UPDATED]: () => {
    applyUpdatedSettings();
  },

  // Sent by the background to content scripts, never received here. Listed so
  // the table stays exhaustive over ExtensionMessage: a new message type is a
  // compile error until it is either handled or explicitly ignored like these.
  [MSG.TIME_UPDATE]: () => {},
  [MSG.NUDGE]: () => {},
  [MSG.SHOW_AVERAGE_POPUP]: () => {},
  [MSG.SHOW_BLOCKER]: () => {},
  [MSG.HIDE_BLOCKER]: () => {},
  [MSG.SHOW_WIND_DOWN]: () => {},
  [MSG.HIDE_WIND_DOWN]: () => {},
};

function handleMessageReceived(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
  _sendResponse: (response?: unknown) => void
): void {
  log(`handleMessage()`, message, sender);

  const handler = messageHandlers[message.type];
  if (handler) {
    (handler as (m: ExtensionMessage, s: chrome.runtime.MessageSender) => void)(message, sender);
  }
}

// A pass in flight, so overlapping callers join it instead of starting another.
//
// Three unserialized drivers reach this — the per-second tick, the heartbeat,
// and every wake alarm — and the function awaits settings BEFORE deciding. All
// three would suspend on that await, resume against the same unmarked session,
// and each fire the same nudge: firedNudges is written after the await, so none
// of them sees the others' write. That is a burst of identical nudges on one
// nudge time, delivered to whatever tab is active now.
//
// Coalescing rather than queueing is the point: a second pass that overlaps the
// first has nothing new to decide, since every decision here is re-derived from
// current state. Queueing them would just run the same redundant pass later.
let interventionPass: Promise<void> | null = null;

function checkForInterventions(): Promise<void> {
  if (interventionPass) return interventionPass;
  interventionPass = runInterventionPass().finally(() => { interventionPass = null; });
  return interventionPass;
}

async function runInterventionPass(): Promise<void> {
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

  const data = await browser.storage.local.get(STORAGE.SETTINGS);
  const settings: WebTimeSettings = data[STORAGE.SETTINGS] || { global: {}, domains: {} };
  const global = settings.global || {};
  const domainSettings = settings.domains?.[trackedTabDomain] || {};

  const sessionLimitEnabled = domainSettings.sessionLimitEnabled || false;
  const hasSessionLimit = sessionLimitEnabled && (domainSettings.sessionLimit || 0) > 0;

  // Cache session limit for timer display (even when returning null). The
  // cooldown increment rides along so the end-session confirm can quote the
  // cooldown it would trigger without an async settings load per tick.
  cachedDomainSessionLimit[trackedTabDomain] = {
    sessionLimitSeconds: hasSessionLimit ? (domainSettings.sessionLimit || 0) * 60 : 0,
    cooldownIncrementSeconds: hasSessionLimit ? incrementSeconds(domainSettings.cooldownIncrement) : 0,
    nudgeInterval: domainSettings.nudgeInterval
  };

  const { averageSeconds, daysWithData } = compute7DayStats(timeHistory, trackedTabDomain, currentDateStr);

  return {
    global,
    domainSettings,
    averageSeconds,
    daysWithData,
    timeInSeconds: dailyTotal(),
    sessionLimitSeconds: hasSessionLimit ? (domainSettings.sessionLimit || 0) * 60 : 0,
    cooldownIncrementSeconds: hasSessionLimit ? incrementSeconds(domainSettings.cooldownIncrement) : 0
  };
}

function checkPhiNudges(settings: InterventionSettings): void {
  const { sessionLimitSeconds } = settings;
  if (sessionLimitSeconds <= 0 || !trackedTabDomain) return;

  const domain = trackedTabDomain;
  const session = ensureSessionStarted(domain, dailyTotal(), sessionLimitSeconds);

  const outcome = decideNudge({
    session,
    dailyTotal: dailyTotal(),
    sessionLimitSeconds,
    nudgeInterval: settings.domainSettings.nudgeInterval,
  });
  if (!outcome) return;

  sendNudge();
  sessions[domain] = outcome.session;
  saveSessionState(); // persist firedNudges so a restart doesn't re-fire
  const remaining = displayFor(sessions[domain], dailyTotal()).remaining;
  log(`φ-nudge at ${Math.round(outcome.nudgeTime / 60)}min into session (${remaining}s remaining)`);
}

// Require a full week of history before the average is meaningful: all 7 days
// in the compute7DayStats window (the 7 days BEFORE today) must have usage on
// this domain. A partial week makes the "average" jumpy and the popup noisy.
const AVERAGE_POPUP_MIN_DAYS = 7;

function persistAveragePopupShown(): void {
  browser.storage.local.set({
    [STORAGE.AVERAGE_POPUP_SHOWN]: {
      date: currentDateStr,
      domains: interventionState.averagePopupShown
    }
  });
}

async function loadAveragePopupShown(): Promise<void> {
  const data = await browser.storage.local.get(STORAGE.AVERAGE_POPUP_SHOWN);
  const stored = data[STORAGE.AVERAGE_POPUP_SHOWN];
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

  const session = ensureSessionStarted(domain, dailyTotal(), sessionLimitSeconds);
  const wd = windDownState(session, dailyTotal());

  if (wd.active && !windDownActive[domain]) {
    windDownActive[domain] = true;
    log(`Wind-down started for ${domain} (${wd.remaining}s remaining)`);
  }

  if (wd.active) {
    sendMessageToAllTabsOfDomain(domain, {
      type: MSG.SHOW_WIND_DOWN,
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
    browser.tabs.sendMessage(tabId, { type: MSG.HIDE_BLOCKER }).catch(() => {});
    return;
  }
  const remaining = Math.ceil((endTime - Date.now()) / 1000);
  const nextSession = sessions[domain];
  const endedSessionNum = nextSession ? Math.max(1, nextSession.sessionNum - 1) : 1;
  const settingsData = await browser.storage.local.get(STORAGE.SETTINGS);
  const settings: WebTimeSettings = settingsData[STORAGE.SETTINGS] || { global: {}, domains: {} };
  const incrementSec = incrementSeconds(settings.domains?.[domain]?.cooldownIncrement);
  // The bar's denominator is the cooldown's FULL length, captured when it fired.
  // Use the stored value — recomputing it from the increment setting is exactly
  // what made the bar start at 100% when that setting read as 0 on a fresh tab.
  const totalSeconds = cooldownTotalSec[domain]
    || (incrementSec > 0 ? endedSessionNum * incrementSec : remaining);
  browser.tabs.sendMessage(tabId, {
    type: MSG.SHOW_BLOCKER,
    cooldownRemainingSeconds: remaining,
    totalCooldownSeconds: totalSeconds,
    cooldownCount: endedSessionNum,
    cooldownIncrementSeconds: incrementSec
  }).catch(() => {});
}

function sendBlockerToAllTabsOfDomain(domain: Domain, remainingSeconds: number, totalSeconds: number, cooldownCount: number, cooldownIncrementSeconds: number): void {
  const message = {
    type: MSG.SHOW_BLOCKER,
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
  const message = { type: MSG.HIDE_BLOCKER };

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
  endedSessionNum: number,
  endState: SessionEndState
): void {
  cooldownEndTime[domain] = Date.now() + cooldownSeconds * 1000;
  cooldownTotalSec[domain] = cooldownSeconds; // the bar's denominator — never recompute it
  // Freeze the clock before adopting the next session: that session is anchored
  // at the current daily total, so any time still accruing here would land in
  // the new session's elapsed count and eat into a limit the user hasn't begun.
  syncClock();
  // Record the session that just ended BEFORE the assignment below discards it.
  // This is the only moment it exists: sessions[domain] holds one session per
  // domain, so adopting the next one is the same act as losing this one.
  // syncClock() has already banked its final seconds, so dailyTotal() is exact.
  recordFinishedSession(domain, sessions[domain], cooldownSeconds, endState);
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

  const session = ensureSessionStarted(domain, dailyTotal(), sessionLimitSeconds);

  const result = computeEndEarly(session, {
    dailyTotal: dailyTotal(),
    cooldownIncrement: cooldownIncrementSeconds,
  });
  if (!result) return; // no time left to claim — normal cooldown will fire on its own

  fireCooldown(domain, result.nextSession, result.cooldownSeconds, cooldownIncrementSeconds, session.sessionNum, 'early');
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

  // Check the cooldown before touching the session: ensureSessionStarted creates
  // and persists one as a side effect, and a domain sitting in cooldown must
  // not get a session started for it.
  if ((cooldownEndTime[domain] || 0) > Date.now()) return true;

  // Lazily start the session for this domain. Runs once on the first tick after
  // a domain switch / extension load / settings change.
  const session = ensureSessionStarted(domain, dailyTotal(), sessionLimitSeconds);

  const outcome = decideSessionLimit({
    session,
    dailyTotal: dailyTotal(),
    sessionLimitSeconds,
    cooldownIncrementSeconds,
    cooldownEndsAt: cooldownEndTime[domain] || 0,
    now: Date.now(),
  });

  if (outcome.kind === 'continue') return false;
  if (outcome.kind === 'in-cooldown') return true;

  const { result, endedSessionNum } = outcome;
  fireCooldown(domain, result.nextSession, result.cooldownSeconds, cooldownIncrementSeconds, endedSessionNum, 'completed');
  log(
    `Session ${endedSessionNum} limit reached for ${domain} ` +
    `(daily=${dailyTotal()}s, cooldown=${result.cooldownSeconds}s, ` +
    `nextSession=${result.nextSession.sessionNum})`
  );
  return true;
}

function sendNudge(): void {
  if (!activeTabId) return;

  browser.tabs.sendMessage(activeTabId, {
    type: MSG.NUDGE
  }).catch(err => console.warn('Failed to send nudge:', err));
}

function sendAveragePopup(minutesLeft: number, averageMinutes: number, stats: SessionStartStats): void {
  if (!activeTabId) return;

  browser.tabs.sendMessage(activeTabId, {
    type: MSG.SHOW_AVERAGE_POPUP,
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
  browser.runtime.onConnect.addListener(handleKeepAliveConnect);
  browser.alarms.onAlarm.addListener(handleAlarm);
  browser.idle.onStateChanged.addListener(handleIdleStateChanged);



  const settingsData = await browser.storage.local.get(STORAGE.SETTINGS);
  const settings: WebTimeSettings = settingsData[STORAGE.SETTINGS] || { global: {}, domains: {} };
  dayResetTime = settings.global?.dayResetTime || 0;
  inactivityThresholdMs = (settings.global?.inactivityTimeoutS ?? 30) * 1000;
  log(`Day reset time loaded: ${dayResetTime}:00`);
  log(`Inactivity threshold: ${inactivityThresholdMs}ms`);

  currentDateStr = getLocalDateStrWithReset();

  // Before any clock decision: the detection interval depends on the settings
  // just loaded, and the state has to be real rather than the 'active' default.
  applyIdleDetectionInterval();
  await syncOsIdleState();

  // Keep the worker resident so the 1-second tick actually ticks. This is what
  // makes the timer behave like a timer under MV3; everything else here is a
  // backstop for the case where it fails.
  void ensureKeepAlive();

  // Arm the backstop on every worker boot. clearWakes() only touches the
  // ALARM.WAKE_PREFIX alarms, so rescheduling never removes this one.
  ensureHeartbeat();

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
  await loadSessionHistory(); // finished sessions, for the past-day panel

  // Tabs are NOT seeded from tabs.query here. A matching URL says nothing about
  // whether that document has our content script: tabs open from before the
  // extension was installed never got one, and under MV3 this runs on every
  // worker restart, so seeding them means the same dead tabs are re-added and
  // re-dropped on each boot. Live tabs announce themselves with
  // CONTENT_SCRIPT_READY, which is the only signal that a listener exists.
  //
  // Reinjection is what gets a script INTO those tabs in the first place; the
  // ones it revives then announce themselves normally.
  void reviveOrphanedTabs();

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
