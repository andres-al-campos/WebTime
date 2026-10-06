# On-page timer

A small timer in the top-right corner of every tracked page. With a session
running it counts down the session; otherwise it shows today's total on this
site.

## Sub-features

- Session view: `⏱ 12:34`, time left in the current session.
- Daily view: `12:34` (or `1:02:03` past an hour), today's total on the site.
  Shown when the site has no session rules.
- Click the timer during a session to see today's total for 5 seconds; clicking
  again restarts the 5 seconds.
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

Not yet driven: the session view and the click-to-peek. Both need session
rules set first (see [session-rules.md](session-rules.md)).

Last driven: 2026-10-06, Chrome (headless). Output: `timer: visible "00:15"`.

## Gotchas

- The timer only renders numbers the background sends; it doesn't count on its
  own. A dead worker freezes it until the worker comes back.
- After reloading the extension, open tabs keep their old content script with
  a dead connection. It hides its timer rather than reloading the tab, because
  reloading every tab can loop.
