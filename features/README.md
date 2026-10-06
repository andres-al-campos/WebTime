# WebTime features

What a user can do with WebTime, how to reach it, and how to drive it. Read
this before adding anything: if it's already here, extend it instead of
building it again.

| Feature | File | Platforms | Driveable headless? |
|---|---|---|---|
| Time tracking | [time-tracking.md](time-tracking.md) | Firefox, Chrome | Yes, Chrome (2026-10-06) |
| On-page timer | [on-page-timer.md](on-page-timer.md) | Firefox, Chrome | Yes, Chrome (2026-10-06) |
| All-sites overview | [all-sites-overview.md](all-sites-overview.md) | Firefox, Chrome | Not yet proven |
| Site view | [site-view.md](site-view.md) | Firefox, Chrome | Not yet proven |
| Session rules | [session-rules.md](session-rules.md) | Firefox, Chrome | Not yet proven |
| Sessions and cooldowns | [sessions-and-cooldowns.md](sessions-and-cooldowns.md) | Firefox, Chrome | Not yet proven |
| End session early | [end-session-early.md](end-session-early.md) | Firefox, Chrome | Not yet proven |
| Nudges | [nudges.md](nudges.md) | Firefox, Chrome | Not yet proven |
| Wind-down | [wind-down.md](wind-down.md) | Firefox, Chrome | Not yet proven |
| 7-day average popup | [average-popup.md](average-popup.md) | Firefox, Chrome | Not yet proven |
| Past-day sessions | [past-day-sessions.md](past-day-sessions.md) | Firefox, Chrome | Not yet proven |
| Global settings | [global-settings.md](global-settings.md) | Firefox, Chrome | Not yet proven |
| Your data | [your-data.md](your-data.md) | Firefox, Chrome | Not yet proven |

## What counts as a feature

Something a user sets out to do, or meets, with its own way in: a page
surface, a popup view, a card, a shortcut. Things you only reach inside one of
those are sub-features and live in that feature's file. The Chrome-only
keep-alive and the storage formats are plumbing, not features; they appear in
Gotchas where they bite.

Every feature ships on both browsers from one source. "Firefox, Chrome" means
the same code runs on both, not that both have been driven.

## Each file has

- **Sub-features**: what a user can do inside it, including limits.
- **How to get to it**: the user's path.
- **Driving it**: preconditions, then steps and what you can observe. If it
  can't be driven headless yet, the reason is the to-do.
- **Gotchas**: what has bitten us or will.

Claims describe behavior, not code locations, except where the location is the
point.

## Keeping it current

Change a feature's file in the same commit that changes the feature. A new
feature gets a file and a row here. After driving one, update its row to
"Yes, <browser> (YYYY-MM-DD)" and its "Last driven" line.

## Driving conventions

- **Run the project:** `./build.sh`. It refreshes `dist-chrome/` and
  `extension/`; the harness loads `dist-chrome/` and builds nothing itself.
- **Drive:** `npm run drive` loads `dist-chrome/` into Playwright's Chromium
  (new headless mode), serves a page on a free localhost port, moves the mouse
  on it for 15s (`--seconds N`), and prints the clock verdicts, the timer text
  and the stored seconds for `localhost`. `--headed` shows the window.
- **Doctor:** `npm run drive -- --doctor`. Prints `✓ doctor: stack up, clock
  runs on a tracked page` when the build loads, the worker starts and the clock
  reaches `running`. Verdicts come from debug logging, so a `release.sh` build
  reports none.
- **Ports and users:** the harness picks its own port; there is no sign-in and
  no test user. Each run uses a throwaway profile, so stored data starts empty.
- **Browser binary:** Playwright is pinned to 1.61.0, whose Chromium is
  revision 1228. On a machine without it, `npx playwright install chromium`.
- **Firefox:** no headless harness. Drive by hand: `npx web-ext run
  --source-dir extension`, or load `extension/manifest.json` from
  `about:debugging`. Firefox's persistent background hides fewer bugs than
  Chrome's keep-alive, so a change to the clock wants both.
- **Extending the harness:** settings can be written from the worker
  (`worker.evaluate(() => chrome.storage.local.set(...))`) followed by a
  `SETTINGS_UPDATED` message, and the popup opens as a normal tab at
  `chrome-extension://<id>/popup/popup.html` (the id is in the worker URL).
  Most "Not yet proven" rows need only that.
