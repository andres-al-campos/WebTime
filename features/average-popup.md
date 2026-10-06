# 7-day average popup

A one-time check-in when today's time on a site reaches 80% of your trailing
7-day average for it.

## Sub-features

- "N min until your 7-day average" (or "You've reached your 7-day average"),
  the average, and a small bar chart of the last 7 days.
- Pauses media, blocks keys and freezes the clock until you press Continue.
- Once per site per day.

## How to get to it

Automatic, but only on a site that has [session rules](session-rules.md) on,
and only once all 7 days before today have time on that site.

## Driving it

Preconditions: `./build.sh`; seed `trackedTime` with 7 previous days of
`localhost` time (say 60s each), rules on for `localhost`, then drive the page
for ~50s.

1. Expected: `.web-time-average-popup-overlay` appears; clock verdict
   `average-popup` until Continue.

Not yet proven.

## Gotchas

- The rules-on and full-week requirements make it rare; a missing popup is
  usually one of those, not a bug.
