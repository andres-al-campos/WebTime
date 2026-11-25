# Session rules

Updated 2026-11-24 20:18, at 2.10.0.

Per-site limits. Turn them on for a site and browsing it runs in sessions,
each started at the [gate](sessions.md).

## Sub-features

- On/off toggle per site. Off means tracking only.
- Session length: 1–240 min (default 40).
- Cooldown: 0–60 min (default 5; 0 shows "None"), the first cooldown between
  sessions; later ones grow by √n (see [sessions](sessions.md)). Its ⓘ reads
  "Each cooldown is a little longer than the last, and shorter if you end early."
- Sessions per day: 1–10 (default 5), also the dots on the gate. The row is full again at each day reset. Its ⓘ says unused sessions roll over into the bank.
- Banked sessions: 0–10 (default 2). Each stepper's ⓘ opens a sentence just above it; this one says banked sessions don't expire and a full bank loses the extra sessions. Sessions left when the day resets and minutes an early end leaves are saved here; a full
  bank earns nothing more. Stored as `bankSessions`; a `maxSessions` stored
  before it is read as the bank above the day.
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
- Changing sessions per day takes effect at once: the row is stored as how many
  were used today, so lowering it and raising it again gives the same row back.
- A length change is applied by comparing the running session's length with
  the settings, not with the previous settings. Remembering the previous ones
  lost the first change after every worker start. The wind-down drive raises
  the length mid-session and catches this.
