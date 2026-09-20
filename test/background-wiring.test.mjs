// The two popup gates freeze the clock while a modal is up, and must not
// strand it frozen when the modal closes.
//
// clock-gates.test.mjs already proves a raised flag stops the clock. What it
// cannot see is the wiring: whether every OPEN has a CLOSE that clears the same
// flag, and whether both re-run the gate afterwards. Those live in
// background.ts's message dispatch, which needs a browser to execute — so this
// asserts against the source instead.
//
// A source-level test is a blunt instrument and only as good as its patterns.
// It is here because the failure it guards against is bad and silent: a popup
// that sets the flag but never clears it leaves the timer frozen for the rest
// of the session, with nothing on screen to say why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/background.ts', 'utf8');

/** The gate each popup message pair drives. Holds the OWNING TAB's id rather
 *  than a boolean, so the gate can be released when that tab goes away without
 *  sending its CLOSE — see the dialog-gate tests at the bottom of this file. */
const GATES = [
  { open: 'END_SESSION_CONFIRM_OPEN', close: 'END_SESSION_CONFIRM_CLOSE', flag: 'endSessionConfirmTabId' },
  { open: 'AVERAGE_POPUP_OPEN', close: 'AVERAGE_POPUP_CLOSE', flag: 'averagePopupTabId' },
];

/** One handler's body from the messageHandlers table, up to the next entry. */
function branchBody(type) {
  const at = src.indexOf(`[MSG.${type}]:`);
  assert.notEqual(at, -1, `no handler entry for ${type}`);
  const rest = src.slice(at);
  const next = rest.indexOf('\n  [MSG.', 1);
  return next === -1 ? rest : rest.slice(0, next);
}

for (const { open, close, flag } of GATES) {
  test(`${open} records the owning tab and re-runs the gate`, () => {
    const body = branchBody(open);
    assert.match(body, new RegExp(`${flag}\\s*=\\s*sender\\.tab\\.id`),
      `${open} must record WHICH tab opened it, or the gate has no owner to release`);
    assert.match(body, /syncClock\(\)/, `${open} must call syncClock() so the freeze takes effect now`);
  });

  test(`${close} clears ${flag} and re-runs the gate`, () => {
    const body = branchBody(close);
    assert.match(body, new RegExp(`${flag}\\s*=\\s*null`), `${close} must set ${flag} = null`);
    assert.match(body, /syncClock\(\)/, `${close} must call syncClock() or the clock stays frozen`);
  });
}

test('each popup gate is written only by its own pair and the release path', () => {
  // A writer beyond these would make the gate's lifetime impossible to reason
  // about from the dispatch alone — the shape that produced two deciders for
  // the clock, where one caller set state another was responsible for.
  //
  // Three writes now, not two: OPEN, CLOSE, and releaseDialogGates() — the one
  // path that clears a gate whose tab can no longer send CLOSE.
  for (const { flag } of GATES) {
    // Exclude the declaration; only reassignments count.
    const writes = src.match(new RegExp(`(?<!let\\s)${flag}\\s*=\\s*(sender\\.tab\\.id|null)`, 'g')) || [];
    assert.equal(writes.length, 3,
      `${flag} should be written by OPEN, by CLOSE, and by releaseDialogGates only`);
  }
});

