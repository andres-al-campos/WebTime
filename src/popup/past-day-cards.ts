// Past-day session cards: one read-only card per finished session on the
// selected day. Today's panel is untouched by this file — it keeps the live
// session card, which is an interactive ledger rather than a summary.
//
// Everything here is derived from SessionRecord tuples that the background
// wrote when each session ended. Nothing is recomputed from current settings:
// the recorded cooldown and effective length are facts about *then*, and
// re-deriving them would let a settings change today rewrite last week.
import { formatDuration } from '../shared/utils.js';
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
    el('span', '', cooldownSec > 0 ? `${formatDuration(cooldownSec)} cooldown` : 'no cooldown'),
    el('span', 'run', `${formatDuration(runningTotal)} total`),
  );

  const card = el('div', 'card');
  card.append(body, foot);
  return card;
}

/** The day's cards, oldest first. Empty array when the day has no sessions. */
export function renderPastDayCards(records: SessionRecord[]): HTMLElement[] {
  const totals = runningTotals(records);
  return records.map((r, i) => sessionCard(r, i, totals[i]));
}

/** The "← Back to today" button appended to the usage card on a past day. */
export function backToTodayButton(onClick: () => void): HTMLElement {
  const btn = document.createElement('button');
  btn.className = 'usage-back';
  btn.textContent = '← Back to today';
  btn.addEventListener('click', onClick);
  return btn;
}
