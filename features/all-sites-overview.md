# All-sites overview

The popup's "All sites" page: how much time you spent browsing each day, and
on what.

## Sub-features

- Daily bar chart of total time across all sites, 30 days at a time, with a
  7-day moving average line.
- Scroll back through older days with the mouse wheel or the arrow keys on the
  chart (only when there are more than 30 days).
- Hover a bar to preview that day; click it to lock the selection; click it
  again or off the bars to unlock.
- "Usage breakdown" card for the selected day: total, % above or below the
  7-day average, and a bar per site.
- Click a site's row to open the [site view](site-view.md) for that site.

## How to get to it

Toolbar icon → popup opens on the site view → "◂ All sites" at top left.

## Driving it

Preconditions: `./build.sh`; some stored history (drive a page first, or write
`trackedTime` from the worker).

1. Open `chrome-extension://<id>/popup/popup.html` in a tab.
2. Click "◂ All sites".
3. Expected: a bar for today; the breakdown lists `localhost` with its time.

Not yet proven: `drive.mjs` doesn't open the popup yet.

## Gotchas

- A hidden legacy pie-chart canvas is still in the page and still updated on
  every selection, so the chart code doesn't crash. Dormant; marked for
  deletion.
- With no history at all the popup shows only "No tracking data available yet".
