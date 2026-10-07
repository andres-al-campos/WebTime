# WebTime features

What a user can do with WebTime, how to reach it, and how to drive it. Read
this before adding anything: if it's already here, extend it instead of
building it again.

| Feature | File | Platforms | Driveable headless? |
|---|---|---|---|
| Time tracking | [time-tracking.md](time-tracking.md) | Firefox, Chrome | Yes, Chrome (2026-10-06) |
| On-page timer | [on-page-timer.md](on-page-timer.md) | Firefox, Chrome | Yes, Chrome (2026-10-06) |
| All-sites overview | [all-sites-overview.md](all-sites-overview.md) | Firefox, Chrome | Not yet proven |
| Site view | [site-view.md](site-view.md) | Firefox, Chrome | Yes, Chrome (2026-10-07) |
| Session rules | [session-rules.md](session-rules.md) | Firefox, Chrome | Not yet proven |
| Sessions and cooldowns | [sessions-and-cooldowns.md](sessions-and-cooldowns.md) | Firefox, Chrome | Not yet proven |
| End session early | [end-session-early.md](end-session-early.md) | Firefox, Chrome | Not yet proven |
| Nudges | [nudges.md](nudges.md) | Firefox, Chrome | Not yet proven |
| Wind-down | [wind-down.md](wind-down.md) | Firefox, Chrome | Not yet proven |
| 7-day average popup | [average-popup.md](average-popup.md) | Firefox, Chrome | Not yet proven |
| Past-day sessions | [past-day-sessions.md](past-day-sessions.md) | Firefox, Chrome | Not yet proven |
| Global settings | [global-settings.md](global-settings.md) | Firefox, Chrome | Not yet proven |
| Your data | [your-data.md](your-data.md) | Firefox, Chrome | Not yet proven |

Each row is something you do or run into in WebTime. Smaller things live
inside their feature's file. "Firefox, Chrome" means the same code runs on
both, not that both have been driven.

## Driving conventions

- **Run the project:** `./build.sh`. It refreshes `dist-chrome/` and
  `extension/`; the harness loads `dist-chrome/` and builds nothing itself.
- **Drive:** `npm run drive` loads `dist-chrome/` into Playwright's Chromium
  (new headless mode), serves a page on a free localhost port, moves the mouse
  on it for 15s (`--seconds N`), and prints the clock verdicts, the timer text
  and the stored seconds for `localhost`. `--headed` shows the window.
  `--limit M` turns session rules on for `localhost` with M-minute sessions
  first. `--popup` then opens the popup and prints its usage and session cards.
- **Doctor:** `./build.sh check` runs the tests, then `npm run drive --
  --doctor`, which prints `✓ doctor: stack up, clock
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
- **Extending the harness:** write settings from the worker
  (`worker.evaluate(() => chrome.storage.local.set(...))`); the background
  reads them when it needs them. The popup opens as a tab at
  `chrome-extension://<id>/popup/popup.html`, but it takes its site from the
  active tab, which would be itself, so `readPopup` answers `tabs.query` with
  the drive page. Popup-only features need a step there that clicks or reads
  their part of the popup.

## Adding to the map

- A feature is something a user sets out to do, or meets, with its own way in:
  a page surface, a popup view, a card, a shortcut. Things reached only inside
  one of those are sub-features in that feature's file. Plumbing (the Chrome
  keep-alive, storage formats) is not a feature; it goes in Gotchas where it
  bites.
- Each file has Sub-features, How to get to it, Driving it (preconditions,
  steps, what you can observe; if it can't be driven headless yet, the reason
  is the to-do), and Gotchas. Describe behavior, not code locations, unless
  the location is the point.
- Change a feature's file in the same commit that changes the feature. A new
  feature gets a file and a row in the index. After driving one, set its row
  to "Yes, <browser> (YYYY-MM-DD)" and update its "Last driven" line.
