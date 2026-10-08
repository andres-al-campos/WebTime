# WebTime features

What a user can do with WebTime, how to reach it, and how to drive it. Read
this before adding anything: if it's already here, extend it instead of
building it again.

| Feature | File | Platforms | Driveable headless? |
|---|---|---|---|
| Time tracking | [time-tracking.md](time-tracking.md) | Firefox, Chrome | Yes, Chrome (2026-10-06) |
| On-page timer | [on-page-timer.md](on-page-timer.md) | Firefox, Chrome | Yes, Chrome (2026-10-06) |
| All-sites overview | [all-sites-overview.md](all-sites-overview.md) | Firefox, Chrome | Yes, Chrome (2026-10-07) |
| Site view | [site-view.md](site-view.md) | Firefox, Chrome | Yes, Chrome (2026-10-07) |
| Session rules | [session-rules.md](session-rules.md) | Firefox, Chrome | Yes, Chrome (2026-10-07) |
| Sessions and cooldowns | [sessions-and-cooldowns.md](sessions-and-cooldowns.md) | Firefox, Chrome | Yes, Chrome (2026-10-07) |
| End session early | [end-session-early.md](end-session-early.md) | Firefox, Chrome | Yes, Chrome (2026-10-07) |
| Nudges | [nudges.md](nudges.md) | Firefox, Chrome | Yes, Chrome (2026-10-07) |
| Wind-down | [wind-down.md](wind-down.md) | Firefox, Chrome | Yes, Chrome (2026-10-07) |
| 7-day average popup | [average-popup.md](average-popup.md) | Firefox, Chrome | Yes, Chrome (2026-10-07) |
| Past-day sessions | [past-day-sessions.md](past-day-sessions.md) | Firefox, Chrome | Yes, Chrome (2026-10-07) |
| Global settings | [global-settings.md](global-settings.md) | Firefox, Chrome | Yes, Chrome (2026-10-07) |
| Your data | [your-data.md](your-data.md) | Firefox, Chrome | Yes, Chrome (2026-10-07) |

Each row is something you do or run into in WebTime. Smaller things live
inside their feature's file. "Firefox, Chrome" means the same code runs on
both, not that both have been driven.

## Driving conventions

- **Changing a feature:** after `./build.sh`, run that feature's scenario
  (named in its file) and quote its ✓ line when you report the change. A ✗, or
  a feature with no scenario, means the change is not verified yet: say so,
  don't call it done.
- **Run the project:** `./build.sh`. It refreshes `dist-chrome/` and
  `extension/`; the harness loads `dist-chrome/` and builds nothing itself.
- **Drive:** `npm run drive -- <scenario>` loads `dist-chrome/` into
  Playwright's Chromium (new headless mode), serves a page on a free localhost
  port, and drives one feature: `track` (the default), `nudges`, `end-early`,
  `average-popup`, `session-rules`, `wind-down`, `overview`, `past-day`,
  `global-settings`, `export`, or `all`. Each prints the page's overlays
  as they change, the clock verdicts, and a ✓ or a ✗ with a fix. `--headed`
  shows the window. `track` also takes `--seconds N`, `--limit M`,
  `--cooldown M` and `--popup` for poking around by hand.
- **Every feature gets a scenario.** Popup-only features seed stored history,
  open the popup and read what it shows; they take a few seconds. A scenario
  that can't see some way the feature breaks says so in its comment.
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
- **Extending the harness:** scenarios live in `scripts/drive/scenarios.mjs`,
  shared pieces (seeding, the overlay reader, opening the popup) in
  `scripts/drive/lib.mjs`. The popup opens as a tab, but it takes its site from
  the active tab, which would be itself, so `openPopup` answers `tabs.query`
  with the drive page. A new scenario should be shown to fail once against a
  build with the feature broken.

## Adding to the map

- A feature is something a user sets out to do, or meets, with its own way in:
  a page surface, a popup view, a card, a shortcut. Things reached only inside
  one of those are sub-features in that feature's file. Plumbing (the Chrome
  keep-alive, storage formats) is not a feature; it goes in Gotchas where it
  bites.
- Each file has Sub-features, How to get to it, Driving it (preconditions,
  steps, what you can observe; the scenario that checks it; if there isn't one
  yet, the reason is the to-do), and Gotchas. Describe behavior, not code locations, unless
  the location is the point.
- `test/feature-map.test.mjs` fails when a row has no file, a file has no
  row, or a file names a scenario that doesn't exist.
- Change a feature's file in the same commit that changes the feature. A new
  feature gets a file and a row in the index. After driving one, set its row
  to "Yes, <browser> (YYYY-MM-DD)" and update its "Last driven" line.
