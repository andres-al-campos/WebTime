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

Preconditions: `./build.sh`; history for some site.

1. Open the popup with that site's tab active.
2. Expected: the site name in the top bar, a chart, the usage card, the
   Session rules card.

Not yet proven. The popup reads the active tab's URL, so a popup opened as its
own tab should see itself and show "No site to show here" (expected from the
code, not tried). The
harness needs to open the popup in a way that keeps the site tab active, or
reach the site view through the all-sites breakdown.

## Gotchas

- On a non-web page (new tab, settings) the view says "No site to show here"
  and shows no cards.
