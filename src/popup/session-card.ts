// Live session card for the detail ("This site") view's right panel. NEW in the
// redesign — the old popup only edited session *settings*, never rendered a live
// session. Reads the background's persisted session state from storage and uses
// the pure session-model and session-budget functions to derive what is left.
//
// Three states:
//   Active — a session is running: time left, the sessions held, "End session".
//   Idle   — rules on, no session: the sessions held and when the next arrives.
//   Off    — rules off for this domain.

import { formatClock, formatDuration, getLocalDateStr } from '../shared/utils.js';
import { MSG, STORAGE } from '../shared/protocol.js';
import { displayFor, DEFAULT_NUDGE_INTERVAL_MIN, type ActiveSession } from '../shared/session-model.js';
import {
  budgetRules, fullBudget, sessionsAt, nextSessionAt, nextStartAt, startable, minFractionFor,
  DEFAULT_SESSIONS_PER_DAY, bankOf, splitHeld, type Budget, type BudgetRules,
} from '../shared/session-budget.js';

declare const browser: typeof chrome;


// The currently-shown domain/reset, so the storage listener re-renders the right
// card. Set by renderSessionCard; read by the onChanged handler below.
let liveDomain: string | null = null;
let liveDayReset = 0;
let storageListenerWired = false;

/**
 * Make the session card REACTIVE: re-render whenever the background mutates
 * session state or settings in storage. Without this the card only painted once
 * (right after the popup's own write, racing the background), so toggling rules
 * appeared to do nothing until a manual refresh. Idempotent — wires once.
 */
function ensureStorageListener(): void {
  if (storageListenerWired) return;
  storageListenerWired = true;
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!(STORAGE.SESSION_STATE in changes) && !(STORAGE.SETTINGS in changes)
      && !(STORAGE.SESSION_BUDGET in changes) && !(STORAGE.SESSION_EXTRA in changes)) return;
    if (liveDomain === null) return;
    renderSessionCard(liveDomain, liveDayReset).catch(err =>
      console.error('Error re-rendering session card on storage change:', err));
  });
}

interface SessionState {
  date: string;
  sessions: Record<string, ActiveSession>;
}

/**
 * The session model anchors `startDaily` to the active DOMAIN's today seconds
 * (background.ts: `todaysData[trackedTabDomain]`), NOT the all-sites total — so
 * the card must derive elapsed from the same per-domain figure or sessionTime
 * is wildly inflated.
 */
function domainDailySeconds(
  timeHistory: Record<string, Record<string, number>>, date: string, domain: string
): number {
  return timeHistory[date]?.[domain] || 0;
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}


interface DomainLimits {
  sessionLimitEnabled?: boolean;
  sessionLimit?: number;          // minutes
  nudgeInterval?: number;
  sessionsPerDay?: number;
  bankSessions?: number;
}

// Serialize writes: rapid stepper clicks each do read-modify-write on the same
// settings object, so concurrent calls would clobber each other. Chain them.
let writeQueue: Promise<void> = Promise.resolve();

/** Persist one domain's limit settings, mirroring saveSettings' storage shape.
 *  Serialized via writeQueue so back-to-back changes don't race. */
function saveDomainLimits(domain: string, next: DomainLimits): Promise<void> {
  // Snapshot `next` now — it's a live working copy the caller keeps mutating.
  const snapshot = { ...next };
  writeQueue = writeQueue.then(() => writeDomainLimits(domain, snapshot));
  return writeQueue;
}

async function writeDomainLimits(domain: string, next: DomainLimits): Promise<void> {
  const data = await browser.storage.local.get(STORAGE.SETTINGS);
  const settings = data[STORAGE.SETTINGS] || { global: {}, domains: {} };
  if (!settings.domains) settings.domains = {};

  const hasAny = next.sessionLimitEnabled || (next.sessionLimit || 0) > 0;
  if (hasAny) {
    settings.domains[domain] = {
      sessionLimitEnabled: next.sessionLimitEnabled || false,
      sessionLimit: (next.sessionLimit || 0) > 0 ? next.sessionLimit : undefined,
      nudgeInterval: next.nudgeInterval,
      sessionsPerDay: next.sessionsPerDay,
      bankSessions: next.bankSessions,
    };
  } else {
    delete settings.domains[domain];
  }
  await browser.storage.local.set({ webTimeSettings: settings });
  browser.runtime.sendMessage({ type: MSG.SETTINGS_UPDATED });
}

