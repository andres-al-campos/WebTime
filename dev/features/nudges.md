# Nudges

Updated 2026-11-13 11:01, at 2.10.0.

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

`npm run drive -- nudges` (~2.5 min): a 4-minute session with "Nudge every"
at 0.5, so nudges fall due at about 60, 90 and 120s. None can come before 60s
or in the last 60s. The harness records each nudge on the page (the timer
scaled up) and counts the worker's nudge log lines; it fails on fewer than 2 by
140s, on one before 60s, or if the clock isn't running afterwards.

Last driven: 2026-11-13, Chrome headless, 5 runs in a row, all passing. Three
or two nudges each (e.g. 68s, 86s, 124s; 100s, 121s), clock verdict `running`
throughout. Media pausing was
not checked (the drive page has none).

## Gotchas

- Each nudge is jittered by up to a quarter of its interval and dropped, not
  clamped, if that puts it under 60s or in the final minute. So a short
  session can schedule fewer nudges than interval arithmetic suggests. The
  drive used a 3-minute session and failed about a quarter of the time on
  seeds that kept only the 90s nudge.
- Nudges used to follow a golden-ratio schedule that tightened toward the end
  of a session. That was replaced by the fixed interval; the background still
  calls it `checkPhiNudges` and logs "φ-nudge".
