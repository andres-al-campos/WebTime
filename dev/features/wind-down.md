# Wind-down

Updated 2026-11-10 21:11, at 2.10.0.

The last 60 seconds of a session: a thin bar across the top of the page drains
to nothing and the page darkens, up to 30%.

## Sub-features

- Shown on every tab of the site.
- The bar is the on-page timer drawn as a line: it pauses when the clock
  pauses, and fades out if time is added and more than a minute is left.
- Clicks pass through; video controls stay usable. Shown above fullscreen video.

## How to get to it

Automatic in the final minute of a session.

## Driving it

Preconditions: `./build.sh`.

`npm run drive -- wind-down` (~45s): a 1-minute session, which is all
wind-down. It checks the overlay appears and the dim deepens, then raises the
session to 2 minutes and checks the overlay fades out and stays gone. To watch it hand
over to the blocker, `npm run drive -- --limit 1 --seconds 70`.

Last driven: 2026-11-10, Chrome headless. Wind-down from 2s, dim 10% at 21s;
raised to 2 minutes, opacity eased 1.00 → 0 over ~400ms, then hidden, and it
stayed hidden. The blocker took over at 65s on a 1-minute session. The draining
bar's width was not read.

## Gotchas

- With a 1-minute session the whole session is wind-down.
- It used to run on its own local deadline and kept draining while the clock
  was paused. `test/wind-down-wiring.test.mjs` keeps it reading the timer.
