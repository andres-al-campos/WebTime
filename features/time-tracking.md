# Time tracking

WebTime counts the seconds you spend on each site per day, in the background,
on any http or https page. Nothing to turn on.

## Sub-features

- Per-domain daily totals. `www.` is stripped, so `www.youtube.com` and
  `youtube.com` are one site; other subdomains are separate sites.
- The clock runs only while all of these hold: the browser is the focused app,
  the active tab is an http(s) page, the site isn't in a cooldown, and no
  WebTime dialog (end-session confirm, 7-day average popup) is open on it.
- On top of that it needs either audio playing in the tab, or recent input
  (scroll, key, mouse move within the inactivity timeout, default 30s) while
  the machine isn't idle. A locked screen stops it even with audio playing.
- The day rolls over at the "Day resets at" hour (midnight to 6 AM), not at
  midnight, so late-night use counts toward the previous day.
- Time is saved once a minute and on every site switch. After a Chrome worker
  restart the unsaved gap is credited back to the site it belonged to, unless
  the machine is idle or the browser unfocused at restart.

## How to get to it

Browse. Totals show in the on-page timer and the popup.

## Driving it

Preconditions: `./build.sh` has run.

1. `npm run drive`
2. Expected: `clock verdicts seen: running`, then `✓ tracked 15s on localhost,
   timer showed "00:15"` (±1s).

`npm run drive -- --seconds 0` fails with "No time was recorded", which is the
check that the harness can fail.

Last driven: 2026-10-06, Chrome (Playwright Chromium 1228, headless). Output:
`stored localhost seconds on 2026-10-06: 15`.

## Gotchas

- Whether the clock runs is decided in one place, the ordered gates
  (`src/shared/clock-gates.ts`), and every start/stop goes through it. Two
  past regressions were callers deciding on their own. Audio must be checked
  before OS idle, or videos stop counting after 30s. Both rules are tests
  (`test/clock-gates.test.mjs`, `test/background-wiring.test.mjs`), so
  `./build.sh` fails if either breaks.
- Chrome's keep-alive (an offscreen document, Chrome only) re-derives state
  constantly and hides stale-state bugs that Firefox's persistent background
  shows. Test clock changes on both.
- The background logs every verdict change as `Clock verdict: a -> b` in debug
  builds; that's the first thing to read when time "stops".
- If the stored history was written by a newer build, this build refuses to
  read it and stops saving, so the newer data isn't overwritten.
