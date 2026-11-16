# End session early

Updated 2026-11-16 01:46, at 2.10.0.

Stop a session before it runs out. The unused time is added to the site's next
session, and the gate comes up.

## Sub-features

- Keyboard shortcut, default Ctrl+E (Ctrl and Cmd are interchangeable). Ignored
  while typing in a text field or while another WebTime dialog is up.
- Popup button "End session (Ctrl+E)" on the live session card; it closes the
  popup and opens the same confirm on the page.
- Confirm dialog: "End Session N?" and the time that is kept ("1:50 unused is
  added to your next session"). Enter confirms, Escape cancels. Media pauses while it's
  open and resumes on cancel; the clock is frozen while it's open.
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

Last driven: 2026-11-16, Chrome headless. 110s kept; gate "Start a Session? /
3:50 session"; timer `⏱ 03:49` two seconds into the next session, and nothing
left kept after it started. The popup's End session button and the recorded
"ended early" tag were not checked.

## Gotchas

- The shortcut can be changed or disabled in [global settings](global-settings.md).
- Does nothing if there's no session or the session has no time left.