test('dispatch is a table, so a duplicate type cannot run two handlers', () => {
  // Was an if/else chain, where a type string repeated in two branches ran only
  // the first and the second was dead — invisible at runtime. As a keyed table
  // a duplicate is a duplicate object key, which TypeScript rejects outright,
  // so this asserts the table is still a table rather than re-checking chaining.
  assert.match(src, /const messageHandlers: \{/,
    'the dispatch must stay a keyed table, not an if/else chain');
  assert.doesNotMatch(src, /} else if \(message\.type === MSG\./,
    'a chained branch has reappeared alongside the table; there must be one dispatch');

  // Exhaustive over ExtensionMessage via a mapped type: a new message type
  // fails to compile until it is handled or explicitly ignored, which is what
  // stops a type from being added and silently never dispatched.
  assert.match(src, /\[K in ExtensionMessage\['type'\]\]/,
    'the table must be keyed by a mapped type over ExtensionMessage to stay exhaustive');
});

// --- debug logging ---------------------------------------------------------

test('release.sh builds with debug logging compiled out', () => {
  // ./build.sh leaves the trace on for development. If release.sh ever stops
  // passing WEBTIME_DEBUG=0, the published add-on logs every tab switch and
  // tick to users' consoles — visible to them, invisible to us.
  const release = readFileSync('release.sh', 'utf8');
  assert.match(
    release,
    /WEBTIME_DEBUG=0\s+\.\/build\.sh/,
    'release.sh must invoke build.sh with WEBTIME_DEBUG=0',
  );
});

test('log() survives being imported without the build-time define', () => {
  // Tests bundle modules directly, with no esbuild `define`, so a bare read of
  // __WEBTIME_DEBUG__ would be a ReferenceError rather than undefined.
  const utils = readFileSync('src/shared/utils.ts', 'utf8');
  assert.match(
    utils,
    /typeof __WEBTIME_DEBUG__ !== 'undefined'/,
    'log() must typeof-guard the define so it is safe under test',
  );
});

// ---------------------------------------------------------------------------
// SESSION HISTORY WRITE PATH
//
// sessions[domain] holds ONE session per domain, so every write point is a
// last chance: after the next assignment the finished session is gone. Two
// orderings carry the whole feature and neither can fail loudly.
//
//   1. fireCooldown must record BEFORE `sessions[domain] = nextSession`.
//   2. rolloverIfNewDay must record BEFORE `currentDateStr = newDateStr` (else
//      the day's last session files under tomorrow) and before the delete loop
//      (else there is nothing left to record).
//
// Both would silently drop data with the extension otherwise working normally.
// ---------------------------------------------------------------------------

/** The body of a named function declaration, up to the next top-level one. */
function functionBody(name) {
  const at = src.indexOf(`function ${name}(`);
  assert.notEqual(at, -1, `no function ${name}`);
  const rest = src.slice(at);
  const next = rest.indexOf('\nfunction ', 1);
  return next === -1 ? rest : rest.slice(0, next);
}

test('fireCooldown records the ending session before replacing it', () => {
  const body = functionBody('fireCooldown');
  const record = body.indexOf('recordFinishedSession(');
  const replace = body.search(/sessions\[domain\]\s*=\s*nextSession/);
  assert.notEqual(record, -1, 'fireCooldown must call recordFinishedSession');
  assert.notEqual(replace, -1, 'fireCooldown must still adopt the next session');
  assert.ok(
    record < replace,
    'recordFinishedSession must run BEFORE sessions[domain] = nextSession, ' +
    'or the session it records is already the new one',
  );
});

test('fireCooldown records after syncClock so the final seconds are banked', () => {
  // Strip comments first: the line above the record call MENTIONS syncClock(),
  // and matching that instead of the real call let an inverted ordering pass.
  const body = functionBody('fireCooldown').replace(/\/\/[^\n]*/g, '');
  const sync = body.indexOf('syncClock()');
  const record = body.indexOf('recordFinishedSession(');
  assert.notEqual(sync, -1, 'fireCooldown must still freeze the clock');
  assert.ok(
    sync < record,
    'syncClock() must run BEFORE recordFinishedSession, or dailyTotal() is ' +
    'stale and the recorded `used` is short by the unbanked tail',
  );
});

test('rollover records the day-ended session before the date moves', () => {
  const body = functionBody('rolloverIfNewDay');
  const record = body.indexOf('recordFinishedSession(');
  const reassign = body.search(/currentDateStr\s*=\s*newDateStr/);
  assert.notEqual(record, -1, 'rolloverIfNewDay must call recordFinishedSession');
  assert.notEqual(reassign, -1, 'rolloverIfNewDay must still advance the date');
  assert.ok(
    record < reassign,
    'recordFinishedSession must run BEFORE currentDateStr = newDateStr, or the ' +
    "ending day's last session is filed under the new day",
  );
});

test('rollover records before deleting the sessions', () => {
  const body = functionBody('rolloverIfNewDay');
  const record = body.indexOf('recordFinishedSession(');
  const del = body.search(/delete sessions\[domain\]/);
  assert.notEqual(del, -1, 'rolloverIfNewDay must still clear the sessions');
  assert.ok(
    record < del,
    'recordFinishedSession must run BEFORE the delete loop, or there is ' +
    'nothing left to record',
  );
});

test('rollover passes the ending date explicitly', () => {
  // The default parameter reads currentDateStr, which is correct everywhere
  // EXCEPT here — this is the one caller that must name the day it is leaving.
  const body = functionBody('rolloverIfNewDay');
  assert.match(
    body,
    /recordFinishedSession\([^)]*currentDateStr\s*\)/,
    'the rollover call must pass currentDateStr explicitly as the date',
  );
});

