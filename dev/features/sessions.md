# Sessions and the gate

Updated 2026-11-24 22:53, at 2.10.0.

On a site with rules on, browsing happens in sessions. Each day brings a fixed
row of them, and each one is started by hand at a gate.

## Sub-features

- With rules on and no session running, every tab of the site is blurred
  behind the gate: "Session Ended", however you got there, a row of dots on a
  blue pill (one per session a day, solid blue for each one left, a 2px blue
  ring for each used) over "2/3 sessions left", and a "Start Session" button.
  The bank isn't shown while the row has any left. Once the row is used up, the
  bank's slots take its place on a purple pill, over "2/3 banked sessions
  left". A dot still being saved shows its share as a solid pie inside a whole
  ring, and the count leaves it out. The on-page timer shows the length
  a start would give. Media pauses and anything that starts
  playing while the page is blurred is paused too; fullscreen exits, keys are
  blocked, and the clock is stopped.
- OK starts a countdown inside the Cancel button (10 seconds unless changed
  in [global settings](global-settings.md)) and the title becomes the start question, "Are you sure?" unless changed there. The dialog's bottom edge never moves, so Cancel lands exactly where Start Session was; a two-line question grows it upward by the extra line. The gaps above the pill, below its line and under the button are half the pill's height. Cancel during it goes back to the gate and uses nothing.
  At zero the session starts, the page unblurs and paused media plays again.
- After a session the gate is on a cooldown: the Start button reads "Next session
  in 4:12", greyed, and a bar along the bottom runs out with it; at zero it
  turns back into Start Session. The first cooldown is 5 minutes unless changed in
  [session rules](session-rules.md), and session n's is that times √n (5, 7, 9,
  10, 11). A session ended early takes the cooldown in proportion to what it used.
  The day reset ends any cooldown.
- When the gate changes screen (ready, countdown, cooldown, waiting) the text that changes crossfades:
  300ms out, 300ms in. A cooldown ending fades only the button, since the title stays "Session Ended". A used dot drains over the same 600ms. The dots stay put and the countdowns tick without fading.
- The gate has OK and nothing else: a site with rules on is either in a
  session or behind the gate, so there is nothing to cancel there.
- The row is 5 sessions a day by default and is full again at the day reset.
  Only a start or the reset moves it: a start costs exactly one dot.
- Lowering sessions per day or the bank hides what no longer fits instead of
  removing it, so raising the setting again brings it back.
- Every session is the same length. A session that ends with time left puts
  it in the bank as part of a dot (10 minutes of a 40-minute session is a
  quarter); it still cost its whole dot. Only whole dots start a session.
- With the row and the bank both used up, the gate shows no dots: "Last
  Session Ended" over a clock counting to the day reset and "until sessions
  refill", centred together, and
  becomes the gate again on its own.
- When a session's time runs out the gate comes back.
- The bank is for when the day runs out (2 sessions by default). Every unspent
  minute goes there, up to its size: what the row has left at the day reset,
  a day with no visit's whole row, and what a session ended early or by the
  reset had left. Past a full bank they're lost. A start uses the row first
  and a whole banked dot only once the row is empty. Banked sessions don't
  expire.
- A session running when the day resets ends there, and what it had left goes
  to the bank.
- Each finished session is recorded for [past-day sessions](past-day-sessions.md).

## How to get to it

Automatic once [session rules](session-rules.md) are on.

## Driving it

Preconditions: `npm run build`.

1. `npm run drive -- --limit 1 --seconds 90`: 1-minute sessions. The harness
   presses OK on the gate and waits out the countdown before the stay begins.
2. Expected in the overlay timeline: `gate "Session Ended"` just after 60s;
   clock verdicts `gate → running → gate`.

`npm run drive -- daily-row` seeds the stored budget to check the new day, the
cost of a start, the wait and a budget stored by the refilling design.
`npm run drive -- end-early` checks the cooldown and what an early end banks.

Last driven: 2026-11-19, Chrome headless. `daily-row`: a new day showed 3 dots
over "3/3 sessions left" with 2 banked from the day before, an early end
left 2 dots, a used-up row showed the bank's 3 slots with 2 filled over "2/3
banked sessions left" and drained one on Start, an empty row read "Sessions Refill
In" over a clock, and an old budget of 0.4 + 1 banked read 2 used, 1
banked. The reset landing while a gate is open was not driven. Not driven on Firefox.
The owner checked the dots, the bank and the fades in Floorp on 2026-11-19: they look good.

2026-11-24, Chrome headless: `daily-row` passed, and an early end banked 0.92
of a 2-minute session; screenshots showed the row on its blue pill, the bank
on purple with a half-filled dot, and the cooldown reading "Next session in 1:12"
over its bar. The pills, the cooldown and the fades are not yet checked in Floorp.

## Gotchas

- Time doesn't count at the gate.
- Listeners are registered before the stored state is read. Until it is, the
  clock verdict is `loading` and `syncGate` waits, so a tab reporting in early
  is neither counted nor gated on empty state.
