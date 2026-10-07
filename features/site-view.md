# Site view

The popup's default page: your history on one site, today's usage, and that
site's session controls.

## Sub-features

- Daily bar chart for the site with its own 7-day moving average; wheel or
  arrow keys scroll past 30 days.
- Usage card: this site / all sites for the selected day, and % vs this site's
  7-day average.
- Click a past bar to see that day ([past-day sessions](past-day-sessions.md));
  "Today →" or clicking the bar again returns.
- Holds the [Session rules](session-rules.md) card and the live session card
  ([Sessions and cooldowns](sessions-and-cooldowns.md)) for today.

## How to get to it

Click the toolbar icon on any http(s) page; the popup opens on that site. Or
click a site in the all-sites breakdown. "This site ▸" / "◂ All sites" toggles
between the two pages.

## Driving it

Preconditions: `./build.sh`.

1. `npm run drive -- --popup` (add `--limit 2` to see an active session).
2. Expected: the usage card for `localhost` and the session card are printed;
   with `--limit 2`, "SESSION 1 · 96% LEFT" and the time left.

Last driven: 2026-10-07, Chrome headless. Usage card rendered; session card
showed "No limit on this site" without `--limit` and "SESSION 1 · 96% LEFT,
Time left 1:55" with `--limit 2`. The chart and the top bar were not checked.

## Gotchas

- On a non-web page (new tab, settings) the view says "No site to show here"
  and shows no cards.
