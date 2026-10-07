# Session rules

Per-site limits. Turn them on for a site and browsing it runs in sessions with
cooldowns between them.

## Sub-features

- On/off toggle per site. Off means tracking only.
- Session length: 1–240 min (default 40).
- Nudge every: 0–120 min (default 20; 0 shows "Disabled").
- Base cooldown: minutes 0–120 plus seconds in 5s steps (default 5m). 0m0s
  is refused while rules are on. Session N's cooldown is N × base.
- Every change saves immediately and applies to a running session: shrinking
  the length past the time already used ends the session on the spot.
- Turning rules off suspends the session; turning them back on resumes the
  same session number rather than starting at Session 1.

## How to get to it

Popup → site view → "Session rules" card (today only; hidden on past days).

## Driving it

Preconditions: `./build.sh`.

1. Open the site view for a site, click the toggle, set Session length to 1.
2. Expected: the session card shows "Session 1 · NN% left"; the page timer
   switches to `⏱ 00:59`-style countdown.

Not yet proven: the harness doesn't click the toggle or the steppers yet.
Headless shortcut that skips the card: `npm run drive -- --limit 1 --popup`
writes the same settings from the worker.

## Gotchas

- These are per-site settings stored with the globals; the gear's Settings
  sheet is global-only and doesn't show them.
- The cooldown is stored as fractional minutes and rounded to whole seconds on
  read; without the rounding some values displayed a second short.
