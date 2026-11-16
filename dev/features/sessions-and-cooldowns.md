# Sessions and the gate

Updated 2026-11-16 01:06, at 2.10.0.

On a site with rules on, browsing happens in sessions. The site holds a number
of sessions that regenerate over time, and each one is started by hand at a
gate.

## Sub-features

- With rules on and no session running, every tab of the site is blurred
  behind the gate: "Start a Session?", a row of dots (one per session the site
  can hold, the one regenerating at half opacity), the session's length, and
  when the next session arrives. Media pauses and anything that starts
  playing while the page is blurred is paused too; fullscreen exits, keys are
  blocked, and the clock is stopped.
- OK starts a 10-second countdown inside the Cancel button ("Starting Session
  / Are you sure?"). Cancel during it goes back to the gate and uses nothing.
  At zero the session starts, the page unblurs and paused media plays again.
- The gate has OK and nothing else: a site with rules on is either in a
  session or behind the gate, so there is nothing to cancel there.
- Sessions regenerate continuously: 3 a day by default (one every 8 hours), up
  to 4 held. There is no daily reset of what a site holds, and no cooldown.
- A session that ends with time left returns the unused share. With less than
  a whole session held, the gate offers a shorter one, down to 5 minutes.
- With nothing to offer, the gate shows "Next Session In" over a clock, and
  becomes the gate again on its own.
- When a session's time runs out the gate comes back.
- A session running when the day resets ends there and returns what it had
  left.
- Each finished session is recorded for [past-day sessions](past-day-sessions.md).

## How to get to it

Automatic once [session rules](session-rules.md) are on.

## Driving it

Preconditions: `npm run build`.

1. `npm run drive -- --limit 1 --seconds 90`: 1-minute sessions. The harness
   presses OK on the gate and waits out the countdown before the stay begins.
2. Expected in the overlay timeline: `gate "Start a Session?"` just after 60s;
   clock verdicts `gate → running → gate`.

Last driven: 2026-11-15, Chrome headless. Gate back at 61s, verdicts `gate →
running → gate`, 60s stored. The wait screen, a partial session
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
- The popup's session card and rules card still describe cooldowns: sessions
  per day and the maximum have no controls yet and run on their defaults.
