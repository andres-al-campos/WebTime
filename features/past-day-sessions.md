# Past-day sessions

Look back at how a past day's sessions went on a site.

## Sub-features

- One card per finished session, oldest first: time used / session length, a
  "completed", "ended early" or "day ended" tag, a fill bar, the cooldown it cost
  (`1:30 × 3 = 4:30`) and the running total.
- "No sessions recorded on this day." for days with time but no sessions,
  including every day before session history was recorded.
- The usage card above shows that day's numbers and a "Today →" button.
- The Session rules card is hidden on past days, since today's rules may not
  be the rules that applied then.

## How to get to it

Popup → site view → click a past bar on the chart.

## Driving it

Preconditions: `./build.sh`; `webTimeSessionHistory` holding a past day's
sessions for a site.

1. Open the site view, click that day's bar.
2. Expected: session cards; "Today →" returns to today's live cards.

No scenario: it only shows stored data, so a break shows the next time you
open the popup. Check by hand with the steps above when it changes.

## Gotchas

- Session history keeps the newest 730 days; tracked time is never pruned.
