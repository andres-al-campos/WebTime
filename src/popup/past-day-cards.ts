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
 * Nothing is rounded here. The settings stepper takes whole minutes and whole
 * seconds, so the increment is a whole number of seconds by the time it reaches
 * cooldownLength(), and the recorded total is an exact multiple of it. Clock
 * format for both, since the increment is settable to the second.
 */
function cooldownPhrase(cooldownSec: number, sessionNum: number): string {
  if (cooldownSec <= 0) return 'no cooldown';
  // Session 1's cooldown IS the increment; "x × 1 = x" is noise.
  if (sessionNum <= 1) return `${formatClock(cooldownSec)} cooldown`;
  const increment = cooldownSec / sessionNum;
  return `${formatClock(increment)} × ${sessionNum} = ${formatClock(cooldownSec)}`;
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
