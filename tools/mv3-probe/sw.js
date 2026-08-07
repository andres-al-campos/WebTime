// MV3 probe service worker.
//
// Answers two questions the WebTime Chrome port depends on:
//   Q1. Does alarms.create({when}) fire at the requested instant, or does
//       Chrome fuzz/delay it?
//   Q2. Does the worker actually die during silent audible playback (video
//       with no user interaction)?
//
// The worker cannot observe its own death, so everything is appended to
// storage.local. A cold start is detectable because module scope re-runs:
// WORKER_BOOT_ID is fresh every time the worker is spun up.

const WORKER_BOOT_ID = Math.random().toString(36).slice(2, 8);
const BOOT_AT = Date.now();

async function append(entry) {
  const { log = [] } = await chrome.storage.local.get('log');
  log.push({ ...entry, boot: WORKER_BOOT_ID, at: Date.now() });
  // Keep it bounded; we only ever need the recent tail.
  await chrome.storage.local.set({ log: log.slice(-800) });
}

// Module scope runs on every cold start. Recording it here is what lets us
// count deaths: each distinct boot id in the log is one resurrection.
append({ ev: 'WORKER_BOOT' });

// --- Q1: alarm precision ----------------------------------------------------
// Schedule a one-shot alarm at an absolute time and record the delta between
// requested and actual firing time. Re-arms itself so we gather many samples
// across varying idle durations.

// MODE: 'precision' measures alarm accuracy (Q1, answered: 0-4ms).
// 'lifetime' measures whether the worker dies unaided (Q2).
//
// The two cannot be measured at once: any alarm firing resets the ~30s idle
// countdown, so frequent precision alarms keep the worker alive and mask the
// death we're looking for. That is exactly what invalidated the first run.
// In 'lifetime' mode the heartbeat is off and a single long alarm is the only
// scheduled wake, leaving a genuine idle window in between.
const MODE = 'lifetime';

const PRECISION_DELAYS_MS = MODE === 'lifetime'
  ? [180000]           // one 3-minute alarm: long enough to leave real idle time
  : [5000, 15000, 30000, 60000, 120000];
let precisionIdx = 0;

async function armPrecisionAlarm() {
  const { pIdx = 0 } = await chrome.storage.local.get('pIdx');
  precisionIdx = pIdx;
  const delay = PRECISION_DELAYS_MS[precisionIdx % PRECISION_DELAYS_MS.length];
  const target = Date.now() + delay;
  await chrome.storage.local.set({ precisionTarget: target, requestedDelay: delay });
  chrome.alarms.create('precision', { when: target });
  append({ ev: 'ALARM_ARMED', delay, target });
}

// --- Q2: worker lifetime ----------------------------------------------------
// A 30s periodic alarm is the *backstop* wake. By comparing consecutive
// heartbeat timestamps against boot ids we can see whether the worker stayed
// alive between them or was resurrected to deliver the alarm.

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'precision') {
    const { precisionTarget, requestedDelay, pIdx = 0 } = await chrome.storage.local.get([
      'precisionTarget', 'requestedDelay', 'pIdx',
    ]);
    const drift = Date.now() - precisionTarget;
    await append({
      ev: 'ALARM_FIRED',
      requestedDelay,
      driftMs: drift,
      scheduledFor: precisionTarget,
    });
    await chrome.storage.local.set({ pIdx: pIdx + 1 });
    await armPrecisionAlarm();
    return;
  }

  if (alarm.name === 'heartbeat') {
    await append({ ev: 'HEARTBEAT' });
  }
});

// --- content-script pings ---------------------------------------------------
// The content script reports that a video is playing and whether it believes
// the page is silent-but-active. Each message is itself a wake source, so the
// content script deliberately pings only rarely (see probe-content.js).

chrome.runtime.onMessage.addListener((msg, sender) => {
  append({
    ev: 'MSG',
    kind: msg.kind,
    detail: msg.detail,
    tabId: sender.tab && sender.tab.id,
  });
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.audible !== undefined) {
    append({ ev: 'AUDIBLE_CHANGE', audible: changeInfo.audible, tabId });
  }
});

// Enforce the alarm set-up for the current MODE. Runs from onInstalled AND on
// every cold start, because alarms persist across reloads and browser restarts:
// a heartbeat left over from a precision run would keep the worker alive and
// silently invalidate a lifetime run — the exact failure that wasted run 1.
// Making this idempotent and unconditional means the mode can't be half-applied.
async function enforceMode() {
  const existing = await chrome.alarms.get('heartbeat');
  if (MODE === 'lifetime') {
    if (existing) {
      await chrome.alarms.clear('heartbeat');
      await append({ ev: 'CLEARED_STALE_HEARTBEAT' });
    }
  } else if (!existing) {
    chrome.alarms.create('heartbeat', { periodInMinutes: 0.5 });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ log: [], pIdx: 0 });
  await append({ ev: 'INSTALLED', mode: MODE });
  await enforceMode();
  await armPrecisionAlarm();
});

// Also on every cold start, so a browser restart (which does not re-fire
// onInstalled) can't leave a stale heartbeat running.
enforceMode();

chrome.runtime.onStartup.addListener(() => {
  append({ ev: 'BROWSER_STARTUP' });
});
