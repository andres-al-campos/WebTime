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

`npm run drive -- average-popup` (~1 min): seeds 7 previous days at 60s each
for `localhost` and turns rules on, so the popup is due at 48s. It checks the
clock holds while the popup is up and runs again after Continue.

Last driven: 2026-10-07, Chrome headless. Popup at 48s with the seven 1m days,
verdict `average-popup` and the timer held at `⏱ 09:13`; after Continue,
verdict `running` and the timer moving.

## Gotchas

- The rules-on and full-week requirements make it rare; a missing popup is
  usually one of those, not a bug.
