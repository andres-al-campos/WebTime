# Nudges

Updated 2026-11-24 17:38, at 2.10.0.

A brief reminder during a session: the corner timer swells to 7× its size for
half a second while the page blurs and media pauses, then shrinks back.

## Sub-features

- A set number each session ("Nudges per session" in
  [global settings](global-settings.md), default 1), placed at golden-ratio
  fractions of it: 38%, 62%, 76%… of the way through, so they come closer
  together as the end nears. One nudge lands about 11 minutes into a
  30-minute session. Its ⓘ says nudges happen more often as the session gets
  closer to ending.
- Each is shifted by a small random jitter (a twentieth of the session, at
  most 30s), stable within a session.
- None in the first minute or the final 60 seconds (wind-down owns those);
  one that would land there is dropped.
- 0 ("Off") turns nudges off.
- A missed nudge (worker asleep) fires once when it next can, not in a burst.

## How to get to it

Automatic during a session on a site with [session rules](session-rules.md) on.

## Driving it

`npm run drive -- nudges` (~3 min): a 4-minute session with 3 nudges a
session, due at about 92s and 148s (the third falls in the final minute and
is dropped). The harness records each nudge on the page (the timer scaled up)
and counts the worker's nudge log lines; it fails on fewer than 2 by 165s, on
one before 60s, on two less than 30s apart, or if the clock isn't running
afterwards.

Last driven: 2026-11-24, Chrome headless. Nudges at 112s and 172s from the
page opening (the gate's countdown comes first), clock verdict `running`
throughout. Media pausing was not checked (the drive page has none).

## Gotchas

- The setting used to be per site, "Nudge every N minutes". Sessions varied in
  length then; they're one length again, and a count spaced by fraction suits
  every length, where an interval gave a 12-minute session none. Old
  `nudgeInterval` values stay on disk and are never read.
