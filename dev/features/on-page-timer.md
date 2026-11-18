# On-page timer

Updated 2026-11-18 15:21, at 2.10.0.

A small timer in the top-right corner of every tracked page. With a session
running it counts down the session, and at the gate it shows how long the next
session would run; otherwise it shows today's total on this site.

## Sub-features

- Session view: `⏱ 12:34`, time left in the current session. At the gate it
  holds still on the length a start would give, unused time included.
- Daily view: `12:34` (or `1:02:03` past an hour), today's total on the site.
  Shown when the site has no session rules, or at the gate with nothing to start.
- Click the timer during a session to see today's total for 5 seconds; clicking
  again goes back to the session at once.
- Hidden until the first update arrives, and hidden for good in a tab whose
  content script was orphaned by an extension reload (until the tab reloads).
- Stays above fullscreen video and above WebTime's own blur.

## How to get to it

Open any http(s) page.

## Driving it

Preconditions: `./build.sh` has run.

1. `npm run drive`
2. Expected: `timer: visible "00:15"` for a 15-second run on a site with no
   session rules (daily view).

`npm run drive -- end-early` checks the session view and the preview at the
gate. Not yet driven: the click-to-peek.

Last driven: 2026-10-06, Chrome (headless). Output: `timer: visible "00:15"`.

## Gotchas

- The timer only renders numbers the background sends; it doesn't count on its
  own. A dead worker freezes it until the worker comes back.
- After reloading the extension, open tabs keep their old content script with
  a dead connection. It hides its timer rather than reloading the tab, because
  reloading every tab can loop.
