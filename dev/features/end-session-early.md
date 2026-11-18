# End session early

Updated 2026-11-18 15:39, at 2.10.0.

Stop a session before it runs out. The unused time is added to the site's next
session, and the gate comes up.

## Sub-features

- Keyboard shortcut, default Ctrl+E (Ctrl and Cmd are interchangeable). Ignored
  while typing in a text field or while another WebTime dialog is up.
- Popup button "End session (Ctrl+E)" on the live session card; it closes the
  popup and opens the same confirm on the page.
- Confirm dialog: "End Session N?", the day's row of dots as the gate shows
  them, and the time that is kept ("1:50 unused is
  added to your next session"). Enter confirms, Escape cancels. Media pauses while it's
  open and resumes on cancel; the clock is frozen while it's open and its tab
  is the one in front. Other tabs and sites keep counting.
- The unused time is added to the next session, so the reward shows at the
  very next gate: ending 10 seconds into a 2-minute session makes the next one
  3:50. It is stored per site under `webTimeSessionExtra` and survives the day
  reset; the sessions held are not touched.

## How to get to it

On a site with a session running: press the shortcut, or popup → site view →
session card → "End session".

## Driving it

`npm run drive -- end-early` (~40s): 2-minute sessions. After 10s it presses
Ctrl+E, reads the confirm, clicks OK, checks the gate is up and what storage
holds, then starts the next session through the gate.

Last driven: 2026-11-18, Chrome headless. 110s kept; gate "Session Ended" with
a "Start 3:50 Session" button and the timer previewing 3:50, the same title after
a reload; timer `⏱ 03:49` two seconds into the next session, and nothing left
kept after it started. The popup's End session button and the recorded
"ended early" tag were not checked.

## Gotchas

- The shortcut can be changed or disabled in [global settings](global-settings.md).
- Does nothing if there's no session or the session has no time left.
- The popup's button opens the confirm in the front tab of the window the
  popup came from. It used to go to the last tab the background saw
  activated, which switching windows doesn't change, so the confirm could open
  out of sight in another window. While it held the clock from any tab, that
  froze every timer in the browser until Floorp restarted.
  `npm run drive -- confirm-elsewhere` checks another site keeps counting
  while a confirm is open.