test('history is stored under its own key, not the wiped session state', () => {
  // SESSION_STATE_KEY is removed on every rollover by design; history living
  // there would be deleted at precisely the moment it becomes worth keeping.
  const protocol = readFileSync('src/shared/protocol.ts', 'utf8');
  assert.match(protocol, /SESSION_HISTORY:\s*'webTimeSessionHistory'/,
    'history needs its own storage key');
  // Match the body by braces rather than functionBody(): clearSessionState is
  // followed by a comment block, not another `function`, so the naive scan runs
  // past its end and into the history section it is supposed to exclude.
  const at = src.indexOf('function clearSessionState()');
  assert.notEqual(at, -1, 'no clearSessionState');
  const clear = src.slice(at, src.indexOf('\n}', at));
  assert.ok(
    !clear.includes('STORAGE.SESSION_HISTORY'),
    'clearSessionState must not remove the history key',
  );
});

test('rollover records the cooldown the session would have served, not 0', () => {
  // The rollover pre-empts the cooldown, but the session still had one due.
  // Hardcoding 0 there would make every day's last card claim no cooldown was
  // owed, and would be indistinguishable from a domain with cooldowns off.
  const body = functionBody('rolloverIfNewDay');
  assert.match(
    body,
    /cooldownLength\(/,
    'rollover must compute the would-have-been cooldown via cooldownLength()',
  );
  assert.ok(
    !/recordFinishedSession\([^)]*,\s*0\s*,\s*'dayEnded'/.test(body),
    'rollover must not hardcode a 0 cooldown for the day-ended session',
  );
});

test('rollover reads the increment from cache, not an awaited settings load', () => {
  // rolloverIfNewDay is sync and runs inside the tick path; awaiting a settings
  // read here would either not compile or silently reorder the record after the
  // deletes below it.
  // Strip comments before the await check — the prose above the loop mentions
  // awaiting, and matching that would fail on correct code.
  const body = functionBody('rolloverIfNewDay').replace(/\/\/[^\n]*/g, '');
  assert.match(body, /cachedDomainSessionLimit\[domain\]/,
    'the increment must come from the in-memory cache');
  assert.ok(!/\bawait\b/.test(body), 'rolloverIfNewDay must stay synchronous');
});

// ---------------------------------------------------------------------------
// PAST-DAY PANEL BRANCH
//
// The detail panel now has two shapes, and the failure mode is a mix: today's
// live session card left standing beside a past day's finished cards, both
// claiming to describe the same day. Nothing throws — it just lies.
// ---------------------------------------------------------------------------

const ui = readFileSync('src/popup/ui-manager.ts', 'utf8');

/** The body of a named function in ui-manager.ts, matched by brace column. */
function uiBody(name) {
  const at = ui.indexOf(`function ${name}(`);
  assert.notEqual(at, -1, `no function ${name}`);
  return ui.slice(at, ui.indexOf('\n}', at));
}

test('a past day renders session cards instead of the live session card', () => {
  const body = uiBody('updateDetailPanel').replace(/\/\/[^\n]*/g, '');
  const branch = body.indexOf('if (selectedDate)');
  assert.notEqual(branch, -1, 'renderDetailView must branch on the selected date');
  // Search from the branch: renderSessionCard also appears in the no-domain
  // guard above it, which is neither of the two shapes under test.
  const after = body.slice(branch);
  const live = after.indexOf('renderSessionCard(');
  const past = after.indexOf('renderPastDayCards(');
  const elseAt = after.indexOf('} else {');
  assert.notEqual(past, -1, 'the past-day branch must render the session cards');
  assert.notEqual(live, -1, 'the today branch must still render the live card');
  assert.ok(past < elseAt, 'renderPastDayCards belongs in the selectedDate branch');
  assert.ok(live > elseAt, 'renderSessionCard belongs in the else (today) branch');
});

test('today is not treated as a past day', () => {
  // Locking today's bar must fall through to the live cards; rendering today as
  // a finished day would hide the running session behind a summary of itself.
  const body = uiBody('lockedDetailDate').replace(/\/\/[^\n]*/g, '');
  assert.match(body, /getLocalDateStr\(AppState\.dayResetTime\)/,
    'lockedDetailDate must compare the locked day against today');
  assert.match(body, /return null/, 'today must resolve to null (the today branch)');
});

test('a day with no recorded sessions renders an empty state, not a gap', () => {
  // Permanent condition: every day before history recording started has none,
  // as does any day browsed without a session. Returning [] leaves the panel
  // blank under the usage card, which reads as a failed render.
  const cards = readFileSync('src/popup/past-day-cards.ts', 'utf8');
  const at = cards.indexOf('export function renderPastDayCards(');
  assert.notEqual(at, -1, 'no renderPastDayCards');
  const body = cards.slice(at, cards.indexOf('\n}', at)).replace(/\/\/[^\n]*/g, '');
  assert.match(
    body,
    /records\.length === 0/,
    'renderPastDayCards must special-case the empty day',
  );
  assert.ok(
    /return \[emptyState\(\)\]/.test(body),
    'the empty day must render an empty state rather than returning []',
  );
});

test('clicking a detail bar updates the panel without rebuilding the chart', () => {
  // renderDetailView constructs a new Chart, which replays the grow-from-zero
  // entry animation. Calling it from the click handler made every bar click
  // re-animate the whole chart. The general view has always updated only its
  // panel; this keeps the two consistent.
  const cb = readFileSync('src/popup/chart-builder.ts', 'utf8');
  const at = cb.indexOf('export function buildDetailViewChart(');
  assert.notEqual(at, -1, 'no buildDetailViewChart');
  const body = cb.slice(at, cb.indexOf('\n}', at)).replace(/\/\/[^\n]*/g, '');
  const click = body.indexOf('onClick:');
  assert.notEqual(click, -1, 'the detail chart must handle clicks');
  const handler = body.slice(click);
  assert.ok(
    !handler.includes('renderDetailView'),
    'the detail click handler must not call renderDetailView — it rebuilds the ' +
    'chart and re-animates it on every click',
  );
  assert.match(handler, /selectDetailDay\(/,
    'the click must go through selectDetailDay, which owns lock + highlight + panel');
});

test('a day is always selected in the detail view', () => {
  // The panel always describes some day, so a bar must always carry the
  // highlight. Deselecting means selecting today, not clearing the lock —
  // an unlocked detail view would show today's panel with no bar marked.
  const body = uiBody('renderDetailView').replace(/\/\/[^\n]*/g, '');
  assert.match(
    body,
    /AppState\.lockedDayIndex === null[\s\S]*?AppState\.lockDay\(/,
    'renderDetailView must default the selection to today when nothing is locked',
  );
  const cb = readFileSync('src/popup/chart-builder.ts', 'utf8');
  const at = cb.indexOf('export function buildDetailViewChart(');
  const handler = cb.slice(at, cb.indexOf('\n}', at)).replace(/\/\/[^\n]*/g, '');
  assert.ok(
    !/AppState\.unlockDay\(\)/.test(handler),
    'the detail click must not clear the lock; deselecting selects today',
  );
});

test('every UIManager method chart-builder calls is actually exported', () => {
  // chart-builder reaches UIManager through the global, so a missing export is
  // `undefined` at runtime, not a compile error — the bar-click handler died
  // exactly this way. The type is now imported type-only so tsc checks the
  // shape; this pins the runtime half, which tsc cannot see.
  const cb = readFileSync('src/popup/chart-builder.ts', 'utf8').replace(/\/\/[^\n]*/g, '');
  const called = new Set(
    [...cb.matchAll(/UIManager\.(\w+)\(/g)].map(m => m[1]),
  );
  assert.ok(called.size > 0, 'expected chart-builder to call UIManager');

  const uiSrc = readFileSync('src/popup/ui-manager.ts', 'utf8');
  const at = uiSrc.indexOf('export const UIManager = {');
  assert.notEqual(at, -1, 'no UIManager export object');
  const exported = uiSrc.slice(at, uiSrc.indexOf('};', at));

  for (const name of called) {
    assert.match(
      exported,
      new RegExp(`(^|[\\s,{])${name}\\s*[,\\n]`),
      `UIManager.${name}() is called from chart-builder but not in the export object`,
    );
  }
});

test('the minutes/seconds conversion goes through incrementSeconds', () => {
  // A bare `* 60` on the stored fractional-minutes increment reintroduces the
  // float noise that incrementSeconds exists to round away, and it does so
  // silently — the cooldown is one second short and nothing fails.
  const bg = readFileSync('src/background.ts', 'utf8');
  assert.doesNotMatch(
    bg,
    /cooldownIncrement[^\n]*\|\| 0\)\s*\*\s*60/,
    'convert the cooldown increment with incrementSeconds(), not a bare * 60',
  );
});

// ── Dialog gates must not outlive the tab that opened them ──────────────────
// Reported as: timer frozen on ALL sites after a tab sat in an unfocused window
// for hours; only reinstalling fixed it. These two gates sit above every other
// signal in shouldClockRun, so one left set stops the clock everywhere, and it
// lives in memory so only an extension reload clears it.
//
// The old shape was a bare boolean set by OPEN and cleared only by a CLOSE from
// the same tab. A discarded, crashed, or closed tab never sends CLOSE.
test('the dialog gates are owned by a tab, not global booleans', () => {
  assert.doesNotMatch(src, /let endSessionConfirmOpen = false;/,
    'a bare boolean cannot be released when its tab goes away');
  assert.doesNotMatch(src, /let averagePopupOpen = false;/,
    'a bare boolean cannot be released when its tab goes away');
  assert.match(src, /let endSessionConfirmTabId: number \| null = null;/);
  assert.match(src, /let averagePopupTabId: number \| null = null;/);

  // OPEN must record the sender, or there is no owner to release.
  const open = /END_SESSION_CONFIRM_OPEN\]:[\s\S]{0,400}?syncClock\(\);/.exec(src);
  assert.ok(open, 'the OPEN handler must be findable');
  assert.match(open[0], /sender\.tab\?\.id/, 'OPEN must record which tab opened the dialog');
});

test('every way a tab can vanish releases its dialog gate', () => {
  assert.match(src, /function releaseDialogGates\(tabId: number\): void/,
    'one release path, so the three call sites cannot drift');

  // A released gate must re-evaluate the clock, or the freeze persists until
  // some unrelated event happens to call syncClock.
  const fn = /function releaseDialogGates[\s\S]*?\n\}/.exec(src);
  assert.match(fn[0], /syncClock\(\)/, 'releasing must resync the clock');

  // Tab closed.
  const removed = /function handleTabRemoved[\s\S]*?\n\}/.exec(src);
  assert.match(removed[0], /releaseDialogGates\(tabId\)/, 'tab close must release');

  // Navigated away — including to an untrackable url, which never produces a
  // CONTENT_SCRIPT_READY.
  const updated = /function handleTabUpdated[\s\S]*?changeInfo\.url !== undefined\) \{[\s\S]{0,300}/.exec(src);
  assert.match(updated[0], /releaseDialogGates\(tabId\)/, 'navigation must release');

  // Fresh content script: the old page and its dialog are gone.
  const ready = /CONTENT_SCRIPT_READY[\s\S]{0,400}?trackedTabIds\.add/.exec(src);
  assert.match(ready[0], /releaseDialogGates\(sender\.tab\.id\)/,
    'a reloaded page must release the gate its predecessor held');
});

