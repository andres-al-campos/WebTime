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

Preconditions: `./build.sh`; rules on for `localhost` with a session long
enough to pass the first nudge, and "Nudge every" at 1.

1. Stay on the page a little over a minute.
2. Expected: the timer element gets `transform: scale(7)` briefly; the worker
   logs a nudge.

Not yet proven.

## Gotchas

- Nudges used to follow a golden-ratio schedule that tightened toward the end
  of a session. That was replaced by the fixed interval; the background still
  calls it `checkPhiNudges` and logs "φ-nudge".
