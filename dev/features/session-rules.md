# Session rules

Updated 2026-11-16 01:41, at 2.10.0.

Per-site limits. Turn them on for a site and browsing it runs in sessions,
each started at the [gate](sessions-and-cooldowns.md).

## Sub-features

- On/off toggle per site. Off means tracking only.
- Session length: 1–240 min (default 40).
- Nudge every: 0–120 min (default 20; 0 shows "Disabled").
- Sessions per day: 1–24 (default 3). One session returns every 24h ÷ this.
- Max sessions: 1–10 (default 4). The most a site holds; a full row earns
  nothing more.
- Under the steppers, sessions per day × length = the average a day,
  updated as they change.
- Every change saves immediately and applies to a running session: shrinking
  the length past the time already used ends the session on the spot.
- Turning rules on puts the site's tabs behind the gate. Turning them off
  suspends a running session and lifts the gate; turning them back on resumes
  that session. What the site holds is untouched by the toggle.

## How to get to it

Popup → site view → "Session rules" card (today only; hidden on past days).

## Driving it

`npm run drive -- session-rules` (~25s): opens the popup for `localhost`,
clicks the toggle, starts a session at the gate that appears, and checks the
saved settings and the page timer.

Last driven: 2026-11-15, Chrome headless. Saved 40-minute sessions and
20-minute nudges; after the gate the page timer went from `00:03` to
`⏱ 39:58`. The steppers were not driven.

## Gotchas

- These are per-site settings stored with the globals; the gear's Settings
  sheet is global-only and doesn't show them.
- Changing sessions per day or the maximum keeps what was already waited:
  the background settles what the site holds at the old rules first.
- A length change is applied by comparing the running session's length with
  the settings, not with the previous settings. Remembering the previous ones
  lost the first change after every worker start. The wind-down drive raises
  the length mid-session and catches this.
