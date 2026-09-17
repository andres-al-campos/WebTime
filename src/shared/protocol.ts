// Every string that crosses a serialization boundary, in one place.
//
// Message types, storage keys, alarm names and port names are matched at
// runtime as strings, so a rename in one file and not the other is a silent
// break that TypeScript cannot see. With the names here, code refers to
// MSG.TIME_UPDATE rather than "TIME_UPDATE", and a rename is a compile error
// everywhere it was missed. The VALUES must never change casually: storage
// keys name data already on users' disks, and the others are matched by
// whichever build of the other side happens to be loaded.

/** runtime.sendMessage / tabs.sendMessage `type` discriminants. */
export const MSG = {
  // background -> content
  TIME_UPDATE: 'TIME_UPDATE',
  NUDGE: 'NUDGE',
  SHOW_AVERAGE_POPUP: 'SHOW_AVERAGE_POPUP',
  SHOW_BLOCKER: 'SHOW_BLOCKER',
  HIDE_BLOCKER: 'HIDE_BLOCKER',
  SHOW_WIND_DOWN: 'SHOW_WIND_DOWN',
  HIDE_WIND_DOWN: 'HIDE_WIND_DOWN',
  SHOW_END_SESSION_CONFIRM: 'SHOW_END_SESSION_CONFIRM',
  // content -> background
  CONTENT_SCRIPT_READY: 'CONTENT_SCRIPT_READY',
  USER_ACTIVE: 'USER_ACTIVE',
  END_SESSION_EARLY: 'END_SESSION_EARLY',
  END_SESSION_CONFIRM_OPEN: 'END_SESSION_CONFIRM_OPEN',
  END_SESSION_CONFIRM_CLOSE: 'END_SESSION_CONFIRM_CLOSE',
  AVERAGE_POPUP_OPEN: 'AVERAGE_POPUP_OPEN',
  AVERAGE_POPUP_CLOSE: 'AVERAGE_POPUP_CLOSE',
  REQUEST_BLOCKER_STATE: 'REQUEST_BLOCKER_STATE',
  // popup -> background
  SETTINGS_UPDATED: 'SETTINGS_UPDATED',
  // offscreen -> background, over the keep-alive port
  KEEPALIVE: 'KEEPALIVE',
} as const;

/** storage.local keys. Renaming one orphans the data stored under the old name. */
export const STORAGE = {
  TRACKED_TIME: 'trackedTime',
  SETTINGS: 'webTimeSettings',
  SESSION_STATE: 'webTimeSessionState',
  SESSION_HISTORY: 'webTimeSessionHistory',
  AVERAGE_POPUP_SHOWN: 'webTimeAveragePopupShown',
} as const;

/** chrome.alarms names. WAKE_PREFIX is followed by `${kind}-${sessionTime}`. */
export const ALARM = {
  HEARTBEAT: 'webtime-heartbeat',
  WAKE_PREFIX: 'webtime-wake-',
} as const;

/** runtime.connect port names. */
export const PORT = {
  KEEPALIVE: 'webtime-keepalive',
} as const;
