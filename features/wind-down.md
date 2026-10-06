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

Preconditions: `./build.sh`; rules on for `localhost` with a 1-minute session.

1. Start the session and keep the page engaged.
2. Expected: `.web-time-wind-down-overlay` becomes visible and its bar width
   falls toward 0%.

Not yet proven.

## Gotchas

- With a 1-minute session the whole session is wind-down.
