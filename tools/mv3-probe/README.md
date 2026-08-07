# MV3 probe

A throwaway diagnostic extension, not part of the WebTime build. It exists to
answer two questions about Chrome's Manifest V3 service workers that decide how
a Chrome port of WebTime has to be structured.

WebTime today counts time by incrementing a counter inside a 1-second
`setInterval` in an MV2 background page, and checks the session limit from
inside that same tick (`checkForInterventions()` at the end of
`incrementTimer()`). MV3 replaces the persistent background page with a service
worker that Chrome kills after roughly 30 seconds idle. A pending `setInterval`
neither keeps the worker alive nor survives it, so under MV3 the counter stops
advancing and the session-end blocker never fires — the user browses past their
limit with no cooldown.

The fix is to derive elapsed time from timestamps rather than tick counts, and
to schedule wakes (`chrome.alarms`, plus a `setTimeout` in the content script)
at the instants the session actually needs something to happen. That design
rests on two assumptions worth measuring rather than taking from documentation:

- **Q1.** Does `chrome.alarms.create({when})` fire at the requested instant, or
  does Chrome fuzz it? This decides whether the alarm can be the primary
  scheduler for session ends, or whether the content script's own timer has to
  be primary with the alarm as backup.
- **Q2.** Does the worker actually die during silent audible playback — a video
  playing with no user interaction? Audio keeps a tab *counted* via
  `tabs.onUpdated`, but `audible` is an edge event that fires only at playback
  start and stop, so it may not keep the worker *alive*. Video is the most
  important timewaster case, so this matters.

See [ANALYZE.md](ANALYZE.md) for how to load it, run the experiment, and read
the results.

## Results (measured 2026-08-06)

Both questions answered over two runs.

**Q1 — alarms are precise.** `alarms.create({when})` fires within 0–4ms across
5s–120s delays, and within ~1s even when the worker must be cold-started to
receive it. A content-script `setTimeout` over 90s in the active tab lands
within 1–7ms. Precision does not depend on the worker being alive, so session
ends can be scheduled directly and the earlier worry about a 30-second blocker
delay does not apply.

**Q2 — the worker dies constantly.** 7 boots in 10 minutes of untouched video
playback with no heartbeat. Three consecutive 3-minute alarms each arrived under
a different boot id, so the worker died in every gap. Video playback does **not**
keep it alive: `audible` fires only at playback start and stop. With a 30s
heartbeat it survived a full 9-minute run.

Run 1 measured Q2 wrong — its own heartbeat kept the worker alive and masked the
death it was looking for. Hence the `MODE` switch in [sw.js](sw.js).

**[CHROME-PORT-PLAN.md](CHROME-PORT-PLAN.md) is the handoff document** — full
measurements, the design they imply, and step-by-step porting notes.

Delete this directory once the Chrome port is settled.
