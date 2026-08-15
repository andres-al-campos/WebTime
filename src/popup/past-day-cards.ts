// Past-day session cards: one read-only card per finished session on the
// selected day. Today's panel is untouched by this file — it keeps the live
// session card, which is an interactive ledger rather than a summary.
//
// Everything here is derived from SessionRecord tuples that the background
// wrote when each session ended. Nothing is recomputed from current settings:
// the recorded cooldown and effective length are facts about *then*, and
// re-deriving them would let a settings change today rewrite last week.
import { formatDuration, formatClock } from '../shared/utils.js';
import { runningTotals } from '../shared/session-history.js';
import type { SessionRecord, SessionEndState } from '../shared/session-history.js';

/** Tag class + label per end state. */
const TAGS: Record<SessionEndState, { cls: string; label: string }> = {
  completed: { cls: 'done', label: 'completed' },
  early: { cls: 'early', label: 'ended early' },
  dayEnded: { cls: 'dayend', label: 'day ended' },
};

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The cooldown as the arithmetic that produced it: "4:50 × 3 = 14:30".
 *
 * cooldownLength() is `sessionNum * increment`, so dividing the recorded total
 * by the session number recovers the increment. It is a per-domain setting the
 * user can change mid-day, which is why the product is stored rather than the
 * factors — two cards from the same day can legitimately show different ones.
 *
 * The increment can be a genuine half-second: it is stored in MINUTES, and
 * values not written by the current minutes/seconds stepper are reachable (a
 * stored 4.375 min is 262.5s — real data, not float noise). formatClock floors,
 * so printing it plainly gives "4:22 × 4 = 17:30" for a true 4:22.5 — visibly
 * wrong arithmetic. Show the tenth when there is one, so the line multiplies
 * out on screen; the total is exact and stays in clock format.
 */
export function cooldownPhrase(cooldownSec: number, sessionNum: number): string {
  if (cooldownSec <= 0) return 'no cooldown';
  // Session 1's cooldown IS the increment; "x × 1 = x" is noise.
  if (sessionNum <= 1) return `${formatClock(cooldownSec)} cooldown`;
  const increment = cooldownSec / sessionNum;
  const shown = formatIncrement(increment);
  // A repeating fraction (thirds, sixths) cannot be written in one decimal, so
  // the printed factor would not multiply back to the printed total. Show the
  // total alone rather than an equation that visibly fails to hold.
  if (Math.abs(parseIncrement(shown) * sessionNum - cooldownSec) > 0.001) {
    return `${formatClock(cooldownSec)} cooldown`;
  }
  return `${shown} × ${sessionNum} = ${formatClock(cooldownSec)}`;
}

/** Seconds back out of an "m:ss.s" string, to check it multiplies out. */
function parseIncrement(shown: string): number {
  const [mins, secs] = shown.split(':');
  return Number(mins) * 60 + Number(secs);
}

/**
 * An increment as m:ss, keeping one decimal on the seconds when it has a
 * fractional part. "4:22.5" rather than a floored "4:22" that would make the
 * card's multiplication read false.
 */
function formatIncrement(seconds: number): string {
  if (Number.isInteger(seconds)) return formatClock(seconds);
  const mins = Math.floor(seconds / 60);
  const secs = seconds - mins * 60;
  // One decimal, with no trailing ".0" — that case is Number.isInteger above.
  const shown = secs.toFixed(1).padStart(4, '0');
  return `${mins}:${shown}`;
}

/** One finished session: N, used/length + end tag, a fill bar, cooldown + running total. */
function sessionCard(record: SessionRecord, index: number, runningTotal: number): HTMLElement {
  const [used, effectiveLength, cooldownSec, endState] = record;

  const num = el('span', 'cnum', `Session ${index + 1}`);

  const val = el('span', 'cval');
  const usedEl = document.createElement('b');
  usedEl.textContent = formatDuration(used);
  val.append(usedEl, ` / ${formatDuration(effectiveLength)} `);
  const tag = TAGS[endState];
  if (tag) val.append(el('span', `tag ${tag.cls}`, tag.label));

  const row = el('div', 'crow');
  row.append(num, val);

  // A zero-length session would divide by zero; it also has nothing to show.
  const pct = effectiveLength > 0 ? Math.min(100, (used / effectiveLength) * 100) : 0;
  const fill = el('div', 'fill');
  fill.style.width = `${pct}%`;
  const track = el('div', 'track');
  track.append(fill);

  const body = el('div', 'cbody');
  body.append(row, track);

  const foot = el('div', 'cfoot');
  foot.append(
    el('span', '', cooldownPhrase(cooldownSec, index + 1)),
    el('span', 'run', `${formatDuration(runningTotal)} total`),
  );

  const card = el('div', 'card');
  card.append(body, foot);
  return card;
}

/** The day's cards, oldest first, or a single empty state.
 *
 *  An empty day is permanent, not a loading state: every day before session
 *  history started recording has none, and so does any day the site was open
 *  without a session running. The panel says so rather than leaving a gap
 *  under the usage card, which reads as a failed render. The usage card above
 *  still shows the day's time, so "no sessions" is not "no data". */
export function renderPastDayCards(records: SessionRecord[]): HTMLElement[] {
  if (records.length === 0) return [emptyState()];
  const totals = runningTotals(records);
  return records.map((r, i) => sessionCard(r, i, totals[i]));
}

/** Shown in place of the cards when a day recorded no sessions. */
function emptyState(): HTMLElement {
  return el('div', 'past-day-empty', 'No sessions recorded on this day.');
}

/** The "Today →" button appended to the usage card on a past day.
 *
 *  The arrow points forward because that is the direction of travel: from a
 *  past day to the present. A back-arrow would read as navigation while the
 *  word next to it says the opposite in time. */
export function backToTodayButton(onClick: () => void): HTMLElement {
  const btn = document.createElement('button');
  btn.className = 'usage-back';
  btn.textContent = 'Today →';
  btn.addEventListener('click', onClick);
  return btn;
}
