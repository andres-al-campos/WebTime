# Global settings

Settings that apply to every site.

## Sub-features

- Day resets at: Midnight, 1 AM … 6 AM.
- Inactivity: 5–600s in 5s steps (default 30). How long after your last input
  a silent tab stops counting.
- Chart scale: 0.3–1.0 (default 1.0). Compresses tall bars so short days stay
  visible.
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

`npm run drive -- global-settings` (~5s): steps Chart scale down, saves, and
checks storage holds the new scale and the untouched Inactivity value. It
doesn't check the background picks the settings up.

Last driven: 2026-10-07, Chrome. Saved `scalingPower: 0.95`,
`inactivityTimeoutS` kept.

## Gotchas

- Nothing saves until Save; closing with the gear discards changes. Per-site
  session rules, by contrast, save on every click.
- Changing the reset hour can move "today" immediately.
