// Live session card for the detail ("This site") view's right panel. NEW in the
// redesign — the old popup only edited session *settings*, never rendered a live
// session. Reads the background's persisted session state from storage and uses
// the pure session-model functions to derive elapsed / remaining / cooldown.
//
// Three states, mirroring the design:
//   Active   — a session is running: elapsed / limit, progress, "End early".
//   Cooldown — session ended, counting down until the next unlocks.
//   Off      — limits disabled for this domain (or no session yet).

import { formatClock, getLocalDateStr } from '../shared/utils.js';
import { displayFor, DEFAULT_NUDGE_INTERVAL_MIN, type ActiveSession } from '../shared/session-model.js';

declare const browser: typeof chrome;

const SESSION_STATE_KEY = 'webTimeSessionState';
const SETTINGS_KEY = 'webTimeSettings';

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
    if (!(SESSION_STATE_KEY in changes) && !(SETTINGS_KEY in changes)) return;
    if (liveDomain === null) return;
    renderSessionCard(liveDomain, liveDayReset).catch(err =>
      console.error('Error re-rendering session card on storage change:', err));
  });
}

interface SessionState {
  date: string;
  sessions: Record<string, ActiveSession>;
  cooldownEndTime: Record<string, number>;
  cooldownTotalSec: Record<string, number>;
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
  cooldownIncrement?: number;     // minutes (may be fractional)
  nudgeInterval?: number;
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
  const data = await browser.storage.local.get('webTimeSettings');
  const settings = data.webTimeSettings || { global: {}, domains: {} };
  if (!settings.domains) settings.domains = {};

