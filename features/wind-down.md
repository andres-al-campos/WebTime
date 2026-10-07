# Wind-down

The last 60 seconds of a session: a thin bar across the top of the page drains
to nothing and the page darkens, up to 30%.

## Sub-features

- Shown on every tab of the site.
- Keeps moving on its own deadline if the background stops sending updates.
- Clicks pass through; video controls stay usable. Shown above fullscreen video.

## How to get to it

Automatic in the final minute of a session.

## Driving it

Preconditions: `./build.sh`.

1. `npm run drive -- --limit 1 --seconds 60`. A 1-minute session is all
   wind-down.
2. Expected in the overlay timeline: wind-down from the start, the page
   dimming in 10% steps.

Last driven: 2026-10-07, Chrome headless. Wind-down from 1s, dim 10% at 21s and
20% at 41s; the blocker replaced it at 62s. The draining bar was not read.

## Gotchas

- With a 1-minute session the whole session is wind-down.