test('a store from a newer build is never written over', () => {
  // readTrackedTime reports the refusal; only background.ts can honor it. A
  // reader that returns fromFuture while the writer saves anyway loses the
  // newer data on the first tick — silently, and only on a downgrade.
  const load = /async function loadTimeData[\s\S]*?\n\}/.exec(src);
  assert.ok(load, 'loadTimeData must be findable');
  assert.match(load[0], /read\.fromFuture/, 'the load path must check fromFuture');
  assert.match(load[0], /trackedTimeFromFuture = true/,
    'the refusal must latch, or only the first save is skipped');

  const save = /async function saveTimeData[\s\S]*?\n\}/.exec(src);
  assert.ok(save, 'saveTimeData must be findable');
  const guard = /if \(trackedTimeFromFuture\)[\s\S]{0,200}?return;/.exec(save[0]);
  assert.ok(guard, 'saveTimeData must bail out when the latch is set');
  // The bail-out sits before the write, and must not strand the re-entry flag.
  assert.match(guard[0], /isSaving = false/,
    'the early return must clear isSaving, or saving deadlocks forever');
  assert.ok(save[0].indexOf('trackedTimeFromFuture') < save[0].indexOf('storage.local.set'),
    'the guard must come before the write, not after it');
});

test('the tracked-time store is read and written under the same key', () => {
  // A literal here and STORAGE.TRACKED_TIME there would read one key and write
  // another: the history would look permanently empty and silently duplicate.
  const save = /async function saveTimeData[\s\S]*?\n\}/.exec(src);
  assert.match(save[0], /\[STORAGE\.TRACKED_TIME\]: storageData/,
    'the write must use the protocol constant, not a bare trackedTime literal');
  assert.match(save[0], /version: TRACKED_TIME_VERSION/,
    'the written version must be the constant the reader compares against');
});

