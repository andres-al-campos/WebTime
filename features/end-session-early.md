# End session early

Stop a session before it runs out. The unused time plus a 10% bonus rolls into
the next session, and the cooldown starts now.

## Sub-features

- Keyboard shortcut, default Ctrl+E (Ctrl and Cmd are interchangeable). Ignored
  while typing in a text field or while another WebTime dialog is up.
- Popup button "End session (Ctrl+E)" on the live session card; it closes the
  popup and opens the same confirm on the page.
- Confirm dialog: "End Session N?", the cooldown it will cost and the next
  session's full length. Enter confirms, Escape cancels. Media pauses while
  it's open and resumes on cancel; the clock is frozen while it's open.
- Next session = base length + unused time + 10% of unused time.

## How to get to it

On a site with a session running: press the shortcut, or popup → site view →
session card → "End session".

## Driving it

`npm run drive -- end-early` (~40s): a 2-minute session with a 15s cooldown
step. After 10s it presses Ctrl+E, reads the confirm, clicks OK, waits out the
cooldown and compares the timer with the length the confirm promised.

Last driven: 2026-10-07, Chrome headless. Confirm "End Session 1? / Site will
go on a 0:15 cooldown / Next session will be 4:02", verdict
`end-session-confirm` while it was up; blocker "Session 1 Ended" for 15s; timer
`⏱ 04:00` two seconds into session 2. The popup's End session button and the
recorded "ended early" tag were not checked.

## Gotchas

- The shortcut can be changed or disabled in [global settings](global-settings.md).
- Does nothing if there's no session or the session has no time left.
