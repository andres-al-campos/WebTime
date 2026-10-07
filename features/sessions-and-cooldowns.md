# Sessions and cooldowns

On a site with rules on, each session lasts its length; when it runs out the
page is blocked for a cooldown that grows with each session.

## Sub-features

- A session starts the first time you browse the site with rules on.
- When it ends, every tab of that site shows a blocker: "Session N Ended", a
  countdown, the math (`3 × 1:30 = 4:30 cooldown`) and a draining bar. Media
  pauses, fullscreen exits, keys are blocked.
- Tabs of the site opened mid-cooldown, or brought back from the background,
  show the same blocker at the right point.
- When the cooldown ends the blocker lifts and the next session starts.
- Live session card in the popup: "Session N · NN% left", time left, the 10%
  bonus and what ending early would add to the next session. During a
  cooldown it shows the cooldown's total length (not a live countdown).
- Each finished session is recorded for [past-day sessions](past-day-sessions.md).

## How to get to it

Automatic once [session rules](session-rules.md) are on. The card is in the
popup's site view.

## Driving it

Preconditions: `./build.sh`; rules on for `localhost` with a 1-minute session
and a short cooldown (see session-rules.md for the headless shortcut).

1. Stay on the page past 60s of counted time.
2. Expected: `.web-time-blocker-overlay` with "Session 1 Ended"; the clock
   verdict changes to `cooldown`; after the cooldown the overlay goes and the
   timer shows the next session's countdown.

Not yet proven.

## Gotchas

- Time doesn't count during a cooldown, and the next session is anchored at
  the daily total when the cooldown fired, so cooldown time never eats into it.
- With rules on but no session stored yet today, the card shows "No active
  session". It used to fall through to the "No limit on this site" card.
