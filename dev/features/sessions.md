# Sessions and the gate

Updated 2026-11-18 15:39, at 2.10.0.

On a site with rules on, browsing happens in sessions. The site holds a number
of sessions that regenerate over time, and each one is started by hand at a
gate.

## Sub-features

- With rules on and no session running, every tab of the site is blurred
  behind the gate: "Session Ended", however you got there, a row of dots (one per session a day,
  the one regenerating filled at half strength, every dot with the same ring; banked sessions aren't shown), "Next session refills in", and a button with
  the length it would start ("Start 40:00 Session"). Media pauses and anything that starts
  playing while the page is blurred is paused too; fullscreen exits, keys are
  blocked, and the clock is stopped.
- OK starts a countdown inside the Cancel button (10 seconds unless changed
  in [global settings](global-settings.md)) ("Starting Session
  / Are you sure?"). Cancel during it goes back to the gate and uses nothing.
  At zero the session starts, the page unblurs and paused media plays again.
- The gate has OK and nothing else: a site with rules on is either in a
  session or behind the gate, so there is nothing to cancel there.
- Sessions regenerate continuously: 3 a day by default (one every 8 hours), up
  to a day's worth plus the bank (1 by default), so 4 held. There is no daily reset of what a site holds, and no cooldown.
- Lowering sessions per day or the bank hides what no longer fits instead of
  removing it, so raising the setting again brings it back. Starting a session
  under the lower setting commits it: the row drops by one from what it shows.
- A session that ends with time left adds it to the next session. With less than
  a whole session held, the gate offers a shorter one, down to 5 minutes.
- With nothing to offer, the gate shows "Next Session Refills In" over a clock, and
  becomes the gate again on its own.
- When a session's time runs out the gate comes back.
- The bank is the reserve for when the day runs out. A refill goes to the
  row of dots first and only to the bank when the row is full; a start uses
  the row first, including its last partial session (a shorter session) when
  that is 5 minutes or more. Only when the row holds less than that does a
  whole session come from the bank, and the row's partial dot keeps filling. The two are stored apart
  (`bank` in `webTimeSessionBudget`); a budget stored before that banks
  whatever is over a day's worth.
- A session running when the day resets ends there and returns what it had
  left.
- Each finished session is recorded for [past-day sessions](past-day-sessions.md).

## How to get to it

Automatic once [session rules](session-rules.md) are on.

## Driving it

Preconditions: `npm run build`.

1. `npm run drive -- --limit 1 --seconds 90`: 1-minute sessions. The harness
   presses OK on the gate and waits out the countdown before the stay begins.
2. Expected in the overlay timeline: `gate "Session Ended"` just after 60s;
   clock verdicts `gate → running → gate`.

Last driven: 2026-11-18, Chrome headless. `gate "Session Ended"` at 61s, 60s
stored, timer at the gate `⏱ 01:00`. The wait screen, a partial session
and regeneration over hours were not driven. Not driven on Firefox.

## Gotchas

- Time doesn't count at the gate.
- Listeners are registered before the stored state is read. Until it is, the
  clock verdict is `loading` and `syncGate` waits, so a tab reporting in early
  is neither counted nor gated on empty state.
- What a site holds is stored under `webTimeSessionBudget`, apart from the
  day's session state, because it has to survive the day reset.
- A partial session is stored as the full length with a negative `carryover`.
  Its `baseLength` has to equal the setting, or the next settings change reads
  the difference as a length change and resizes it to full.
- The popup's session card is titled with the session's number and shows the time left with "Next session refills in" beside
  it, the same row of dots, and "+1 banked" when the bank holds a whole
  session, ticking while it is open. The card fits the panel with no scroll:
  the percent in its title is the share left, so there is no "left of" line. Only the row and that line tick: re-rendering the
  card each second would replace the End button under a click.

## Calls

- 2026-11-18 15:15, 2.10.0. **A session running at the day reset ends there.** Sessions refill without
  a daily reset, so carrying it across looks like the obvious fix. The owner
  chose the ending so that "every day the first thing you see" is the gate. Its
  unused time still goes to the next session.
