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

Preconditions: `./build.sh`.

1. `npm run drive -- --limit 1 --cooldown 0.25 --seconds 100`: 1-minute
   sessions, a 15s cooldown after session 1.
2. Expected in the overlay timeline: the blocker with "Session 1 Ended / 0:15
   cooldown" just after 60s, gone 15s later; clock verdicts `running →
   cooldown → running`; the timer counting down session 2.

Last driven: 2026-10-07, Chrome headless. Blocker at 62s, cleared at 77s,
verdicts `running → cooldown → running`, timer `⏱ 00:37` at 100s (23s into
session 2). Later sessions' longer cooldowns (N × step) not driven.

## Gotchas

- Time doesn't count during a cooldown, and the next session is anchored at
  the daily total when the cooldown fired, so cooldown time never eats into it.
- With rules on but no session stored yet today, the card shows "No active
  session". It used to fall through to the "No limit on this site" card.