  const hasAny = next.sessionLimitEnabled || (next.sessionLimit || 0) > 0 || (next.cooldownIncrement || 0) > 0;
  if (hasAny) {
    settings.domains[domain] = {
      sessionLimitEnabled: next.sessionLimitEnabled || false,
      sessionLimit: (next.sessionLimit || 0) > 0 ? next.sessionLimit : undefined,
      cooldownIncrement: (next.cooldownIncrement || 0) > 0 ? next.cooldownIncrement : undefined,
      nudgeInterval: next.nudgeInterval,
    };
  } else {
    delete settings.domains[domain];
  }
  await browser.storage.local.set({ webTimeSettings: settings });
  browser.runtime.sendMessage({ type: 'SETTINGS_UPDATED' });
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
  min: number; max: number; step: number;
  onChange: (v: number) => void;
  /** Called when a step crosses min/max. Return false to veto the wrap (the
   *  value stays pinned at the edge it tried to cross). */
  onCarry?: (dir: number) => boolean;
  /** Omit the label row — used when several boxes share one external heading
   *  (e.g. the cooldown's minutes+seconds pair sit under a single "Cooldown"). */
  noHead?: boolean;
  /** Word to show instead of "0" — for settings where zero is a STATE, not a
   *  quantity ("Off"), so the box doesn't read as a real interval of zero. The
   *  unit suffix is hidden alongside it. */
  zeroLabel?: string;
}): Stepper {
  const group = el('div', 'sc-stepper-group');
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
  // Snap to the step grid, then round off float dust (0.05 * 13 = 0.650000…1) so
  // neither the display nor the persisted value carries it. 2 decimals covers the
  // finest step (0.05); trailing zeros are dropped so integers read "40" not
  // "40.00".
  const quantize = (v: number) =>
    parseFloat((opts.min + Math.round((v - opts.min) / opts.step) * opts.step).toFixed(2));
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
    const span = opts.max - opts.min + opts.step; // wrap modulus, in step units
    const raw = cur + dir * opts.step;
    if (opts.onCarry && (raw > opts.max || raw < opts.min)) {
      // Past an edge: let the neighbour absorb the carry. If it accepts, wrap
      // within [min,max]; if it vetoes (e.g. minutes already 0), stay put.
      if (opts.onCarry(dir)) {
        cur = ((((raw - opts.min) % span) + span) % span) + opts.min;
      }
    } else {
      cur = Math.max(opts.min, Math.min(opts.max, raw));
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
      cur = quantize(Math.max(opts.min, Math.min(opts.max, parsed)));
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
 * limit / cooldown / nudge steppers. Persists per-domain on every change.
 */
export async function renderSessionSettingsCard(
  domain: string | null,
  // Reset time no longer needed here — the live card re-renders reactively via
  // the storage listener rather than being re-rendered from persist().
  _dayResetTime = 0,
): Promise<void> {
  const host = document.getElementById('session-settings-card');
  if (!host) return;
  if (!domain) { host.replaceChildren(); return; }

  const data = await browser.storage.local.get('webTimeSettings');
  const settings = data.webTimeSettings || { global: {}, domains: {} };
  const d: DomainLimits = settings.domains?.[domain] || {};

  // Working copy persisted on each control change.
  const cur: Required<DomainLimits> = {
    sessionLimitEnabled: d.sessionLimitEnabled || false,
    sessionLimit: d.sessionLimit || 40,
    cooldownIncrement: d.cooldownIncrement || 5,
    nudgeInterval: d.nudgeInterval ?? DEFAULT_NUDGE_INTERVAL_MIN,
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

  // body: two two-up rows — [session length | nudges], then the cooldown
  // increment split into [minutes | seconds] steppers.
  const body = el('div', 'sc-settings-body');

  // Cooldown is stored as one fractional-minutes number; the two steppers each
  // own a part and recombine on change. Read once so they share a baseline.
  let coolMin = Math.floor(cur.cooldownIncrement);
  let coolSec = Math.round((cur.cooldownIncrement - coolMin) * 60);
  const persistCooldown = () => { cur.cooldownIncrement = coolMin + coolSec / 60; persist(); };

  const rowOne = el('div', 'sc-settings-twoup');
  rowOne.append(
    stepper({
      label: 'Session length', value: cur.sessionLimit, unit: 'min',
      min: 1, max: 240, step: 1,
      onChange: v => { cur.sessionLimit = v; persist(); },
    }).el,
    stepper({
      // Minutes between nudges, not a count: session length varies per session
      // now, so "how many" has no fixed meaning. 0 disables them for this domain.
      label: 'Nudge every', value: cur.nudgeInterval, unit: 'min',
      min: 0, max: 120, step: 1, zeroLabel: 'Off',
      onChange: v => { cur.nudgeInterval = v; persist(); },
    }).el
  );

  // Minutes + seconds steppers. Seconds runs 0/15/30/45 and rolls into minutes
  // when it crosses an edge — ▲ at 45s bumps a minute, ▼ at 0s borrows one
  // (vetoed when already at 0m so the cooldown can't go negative). Both boxes
  // sit under ONE "Cooldown" heading (the units m/s carry their roles), so the
  // pair reads as a single setting without a separate "Cooldown secs" label.
  const minStepper = stepper({
    label: 'Cooldown', value: coolMin, unit: 'm', noHead: true,
    min: 0, max: 120, step: 1,
    onChange: v => { coolMin = v; persistCooldown(); },
  });
  const secStepper = stepper({
    // max is one step below a minute, so the seconds run 0..55 and then carry
    // into the minutes box rather than showing a 60 that means the same as 1m.
    label: 'Cooldown', value: coolSec, unit: 's', noHead: true,
    min: 0, max: 55, step: 5,
    onChange: v => { coolSec = v; persistCooldown(); },
    onCarry: dir => {
      if (dir < 0 && coolMin <= 0) return false; // can't borrow below 0m
      coolMin = Math.min(120, Math.max(0, coolMin + dir));
      minStepper.setValue(coolMin);
      return true; // persisted by the seconds onChange that follows
    },
  });

  // One labelled group: "Cooldown" heading over the [m][s] box pair.
  const coolGroup = el('div', 'sc-stepper-group sc-cooldown-group');
  const coolHead = el('div', 'sc-stepper-head');
  coolHead.append(el('span', 'sc-stepper-label', 'Base cooldown'));
  const coolBoxes = el('div', 'sc-cooldown-boxes');
  coolBoxes.append(minStepper.el, secStepper.el);
  coolGroup.append(coolHead, coolBoxes);

  const rowTwo = el('div', 'sc-settings-twoup');
  rowTwo.append(coolGroup);
  body.append(rowOne, rowTwo);

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

/** Idle — limits ON but no session running yet (e.g. not the active tab today). */
function renderIdle(host: HTMLElement, limitMinutes: number): void {
  const card = el('div', 'sc-card sc-off');
  card.append(
    el('div', 'sc-off-title', 'No active session'),
    el('div', 'sc-off-sub',
      `A ${limitMinutes}-minute session starts when you browse this site.`)
  );
  host.replaceChildren(card);
}

/** Active session state. */
function renderActive(host: HTMLElement, s: ActiveSession, dailyTotal: number, shortcut: string | null): void {
  const { sessionTime, sessionLimitSeconds } = displayFor(s, dailyTotal);
  const remaining = Math.max(0, sessionLimitSeconds - sessionTime);
  // Percent LEFT (not spent) so the bar's gone-but-not-forgotten job — proportion
  // at a glance — is carried by a number that moves the SAME direction as the
  // countdown timer (down), instead of a bar that filled up against it.
  const pctLeft = sessionLimitSeconds > 0 ? Math.round((remaining / sessionLimitSeconds) * 100) : 0;
  // endEarly() rolls the FULL remaining into the next session as carryover, plus
  // a 10% grace bonus on top of it (computeGraceSeconds) — always, tracking time
  // left rather than the session's pedigree.
  const grace = Math.floor(remaining * 0.1);
  const rollover = remaining + grace;
  // Near-the-end warmth lives on the percent now that the bar is gone.
  const leftColor = pctLeft < 15 ? 'var(--warn)' : 'var(--good)';

  const card = cardShell();

  // Title carries the live "· NN% left" — the old elapsed/limit line was
  // redundant with the ledger's "time left" below, so it's gone.
  const head = el('div', 'sc-head');
  const title = el('span', 'sc-title', `Session ${s.sessionNum}`);
  const pctEl = el('span', 'sc-title-pct', ` · ${pctLeft}% left`);
  pctEl.style.color = leftColor;
  title.append(pctEl);
  head.append(title);

  // What "End early" does, as a ledger: quiet label on the left, value
  // right-aligned so the figures stack into a column that visibly adds up.
  // A divider sits before the total, whose value is the green "what you keep".
  const breakdown = el('div', 'sc-breakdown');
  const row = (label: string, value: string, opts: { op?: string; total?: boolean } = {}): HTMLElement => {
    const r = el('div', `sc-breakdown-row${opts.total ? ' is-total' : ''}`);
    r.append(el('span', 'sc-breakdown-label', label));
    const val = el('span', 'sc-breakdown-val');
    if (opts.op) val.append(el('span', 'sc-breakdown-op', `${opts.op} `));
    val.append(document.createTextNode(value));
    r.append(val);
    return r;
  };
  breakdown.append(row('Time left', formatClock(remaining)));
  // Always show the bonus row so the ledger reads as a complete sum, even when
  // this session was already grace-extended (grace can't compound → +0:00).
  breakdown.append(row('10% bonus', formatClock(grace), { op: '+' }));
  breakdown.append(el('div', 'sc-breakdown-rule'));
  breakdown.append(row(`Time added to Session ${s.sessionNum + 1}`, formatClock(rollover), { total: true }));

  const btn = el('button', 'sc-btn');
  btn.id = 'session-end-early-btn';
  btn.textContent = shortcut ? `End session (${shortcut})` : 'End session early';

  card.append(head, breakdown, btn);
  host.replaceChildren(card);

  btn.addEventListener('click', () => {
    // Don't end immediately — an accidental click would be unrecoverable. Ask the
    // active tab to show the confirmation overlay (same as the keyboard shortcut),
    // then close the popup so the user confirms in context.
    browser.runtime.sendMessage({ type: 'SHOW_END_SESSION_CONFIRM' });
    window.close();
  });
}

/** Cooldown state. */
function renderCooldown(host: HTMLElement, s: ActiveSession, endTime: number, totalSec: number): void {
  // The session cooling down is the one before the (next) stored session.
  const endedNum = Math.max(1, s.sessionNum - 1);

  const card = cardShell();

  const head = el('div', 'sc-head');
  head.append(el('span', 'sc-title', `Session ${endedNum} ended`));

  // Show the TOTAL cooldown length, not a live countdown — this panel doesn't
  // tick in real time, so a frozen remaining figure would read as wrong the
  // moment it's stale. The fixed duration is always accurate.
  void endTime;
  card.append(
    head,
    el('div', 'sc-time', formatClock(totalSec)),
    el('div', 'sc-sub', `cooldown before Session ${s.sessionNum} unlocks`)
  );
  host.replaceChildren(card);
}

/**
 * Render the session card for the currently selected domain.
 * Reads live session state + settings + daily total from storage.
 */
export async function renderSessionCard(domain: string | null, dayResetTime: number): Promise<void> {
  liveDomain = domain;
  liveDayReset = dayResetTime;
  ensureStorageListener();

  const host = document.getElementById('session-card');
  if (!host) return;
  // No real domain (new-tab / settings / extension page) → render nothing. The
  // "No limit on this site" Off card only makes sense for an actual site that's
  // being tracked; here there's no site at all.
  if (!domain) { host.replaceChildren(); return; }

  const data = await browser.storage.local.get([SESSION_STATE_KEY, 'webTimeSettings', 'trackedTime']);
  const settings = data.webTimeSettings || { global: {}, domains: {} };
  const domainSettings = settings.domains?.[domain] || {};

  // Limits off for this domain → Off card.
  if (!domainSettings.sessionLimitEnabled) { renderOff(host); return; }

  const state = data[SESSION_STATE_KEY] as SessionState | undefined;
  const today = getLocalDateStr(dayResetTime);

  // Stale (different day) state shouldn't drive the card.
  if (!state || state.date !== today) { renderOff(host); return; }

  const session = state.sessions?.[domain];
  const limitMinutes = domainSettings.sessionLimit || 40;

  // Cooldown takes precedence — there's a future cooldown end for this domain.
  const cooldownEnd = state.cooldownEndTime?.[domain] || 0;
  if (session && cooldownEnd > Date.now()) {
    renderCooldown(host, session, cooldownEnd, state.cooldownTotalSec?.[domain] || 0);
    return;
  }

  if (session) {
    const timeHistory = data.trackedTime?.timeHistory || {};
    const dailyTotal = domainDailySeconds(timeHistory, today, domain);
    const { remaining } = displayFor(session, dailyTotal);
    // Genuinely running only while time remains; otherwise the background has
    // moved on (cooldown just ended or a new session is pending) — show Idle.
    if (remaining > 0) {
      const sc = settings.global?.endSessionShortcut;
      const shortcut = sc === null ? null : (sc || 'Ctrl+E');
      renderActive(host, session, dailyTotal, shortcut);
      return;
    }
  }

  // Limits on, but nothing active for this domain right now.
  renderIdle(host, limitMinutes);
}
