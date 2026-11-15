# End session early

Updated 2026-11-15 17:13, at 2.10.0.

Stop a session before it runs out. The unused time goes back to what the site
holds, and the gate comes up.

## Sub-features

- Keyboard shortcut, default Ctrl+E (Ctrl and Cmd are interchangeable). Ignored
  while typing in a text field or while another WebTime dialog is up.
- Popup button "End session (Ctrl+E)" on the live session card; it closes the
  popup and opens the same confirm on the page.
- Confirm dialog: "End Session N?" and the time that is kept ("1:50 unused is
  kept for later"). Enter confirms, Escape cancels. Media pauses while it's
  open and resumes on cancel; the clock is frozen while it's open.
- The unused share of the session returns to the site: ending 10 seconds into
  a 2-minute session returns 110/120 of a session.

## How to get to it

On a site with a session running: press the shortcut, or popup → site view →
session card → "End session".

## Driving it

`npm run drive -- end-early` (~40s): 2-minute sessions. After 10s it presses
Ctrl+E, reads the confirm, clicks OK, checks the gate is up and what storage
holds, then starts the next session through the gate.

Last driven: 2026-11-15, Chrome headless. Confirm "End Session 1? / 1:50 unused
is kept for later", verdict `end-session-confirm` while it was up; gate "Start
a Session?" with verdict `gate`; 3.917 sessions held; timer `⏱ 01:58` two
seconds into the next session. The popup's End session button and the recorded
"ended early" tag were not checked.

## Gotchas

- The shortcut can be changed or disabled in [global settings](global-settings.md).
- Does nothing if there's no session or the session has no time left.