- What a site holds is stored under `webTimeSessionBudget` as `{ used, bank, day }`,
  apart from the day's session state, because it has to survive the day reset.
  `bank` is in sessions and can end in a fraction. `readBudget` also reads the
  `{ sessions, at, bank }` stored while sessions refilled through the day.
- Minutes once saved for the next session under `webTimeSessionExtra` are moved
  into the bank when the background loads, and the key removed. Sessions keep
  a `carryover` field for those older records; new ones start at 0.
- Cooldowns are stored with the day's session state as `cooldowns: { site: { from,
  until } }`, so the reset clears them with it.
- A site with rules on that never stored its counts read the old defaults
  (3 a day, a bank of 1). The background writes those in at load, so the new
  defaults don't change a site already in use.
- The popup's session card is titled with the session's number and shows the time left with "Sessions refill in" beside
  it, the same row of dots, and "+1 banked" when the bank holds a whole
  session, ticking while it is open. The card fits the panel with no scroll:
  the percent in its title is the share left, so there is no "left of" line. Only the row and that line tick: re-rendering the
  card each second would replace the End button under a click.

## Calls

- 2026-11-24 17:38, 2.10.0. **A session running at the day reset ends there.** Carrying it across
  looks like the obvious fix. The owner chose the ending so that "every day the
  first thing you see" is the gate. Its unused time goes to the bank.
- 2026-11-24 17:38, 2.10.0. **A fixed row each day, not a steady refill.** Sessions used to come back one
  at a time through the day. In use that was "way higher cognitive load to ration
  yourself": the count rose on its own and the next few sessions couldn't be
  predicted. Seeing the supply go down by exactly one per session is what
  encourages budgeting, and the bank softens running out. Ending early costs the
  whole dot too, since the minutes go to the bank. Applies *Saving pays later*.
- 2026-11-19 17:34, 2.10.0. **The gate shows the bank only once the row is used up.** Showing it beside
  the row looks like the obvious way to make saving visible. The owner wants it
  "more like a secret menu item... like the backup reserves. they shouldn't be
  advertised on the thing you see every session." The popup still shows it.
  When it does show, it replaces the row, and its slots stay as empty rings once
  spent. The line under the dots gives the count because, in the owner's
  words, not everyone can count circles at a glance, but anyone can read a
  number.
- 2026-11-19 17:34, 2.10.0. **Banked, not reserve.** "Reserve" was tried for a day, for its backup feel.
  The owner went back to banked: "it even makes you think of resources like
  money, and here your time is the resource." When the bank shows is the gate's
  business, not the name's. Applies *Saving pays later*.
- 2026-11-24 19:39, 2.10.0. **Every session is one length; unspent minutes go to the bank.** Early-end
  minutes used to stack onto the next session, which looks generous. In use
  there was "0 incentive to end a session early", the stacked minutes made "this
  huge first session" the next day, and with no gaps between sessions "it kind
  of does encourage binging". Now the minutes fill a banked dot, and only a
  whole dot starts: a partial one would bring back short sessions, each with its
  own gate and cooldown. Applies *Saving pays later*.
- 2026-11-24 19:39, 2.10.0. **Cooldowns between sessions grow by √n.** The old cooldowns were removed
  when sessions began refilling, and nothing kept sessions from running back to back. Linear
  growth (5, 10, 15…) adds up to over an hour at six sessions; √n keeps growing
  more gently. An early end takes a share of the cooldown, since a full one after
  stopping early reads as a penalty. Applies *It doesn't scold*.
- 2026-11-24 17:38, 2.10.0. **Each set of dots sits on a pill; the bank's is purple.** Orange was tried
  for the bank, as a ring and as a fill, and read as "way too much". Purple
  is close to the blue, so the pill also carries the line's "banked". Red-green
  colour blindness can merge the two; the line and the set's size still tell
  them apart.
- 2026-11-24 19:39, 2.10.0. **Cooldown, not break.** The wait between sessions was called a break in
  the first 2.10.0 builds. The owner went back to cooldown: "it kind of adds to the gamification
  aspect like in videogames your abilities go on cooldown. break sounds a bit
  more like time out". ScreenZen uses the same word for the same wait.
- 2026-11-24 20:18, 2.10.0. **Saved is solid; only the slice not yet saved is faint.** Partial dots were
  half strength at first, and on the end dialog the filling slice was hard to
  see. Now the end dialog's added slice is the only faint one, animating in:
  "if you missed the animation well then how do you know what you get?"
- 2026-11-24 20:18, 2.10.0. **Cooldowns keep growing, explained in one line.** A flat cooldown was
  weighed as simpler. The owner kept the growth if one line could explain it,
  since it gives "just a tiny subconscious" reason to skip the next session,
  which still counts once the bank is full. The end dialog doesn't mention
  the cooldown: the gate's button shows it right after, as the timer shows a
  session's length.
- 2026-11-24 22:53, 2.10.0. **"Last Session Ended", not a friendly sign-off.** "That's All for Today"
  was tried and read as cartoonish. People reaching this screen are likely to
  be emotional, so the title is declarative: "it has to have some authority to
  it while also being neutral."
