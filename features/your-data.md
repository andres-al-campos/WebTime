# Your data

All data stays in the browser. You can see how much is stored and export it.

## Sub-features

- Settings → "Your data": size and number of days, e.g. `48 KB · 120 days`.
- Export: downloads `webtime-backup-YYYY-MM-DD.json` with tracked time and
  session history, labelled with app name, export time and format versions.
- Storage banner at the top of the popup at 90% of a 10 MB budget, with its
  own Export button.
- If the stored data was written by a newer WebTime, the popup says so,
  disables export and shows no charts, rather than treating the data as empty.

## How to get to it

Popup → gear → "Your data". The banner appears on its own near the limit.

## Driving it

Preconditions: `./build.sh`; some history.

1. Open settings, click Export.
2. Expected: a download named `webtime-backup-<date>.json` whose
   `app` is `WebTime`.

No scenario: a break shows the next time you export. Check by hand with the
steps above when it changes. The near-full banner was checked with seeded
history on 2026-10-07.

## Gotchas

- Nothing prunes tracked time. At Chrome's 10 MB limit saves fail; old days
  are never dropped. The banner used to promise they would be overwritten.
