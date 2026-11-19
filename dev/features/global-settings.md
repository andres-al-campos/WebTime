# Global settings

Updated 2026-11-18 21:23, at 2.10.0.

Settings that apply to every site.

## Sub-features

- Day resets at: a stepper like the others, showing HH:MM. The arrows step 5
  minutes and come round past midnight; any minute can be typed ("7",
  "7:30", "730"). Default midnight. It
  decides which day time is counted under and when each site's row of sessions
  is full again.
- Inactivity: 5–600s in 5s steps (default 30). How long after your last input
  a silent tab stops counting.
- Chart scale: 0.3–1.0 (default 1.0). Compresses tall bars so short days stay
  visible.
- Start countdown: 0–60s in 1s steps (default 10). How long the gate counts
  down after OK before the session starts; 0 starts it at once. Read when the
  gate is shown, so an open gate keeps the old value.
- Ask before starting: the gate's title during that countdown, up to 70
  characters so it fits on two lines. Blank asks "Are you sure?".
- End-session shortcut: click the field and press a combo; × disables it.
  Default Ctrl+E.
- "Your data" row: see [your-data.md](your-data.md).
- Save applies and closes the sheet; the chart redraws with the new scale.

## How to get to it

Popup → gear icon (top right). The sheet slides over the right half; the gear
closes it again.

## Driving it

Preconditions: `./build.sh`.

1. Open the popup, click the gear, change Inactivity, Save.
2. Expected: `webTimeSettings.global.inactivityTimeoutS` in storage holds the
   new value.

`npm run drive -- global-settings` (~5s): steps Chart scale and Start
countdown down, types a start question, saves, and checks storage holds them and
the untouched Inactivity value. `npm run drive -- daily-row` checks the gate asks
the question that was set.

Last driven: 2026-11-18, Chrome headless. Saved `scalingPower: 0.95`,
`startCountdownS: 9` and `startQuestion: "Worth it?"`, `inactivityTimeoutS` kept,
and the gate asked "Worth it?". A gate using a changed countdown was not driven.

## Gotchas

- Nothing saves until Save; closing with the gear discards changes. Per-site
  session rules, by contrast, save on every click.
- Changing the reset time can move "today" immediately.
- Stored as `dayResetTime` (the hour) plus `dayResetMinute`, so settings saved
  when it was an hour alone read the same.
