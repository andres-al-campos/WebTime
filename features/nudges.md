# Nudges

A brief reminder during a session: the corner timer swells to 7× its size for
half a second while the page blurs and media pauses, then shrinks back.

## Sub-features

- Fires every N minutes into a session (the site's "Nudge every", default 20),
  each time shifted by a small random jitter (up to a quarter of the interval,
  at most 30s) that is stable within a session.
- None in the first minute or the final 60 seconds (wind-down owns those).
- 0 disables nudges for the site.
- A missed nudge (worker asleep) fires once when it next can, not in a burst.

## How to get to it

Automatic during a session on a site with [session rules](session-rules.md) on.

## Driving it

`npm run drive -- nudges` (~2 min): a 3-minute session with "Nudge every" at
0.5, so nudges fall due at about 60, 90 and 120s. None can come before 60s or
in the last 60s, so this is the shortest run that shows them. The harness
records each nudge on the page (the timer scaled up) and counts the worker's
nudge log lines; it fails on fewer than 2, on one before 60s, or if the clock
isn't running afterwards.

Last driven: 2026-10-07, Chrome headless. Nudges at 65s, 88s and 123s, three
logged by the worker, clock verdict `running` throughout. Media pausing was
not checked (the drive page has none).

## Gotchas

- Nudges used to follow a golden-ratio schedule that tightened toward the end
  of a session. That was replaced by the fixed interval; the background still
  calls it `checkPhiNudges` and logs "φ-nudge".
