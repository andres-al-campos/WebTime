# End session early

Updated 2026-11-24 20:18, at 2.10.0.

Stop a session before it runs out. The unused time goes to the site's bank,
and the gate comes up on a shorter cooldown.

## Sub-features

- Keyboard shortcut, default Ctrl+E (Ctrl and Cmd are interchangeable). Ignored
  while typing in a text field or while another WebTime dialog is up.
- Popup button "End session (Ctrl+E)" on the live session card; it closes the
  popup and opens the same confirm on the page.
- Confirm dialog: "End Session N?", the bank on its purple pill, what it
  holds solid and the slice ending would add filling in at half strength, and the time that is kept
  ("1:50 rolls over to banked sessions", or "Your bank is full"). Enter
  confirms, Escape cancels. Media pauses while it's
  open and resumes on cancel; the clock is frozen while it's open and its tab
  is the one in front. Other tabs and sites keep counting.
- The unused time goes to the bank as part of a dot: ending 10 seconds into a
  2-minute session banks 0.92 of one. Past a full bank it's lost. The session
  still costs its whole dot, and the next session is the usual length.
- The cooldown that follows is in proportion to what was used: stopping at a
  tenth of the session waits a tenth of the cooldown.

## How to get to it

On a site with a session running: press the shortcut, or popup → site view →
session card → "End session".

## Driving it

`npm run drive -- end-early` (~40s): 2-minute sessions, a 1-minute first cooldown
and an empty bank. After 10s it presses Ctrl+E, reads the confirm, clicks OK,
checks the gate is on a cooldown and what the bank holds, waits the cooldown out,
then starts the next session through the gate.

Last driven: 2026-11-24, Chrome headless. The confirm read "1:50 rolls over
to banked sessions"; the gate "Session Ended" with "Next session in 0:04";
bank 0.9167; "Start Session" once the cooldown ran out; timer `⏱ 01:58` two
seconds into the next session. The popup's End session button and the recorded
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