/** A stepper handle: its element plus a setter to drive it from outside (e.g. a
 *  sibling stepper carrying into it) without re-firing onChange. */
interface Stepper {
  el: HTMLElement;
  /** Update the displayed value (and `cur`) silently — no onChange. */
  setValue: (v: number) => void;
}

/** A labelled stepper: an editable value + unit with ▲/▼ buttons that support
 *  click, press-and-hold-to-repeat, and direct typing. When `onCarry` is set,
 *  stepping past min/max wraps around (within [min,max]) and reports the
 *  direction so a neighbour (e.g. minutes) can absorb the carry. Exported so the
 *  global settings panel can use the same control instead of native inputs. */
export function stepper(opts: {
  label: string; value: number; unit?: string;
  /** Lower bound. A function is re-read on every step and every typed commit,
   *  for a floor that depends on a sibling control. */
  min: number | (() => number);
  max: number; step: number;
  onChange: (v: number) => void;
  /** Called when a step crosses min/max. Return false to veto the wrap (the
   *  value stays pinned at the edge it tried to cross). */
  onCarry?: (dir: number) => boolean;
  /** Omit the label row — used when several boxes share one external heading
   *  (a pair of boxes under a single label). */
  noHead?: boolean;
  /** Word to show instead of "0" — for settings where zero is a STATE, not a
   *  quantity ("Off"), so the box doesn't read as a real interval of zero. The
   *  unit suffix is hidden alongside it. */
  zeroLabel?: string;
  /** One sentence shown on hover, for a setting its label can't explain. */
  hint?: string;
}): Stepper {
  const group = el('div', 'sc-stepper-group');
  if (opts.hint) group.title = opts.hint;
  if (!opts.noHead) {
    const head = el('div', 'sc-stepper-head');
    head.append(el('span', 'sc-stepper-label', opts.label));
    group.append(head);
  }

  const box = el('div', 'sc-stepper-box');
  // The value is an editable field so users can TYPE a number directly; the unit
  // sits beside it as a static suffix. contentEditable (not <input>) keeps the
  // existing inline-value styling and lets the unit ride alongside in the box.
  const valWrap = el('span', 'sc-stepper-val');
  const valEl = el('span', 'sc-stepper-num');
  valEl.contentEditable = 'true';
  valEl.spellcheck = false;
  // Round to the step grid so fractional steps (e.g. 0.5) don't accumulate
  // binary floating-point dust like 3.4999999. Quantize relative to min so a
  // non-zero min with a fractional step still lands on grid.
  const minOf = () => typeof opts.min === 'function' ? opts.min() : opts.min;

  // Snap to the step grid, then round off float dust (0.05 * 13 = 0.650000…1) so
  // neither the display nor the persisted value carries it. 2 decimals covers the
  // finest step (0.05); trailing zeros are dropped so integers read "40" not
  // "40.00".
  const quantize = (v: number) => {
    const m = minOf();
    return parseFloat((m + Math.round((v - m) / opts.step) * opts.step).toFixed(2));
  };
  const unitEl = opts.unit
    ? Object.assign(document.createElement('span'), {
        className: 'sc-stepper-unit', textContent: opts.unit,
      })
    : null;
  // At zero the box shows the word, not the number, and drops the unit — "0 min"
  // reads as an interval that happens to be zero, "Off" reads as a state. The
  // field stays editable either way; typing a number restores the normal render.
  const setNum = (v: number) => {
    const off = opts.zeroLabel !== undefined && v === 0;
    valEl.textContent = off ? opts.zeroLabel! : String(v);
    valWrap.classList.toggle('is-zero', off);
    if (unitEl) unitEl.style.display = off ? 'none' : '';
  };
  valWrap.append(valEl);
  if (unitEl) valWrap.append(unitEl);
  let cur = quantize(opts.value);
  setNum(cur);

  // Commit a step in `dir`, honouring carry-over at the edges. Factored out so
  // both the initial click and the hold-to-repeat timer call the same path.
  const stepOnce = (dir: number) => {
    const min = minOf();
    const span = opts.max - min + opts.step; // wrap modulus, in step units
    const raw = cur + dir * opts.step;
    if (opts.onCarry && (raw > opts.max || raw < min)) {
      // Past an edge: let the neighbour absorb the carry. If it accepts, wrap
      // within [min,max]; if it vetoes (e.g. minutes already 0), stay put.
      if (opts.onCarry(dir)) {
        cur = ((((raw - min) % span) + span) % span) + min;
      }
    } else {
      cur = Math.max(min, Math.min(opts.max, raw));
    }
    cur = quantize(cur);
    setNum(cur);
    opts.onChange(cur);
  };

  // Parse + clamp a typed value on commit (blur / Enter). Reverts to the last
  // good value on garbage so the field can never hold something un-persistable.
  const commitTyped = () => {
    const raw = (valEl.textContent ?? '').trim();
    // The field renders a word at zero, so accept that word back — otherwise
    // clicking into "Off" and pressing Enter would revert rather than commit.
    if (opts.zeroLabel !== undefined && raw.toLowerCase() === opts.zeroLabel.toLowerCase()) {
      cur = 0;
      opts.onChange(cur);
      setNum(cur);
      return;
    }
    const parsed = parseFloat(raw);
    if (Number.isFinite(parsed)) {
      cur = quantize(Math.max(minOf(), Math.min(opts.max, parsed)));
      opts.onChange(cur);
    }
    setNum(cur); // normalize display (clamp/round, or revert on NaN)
  };
  valEl.addEventListener('blur', commitTyped);
  valEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); valEl.blur(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); stepOnce(1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); stepOnce(-1); }
  });

  const btns = el('div', 'sc-stepper-btns');
  const mk = (sym: string, dir: number): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = 'sc-stepper-btn';
    b.textContent = sym;
    // Press-and-hold to repeat: one immediate step, then accelerating repeats
    // after a short delay. pointer events (not click) so we can catch the hold
    // and release; cleared on up/leave/cancel so it can't run away.
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    let repeatTimer: ReturnType<typeof setInterval> | undefined;
    const stop = () => { clearTimeout(holdTimer); clearInterval(repeatTimer); holdTimer = repeatTimer = undefined; };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();          // don't steal focus from / blur the value field
      stepOnce(dir);
      holdTimer = setTimeout(() => { repeatTimer = setInterval(() => stepOnce(dir), 60); }, 350);
    });
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointerleave', stop);
    b.addEventListener('pointercancel', stop);
    return b;
  };
  btns.append(mk('▲', 1), mk('▼', -1));
  box.append(valWrap, btns);

  // The whole box is a click target for the value field — clicking anywhere in
  // the padding (not on a ▲/▼ button) focuses the number and drops the caret at
  // the end, so you don't have to hit the digits precisely.
  box.addEventListener('mousedown', (e) => {
    if (e.target === valEl || btns.contains(e.target as Node)) return;
    e.preventDefault();
    valEl.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(valEl);
    range.collapse(false); // caret to end
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
  box.style.cursor = 'text';

  group.append(box);
  return {
    el: group,
    setValue: (v: number) => { cur = v; setNum(cur); },
  };
}

function cardShell(): HTMLElement {
  return el('div', 'sc-card');
}

/**
 * Per-site "Session rules" card (top of the detail right panel). Toggle +
 * length / nudge / sessions-per-day / bank steppers. Persists per-domain on every change.
 */
export async function renderSessionSettingsCard(
  domain: string | null,
  // Reset time no longer needed here — the live card re-renders reactively via
  // the storage listener rather than being re-rendered from persist().
  _dayResetMinutes = 0,
): Promise<void> {
  const host = document.getElementById('session-settings-card');
  if (!host) return;
  if (!domain) { host.replaceChildren(); return; }

  const data = await browser.storage.local.get(STORAGE.SETTINGS);
  const settings = data[STORAGE.SETTINGS] || { global: {}, domains: {} };
  const d: DomainLimits = settings.domains?.[domain] || {};

  // Working copy persisted on each control change.
  const cur: Required<DomainLimits> = {
    sessionLimitEnabled: d.sessionLimitEnabled || false,
    sessionLimit: d.sessionLimit || 40,
    nudgeInterval: d.nudgeInterval ?? DEFAULT_NUDGE_INTERVAL_MIN,
    sessionsPerDay: d.sessionsPerDay ?? DEFAULT_SESSIONS_PER_DAY,
    bankSessions: bankOf(d as DomainLimits & { maxSessions?: number }, d.sessionsPerDay ?? DEFAULT_SESSIONS_PER_DAY),
  };
  // Just persist. The live session card re-renders REACTIVELY via the storage
  // listener (on both our settings write and the background's session-state
  // write), so we don't manually re-render here and race the background.
  const persist = () => saveDomainLimits(domain, cur)
    .catch(err => console.error('Error saving domain limits:', err));

  const card = el('div', 'sc-card sc-settings');

  // header: title + toggle
  const head = el('div', 'sc-head');
  head.append(el('span', 'sc-settings-title', 'Session rules'));
  const toggle = document.createElement('button');
  toggle.className = 'sc-toggle';
  const knob = el('span', 'sc-toggle-knob');
  toggle.appendChild(knob);
  const reflectToggle = () => {
    toggle.classList.toggle('on', cur.sessionLimitEnabled);
    body.style.opacity = cur.sessionLimitEnabled ? '1' : '0.4';
  };
  toggle.addEventListener('click', () => {
    cur.sessionLimitEnabled = !cur.sessionLimitEnabled;
    reflectToggle();
    persist();
  });
  head.append(toggle);

  // body: two two-up rows — [session length | nudges], then
  // [sessions per day | max sessions].
  const body = el('div', 'sc-settings-body');

  const rowOne = el('div', 'sc-settings-twoup');
  rowOne.append(
    stepper({
      label: 'Session length', value: cur.sessionLimit, unit: 'min',
      min: 1, max: 240, step: 1,
      onChange: v => { cur.sessionLimit = v; showMath(); persist(); },
    }).el,
    stepper({
      // Minutes between nudges, not a count: session length varies per session
      // now, so "how many" has no fixed meaning. 0 disables them for this domain.
      label: 'Nudge every', value: cur.nudgeInterval, unit: 'min',
      min: 0, max: 120, step: 1, zeroLabel: 'Disabled',
      onChange: v => { cur.nudgeInterval = v; persist(); },
    }).el
  );

  const rowTwo = el('div', 'sc-settings-twoup');
  rowTwo.append(
    stepper({
      // How fast sessions come back: one every 24h / this. Also the dots on
      // the gate, so 10 is as many as its row can hold.
      label: 'Sessions per day', value: cur.sessionsPerDay,
      min: 1, max: 10, step: 1,
      onChange: v => { cur.sessionsPerDay = v; showMath(); persist(); },
    }).el,
    stepper({
      // Sessions left over from quiet days, kept past a day's worth.
      label: 'Banked sessions', value: cur.bankSessions,
      hint: "If a session refills when you have all your daily sessions, it's added to the bank, up to this many. Banked sessions don't expire.",
      min: 0, max: 10, step: 1,
      onChange: v => { cur.bankSessions = v; persist(); },
    }).el
  );
  // What a day of sessions adds up to.
  const math = el('div', 'sc-math');
  function showMath(): void {
    math.textContent = `${cur.sessionsPerDay} × ${cur.sessionLimit}m = ${formatDuration(cur.sessionsPerDay * cur.sessionLimit * 60)} a day`;
  }
  showMath();
  body.append(rowOne, rowTwo, math);

  card.append(head, body);
  host.replaceChildren(card);
  reflectToggle();
}

/** Off — limits disabled for this domain. */
function renderOff(host: HTMLElement): void {
  const card = el('div', 'sc-card sc-off');
  card.append(
    el('div', 'sc-off-title', 'No limit on this site'),
    el('div', 'sc-off-sub', 'Tracking time only. Turn limits on above to run sessions here.')
  );
  host.replaceChildren(card);
}

/** What the card needs to draw the sessions a site holds. */
interface Held {
  budget: Budget;
  rules: BudgetRules;
  /** The site's full session length, seconds. */
  lengthSec: number;
  /** Unused time from the last session, added to the next. */
  extraSec: number;
}

// The row and its "Next session in" count regenerate while the popup is open,
// so they tick on their own. Only their text and fill change: re-rendering the
// whole card each second would replace the End button under a click.
let heldTicker: ReturnType<typeof setInterval> | null = null;

/**
 * The row of a day's sessions (the one regenerating at half opacity), the
 * count banked beyond it, and the line under them. With `running` the line is when the next whole session arrives;
 * without, it also says what the gate would offer right now.
 */
function heldBlock(h: Held, running: boolean): HTMLElement[] {
  const dots = el('div', 'sc-dots');
  const count = Math.max(1, Math.min(10, Math.ceil(h.rules.sessionsPerDay)));
  for (let i = 0; i < count; i++) dots.append(el('span', 'sc-dot'));
  const bank = el('span', 'sc-bank');
  dots.append(bank);
  const line = el('div', 'sc-sub');

  const update = () => {
    const now = Date.now();
    const held = sessionsAt(h.budget, h.rules, now);
    const { daily, banked } = splitHeld(held, h.rules.sessionsPerDay);
    bank.textContent = banked > 0 ? `+${banked} banked` : '';
    for (let i = 0; i < count; i++) {
      const dot = dots.children[i] as HTMLElement;
      const fill = Math.min(1, Math.max(0, daily - i));
      const whole = fill > 0.999;
      dot.style.setProperty('--sc-fill', `${(whole ? 1 : fill) * 100}%`);
      dot.classList.toggle('is-full', whole);
      dot.classList.toggle('is-part', fill > 0 && !whole);
    }
    const inClock = (at: number) => formatClock(Math.max(0, Math.ceil((at - now) / 1000)));
    const next = nextSessionAt(h.budget, h.rules, now);
    const nextText = next === null ? '' : `Next session in ${inClock(next)}`;
    if (running) {
      line.textContent = nextText;
    } else {
      const minFraction = minFractionFor(h.lengthSec);
      const offer = startable(h.budget, h.rules, now, minFraction);
      const startAt = nextStartAt(h.budget, h.rules, now, minFraction);
      line.textContent = offer > 0
        ? [`A ${formatClock(Math.round(offer * h.lengthSec) + h.extraSec)} session is ready on the site.`, nextText].filter(Boolean).join(' ')
        : startAt === null ? 'No sessions regenerate.' : `Next session in ${inClock(startAt)}`;
    }
    line.style.display = line.textContent ? '' : 'none';
  };
  update();
  heldTicker = setInterval(update, 1000);
  return [dots, line];
}

/** Idle — rules on, no session running: the site is behind the gate. */
function renderIdle(host: HTMLElement, h: Held): void {
  const card = cardShell();
  const head = el('div', 'sc-head');
  head.append(el('span', 'sc-title', 'No active session'));
  card.append(head, ...heldBlock(h, false));
  host.replaceChildren(card);
}

/** Active session state. */
function renderActive(host: HTMLElement, s: ActiveSession, dailyTotal: number, shortcut: string | null, h: Held): void {
  const { sessionTime, sessionLimitSeconds } = displayFor(s, dailyTotal);
  const remaining = Math.max(0, sessionLimitSeconds - sessionTime);
  // Percent LEFT (not spent), so the number moves the same direction as the
  // countdown timer on the page.
  const pctLeft = sessionLimitSeconds > 0 ? Math.round((remaining / sessionLimitSeconds) * 100) : 0;
  const leftColor = pctLeft < 15 ? 'var(--warn)' : 'var(--good)';

  const card = cardShell();

  const head = el('div', 'sc-head');
  const title = el('span', 'sc-title', 'Session');
  const pctEl = el('span', 'sc-title-pct', ` · ${pctLeft}% left`);
  pctEl.style.color = leftColor;
  title.append(pctEl);
  head.append(title);

  const btn = el('button', 'sc-btn');
  btn.id = 'session-end-early-btn';
  btn.textContent = shortcut ? `End session (${shortcut})` : 'End session early';

  card.append(
    head,
    el('div', 'sc-time', formatClock(remaining)),
    el('div', 'sc-sub', `left of ${formatClock(sessionLimitSeconds)}`),
    ...heldBlock(h, true),
    btn,
  );
  host.replaceChildren(card);

  btn.addEventListener('click', () => {
    // Don't end immediately — an accidental click would be unrecoverable. Ask the
    // active tab to show the confirmation overlay (same as the keyboard shortcut),
    // then close the popup so the user confirms in context.
    browser.runtime.sendMessage({ type: MSG.SHOW_END_SESSION_CONFIRM });
    window.close();
  });
}

/**
 * Render the session card for the currently selected domain.
 * Reads live session state + settings + daily total from storage.
 */
export async function renderSessionCard(domain: string | null, dayResetMinutes: number): Promise<void> {
  liveDomain = domain;
  liveDayReset = dayResetMinutes;
  ensureStorageListener();

  if (heldTicker) { clearInterval(heldTicker); heldTicker = null; }
  const host = document.getElementById('session-card');
  if (!host) return;
  // No real domain (new-tab / settings / extension page) → render nothing. The
  // "No limit on this site" Off card only makes sense for an actual site that's
  // being tracked; here there's no site at all.
  if (!domain) { host.replaceChildren(); return; }

  const data = await browser.storage.local.get([STORAGE.SESSION_STATE, STORAGE.SETTINGS, STORAGE.TRACKED_TIME, STORAGE.SESSION_BUDGET, STORAGE.SESSION_EXTRA]);
  const settings = data[STORAGE.SETTINGS] || { global: {}, domains: {} };
  const domainSettings = settings.domains?.[domain] || {};

  // Limits off for this domain → Off card.
  if (!domainSettings.sessionLimitEnabled) { renderOff(host); return; }

  const state = data[STORAGE.SESSION_STATE] as SessionState | undefined;
  const today = getLocalDateStr(dayResetMinutes);
  const rules = budgetRules(domainSettings);
  const held: Held = {
    // A site that has never started a session has nothing stored: a full row,
    // as the background reads it.
    budget: (data[STORAGE.SESSION_BUDGET]?.[domain] as Budget | undefined) ?? fullBudget(rules, Date.now()),
    rules,
    lengthSec: (domainSettings.sessionLimit || 40) * 60,
    extraSec: data[STORAGE.SESSION_EXTRA]?.[domain] || 0,
  };

  // State from another day doesn't drive the card: rules are on, so it's Idle.
  const session = state && state.date === today ? state.sessions?.[domain] : undefined;
  if (session) {
    const timeHistory = data[STORAGE.TRACKED_TIME]?.timeHistory || {};
    const dailyTotal = domainDailySeconds(timeHistory, today, domain);
    const { remaining } = displayFor(session, dailyTotal);
    // Running only while time remains; otherwise the background has moved on.
    if (remaining > 0) {
      const sc = settings.global?.endSessionShortcut;
      const shortcut = sc === null ? null : (sc || 'Ctrl+E');
      renderActive(host, session, dailyTotal, shortcut, held);
      return;
    }
  }

  renderIdle(host, held);
}
