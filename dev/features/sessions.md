# Sessions and the gate

Updated 2026-11-19 15:55, at 2.10.0.

On a site with rules on, browsing happens in sessions. Each day brings a fixed
row of them, and each one is started by hand at a gate.

## Sub-features

- With rules on and no session running, every tab of the site is blurred
  behind the gate: "Session Ended", however you got there, a row of dots (one per session a day,
  solid blue for each one left, a blue ring for each used) over "2/3 sessions available", and a "Start Session"
  button. The reserve isn't shown while the row has any left. Once the row is
  used up, the reserve's slots take its place: blue dots inside an orange ring,
  an empty ring for each slot spent, over "2/3 reserve sessions available". The on-page timer shows the length a start would give. Media pauses and anything that starts
  playing while the page is blurred is paused too; fullscreen exits, keys are
  blocked, and the clock is stopped.
- OK starts a countdown inside the Cancel button (10 seconds unless changed
  in [global settings](global-settings.md)) and the title becomes the start question, "Are you sure?" unless changed there. The dialog keeps one height, so Cancel lands exactly where Start Session was, and with a two-line question the dots glide down to stay midway between the title and the button. Cancel during it goes back to the gate and uses nothing.
  At zero the session starts, the page unblurs and paused media plays again.
- When the gate changes screen (ready, countdown, waiting) its text crossfades:
  150ms out, 250ms in. The dots stay put and the countdowns tick without fading.
- The gate has OK and nothing else: a site with rules on is either in a
  session or behind the gate, so there is nothing to cancel there.
- The row is 3 sessions a day by default and is full again at the day reset.
  Only a start or the reset moves it: a start costs exactly one dot.
- Lowering sessions per day or the reserve hides what no longer fits instead of
  removing it, so raising the setting again brings it back.
- A session that ends with time left adds it to the next session, even one on a
  later day. It still cost its whole dot.
- With nothing to offer, the gate shows "Sessions Refill In" over a clock counting
  to the day reset, and becomes the gate again on its own.
- When a session's time runs out the gate comes back.
- The reserve is for when the day runs out (1 session by default). What
  the row has left at the day reset goes to the reserve, up to its size, and a day
  with no visit saves its whole row. A start uses the row first and the reserve only
  once the row is empty. Reserve sessions don't expire. The code calls it the bank.
- A session running when the day resets ends there, and what it had left goes
  to the next session.
- Each finished session is recorded for [past-day sessions](past-day-sessions.md).

## How to get to it

Automatic once [session rules](session-rules.md) are on.

## Driving it

Preconditions: `npm run build`.

1. `npm run drive -- --limit 1 --seconds 90`: 1-minute sessions. The harness
   presses OK on the gate and waits out the countdown before the stay begins.
2. Expected in the overlay timeline: `gate "Session Ended"` just after 60s;
   clock verdicts `gate → running → gate`.

`npm run drive -- daily-row` seeds the stored budget to check the new day, the
cost of a start, the wait and a budget stored by the refilling design.

Last driven: 2026-11-19, Chrome headless. `daily-row`: a new day showed 3 dots
over "3/3 sessions available" with 2 in reserve from the day before, an early end
left 2 dots, a used-up row showed the reserve's 3 slots with 2 filled over "2/3
reserve sessions available" and drained one on Start, an empty row read "Sessions Refill
In" over a clock, and an old budget of 0.4 + 1 in reserve read 2 used, 1 in
reserve. The reset landing while a gate is open was not driven. Not driven on Firefox.

## Gotchas

- Time doesn't count at the gate.
- Listeners are registered before the stored state is read. Until it is, the
  clock verdict is `loading` and `syncGate` waits, so a tab reporting in early
  is neither counted nor gated on empty state.
- What a site holds is stored under `webTimeSessionBudget` as `{ used, bank, day }`,
  apart from the day's session state, because it has to survive the day reset.
  `readBudget` also reads the `{ sessions, at, bank }` stored while sessions
  refilled through the day.
- A session with time added is stored as the full length with a `carryover`.
  Its `baseLength` has to equal the setting, or the next settings change reads
  the difference as a length change and resizes it to full.
- The popup's session card is titled with the session's number and shows the time left with "Sessions refill in" beside
  it, the same row of dots, and "+1 in reserve" when the reserve holds a whole
  session, ticking while it is open. The card fits the panel with no scroll:
  the percent in its title is the share left, so there is no "left of" line. Only the row and that line tick: re-rendering the
  card each second would replace the End button under a click.

## Calls

- 2026-11-18 19:26, 2.10.0. **A session running at the day reset ends there.** Carrying it across
  looks like the obvious fix. The owner chose the ending so that "every day the
  first thing you see" is the gate. Its unused time still goes to the next session.
- 2026-11-19 15:35, 2.10.0. **A fixed row each day, not a steady refill.** Sessions used to come back one
  at a time through the day. In use that was "way higher cognitive load to ration
  yourself": the count rose on its own and the next few sessions couldn't be
  predicted. Seeing the supply go down by exactly one per session is what
  encourages budgeting, and the reserve softens running out. Ending early costs the
  whole dot too, since the minutes go to the next session. Applies *Saving pays later*.
- 2026-11-19 15:35, 2.10.0. **The gate shows the reserve only once the row is used up.** Showing it beside
  the row looks like the obvious way to make saving visible. The owner wants it
  "more like a secret menu item... like the backup reserves. they shouldn't be
  advertised on the thing you see every session." The popup still shows it.
  When it does show, it replaces the row, and its slots stay as empty rings once
  spent. The line under the dots gives the count because, in the owner's
  words, not everyone can count circles at a glance, but anyone can read a
  number.
