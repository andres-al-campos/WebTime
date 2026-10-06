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

Preconditions: `./build.sh`; a session running on `localhost`.

1. Press Ctrl+E on the page, then Enter.
2. Expected: `.web-time-end-session-overlay`, then the cooldown blocker; the
   recorded session ends as "early".

Not yet proven.

## Gotchas

- The shortcut can be changed or disabled in [global settings](global-settings.md).
- Does nothing if there's no session or the session has no time left.