test('the storage banner is outside the view-switching container', () => {
  // The general/detail switch is a class swap on .pages-container. A banner
  // nested inside it would vanish on one of the two views, which is the exact
  // thing this banner must not do — and it would look fine in whichever view
  // happened to be open when it was tested.
  const html = readFileSync('extension/popup/popup.html', 'utf8');
  const banner = html.indexOf('id="storage-banner"');
  // The real element, not the word in a comment that explains this rule.
  const container = html.indexOf('<div class="pages-container');
  assert.ok(banner !== -1, 'the banner must exist in the popup markup');
  assert.ok(container !== -1, 'the carousel container must exist');
  assert.ok(banner < container,
    'the banner must come before .pages-container, not inside it');

  // Both export affordances have to be wired, not just the settings one.
  assert.ok(html.includes('id="storage-banner-export"'), 'banner needs its export control');
  assert.ok(html.includes('id="export-data-btn"'), 'settings needs its export control');

  const panel = readFileSync('src/popup/storage-panel.ts', 'utf8');

  // The message is written from TS because the percentage is live. If the id
  // the panel looks up is not the id in the markup, the banner shows an empty
  // amber bar — visible, wrong, and saying nothing.
  assert.ok(html.includes('id="storage-banner-text"'),
    'the banner text element needs the id the panel fills');
  assert.match(panel, /getElementById\('storage-banner-text'\)/,
    'the panel must fill the banner text');
  assert.match(panel, /percentFull\(bytes\)/, 'the message must carry the live percentage');
  // Inside the message, not just anywhere in the file — the word 'settings'
  // appears in this module for other reasons.
  const msg = /text\.textContent =([\s\S]*?);/.exec(panel);
  assert.ok(msg, 'the banner message must be findable');
  assert.match(msg[1], /settings/i, 'the message must point at the settings export');

  for (const id of ['storage-banner-export', 'export-data-btn']) {
    assert.match(panel, new RegExp(`getElementById\\('${id}'\\)[\\s\\S]{0,60}addEventListener`),
      `${id} must have a click handler`);
  }
});
