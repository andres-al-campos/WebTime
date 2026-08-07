# Chrome (MV3) port plan

Handoff document. Written 2026-08-06 after measuring Chrome's service-worker
behavior with the probe in this directory. Read this first if you're picking the
port up cold.

## Why

WebTime is a Firefox MV2 extension. Chrome requires MV3, which replaces the
persistent background page with a **service worker that Chrome kills after ~30s
idle**. The manifest changes are trivial. The problem is the timer.

Today, time is counted by incrementing a counter inside a 1-second interval:

- `incrementTimer()` — [src/background.ts:330](../../src/background.ts) —
  does `todaysTotalTimeInActiveDomain++` once per tick
- `startTimer()` — [src/background.ts:368](../../src/background.ts) —
  `setInterval(incrementTimer, 1000)`
- `checkForInterventions()` is called from the **last line of the tick**
  ([src/background.ts:365](../../src/background.ts)), so the session-limit
  check only runs as a consequence of a tick firing

A pending `setInterval` neither keeps a service worker alive nor survives its
death. Under MV3 the worker dies, ticks stop, the counter stops advancing, and:

- Time is silently under-counted, permanently (the counter never catches up)
- **`fireCooldown` never fires** — the user browses past their session limit
  with no blocker. This is the single most important feature of the extension.
- The wind-down bar freezes mid-fill, so the cooldown lands with no warning

**Ticking cannot be made to work under MV3.** This is the port.

## Measured facts

From the probe in this directory (9-minute YouTube run, no interaction):

| Question | Result |
|---|---|
| `alarms.create({when})` precision | **0–4ms** typical across 5s–120s delays; one 952ms outlier in 13 samples |
| Content-script `setTimeout` over 90s, active tab | **1–7ms** typical; one 691ms outlier in 5 samples |
| Worker death during silent playback | **Untested** — see caveat |
| Worker survival *with* a 30s heartbeat alarm | Survived 9 min, single boot id, no resurrections |

**Caveat on the untested row:** the probe's own 30s heartbeat alarm kept the
worker alive, masking the behavior it was trying to measure. What we know is
that a 30s heartbeat keeps the worker up indefinitely — useful, but not the
same question. Closing this gap means a second run with the heartbeat disabled.
It was judged non-blocking because the design relies on *scheduled wakes firing
on time* (measured, excellent) rather than on the worker surviving unaided.

`AUDIBLE_CHANGE` fired at 8:13:38 and then not again until 8:18:27 — a ~5min
gap. This confirms `audible` is an **edge** event (fires at playback start/stop
only). Audio keeps a tab *counted* but does not keep the worker *alive*.

## Design

Three principles, in the order they matter:

1. **Derive time from the clock, not from tick counts.** A counter that only
   advances when a callback runs is wrong the moment the callback stops.
2. **The whole session schedule is computable at session start.** Session end,
   nudge times, wind-down start are all known up front. Schedule exact-instant
   wakes for them instead of polling "are we there yet?" every second.
3. **The content script owns the display.** It is alive on the page regardless
   of worker state, so the countdown, the wind-down bar, and nudges run off a
   known deadline and a local clock — no worker involvement to render.

The background remains the source of truth for session state, daily totals,
cooldowns, and storage. The content script is a renderer and an alarm clock; it
never decides anything the background doesn't confirm.

### Step 1 — Timestamp accounting (required, do this first)

Replace the tick counter with two persisted values:

```
activeSince        // ms epoch when the current domain became active+focused, or null
accumulatedToday   // seconds already banked for the tracked domain today
```

Current total becomes a function:
`accumulatedToday + (activeSince ? (now - activeSince)/1000 : 0)`

`todaysTotalTimeInActiveDomain` has **~30 read sites and one write site**
(`++` at [src/background.ts:358](../../src/background.ts)). Convert it to a
`currentDailyTotal()` function and most read sites keep working unchanged. This
is what makes the refactor tractable.

The five freeze gates in `incrementTimer()`
([src/background.ts:330-365](../../src/background.ts)) stop being per-tick
skips and become **clock-stop / clock-start transitions**:

| Gate | Today | After |
|---|---|---|
| `!browserIsFocused` | skip tick | bank + `activeSince = null` on blur; restart on focus |
| domain in cooldown | skip tick | bank at cooldown start, restart at cooldown end |
| `endSessionConfirmOpen` | skip tick | bank on open, restart on close |
| `averagePopupOpen` | skip tick | bank on open, restart on close |
| tab switch / inactivity | `stopTimer()` | bank + `activeSince = null` |

Each of these already has an event that fires at the right moment
(`windows.onFocusChanged` at [src/background.ts:490](../../src/background.ts),
the popup open/close messages, etc.), so the transition is recorded when it
happens rather than inferred later. **This is what makes the gates survive
worker death** — a dead worker can't evaluate a gate, but the timestamp written
before it died still says what was happening.

Cap any unobserved gap at the inactivity threshold: if the worker was out of
contact longer than `inactivityThresholdMs`, the user wasn't interacting, which
is the existing definition of idle. Laptop sleep, worker death, and genuine
idleness collapse into one rule — no special cases.

### Step 2 — Scheduled wakes

Compute `sessionEndsAt` when a session starts or changes, then schedule:

- `chrome.alarms.create('session-end', { when: sessionEndsAt })`
- `chrome.alarms.create('wind-down', { when: sessionEndsAt - 60_000 })`
- `chrome.alarms.create('cooldown-end', { when: cooldownEndTime[domain] })`

The `when` form has **no 30s floor** (that only applies to `periodInMinutes`)
and measured at 0–4ms accuracy.

Redundant path: the content script also sets a `setTimeout` for the same
instants and messages the background. Measured at 1–7ms. Either path alone
fires on time; the alarm is primary. Neither *decides* anything — they wake the
worker, which recomputes from the clock and confirms before acting. A tampered
content script can only cause an early wake that gets rejected.

**Main implementation risk:** a single `rescheduleSessionEnd()` must be called
from every path that mutates session state — `getOrStartSession`, the
`changeLength` path (~[src/background.ts:694-725](../../src/background.ts)),
`naturalEnd`, `endEarly`, cooldown start/end, settings changes. A missed call
site leaves a stale alarm. Worth a dedicated review pass.

### Step 3 — Wind-down bar moves to the content script

Currently `checkWindDown()` ([src/background.ts:853](../../src/background.ts))
re-sends `SHOW_WIND_DOWN` **every second** with fresh `progress` and
`remainingSeconds` — 60 messages per session, each needing a live worker. The
content script comment at [src/content.ts:775](../../src/content.ts) notes the
per-second arrival explicitly.

Replace with **one** message carrying the deadline:

```
{ type: 'SHOW_WIND_DOWN', endsAt: <epoch ms> }
```

The content script animates locally via `requestAnimationFrame` against its own
clock. Handler is the if/else chain at
[src/content.ts:1053](../../src/content.ts); `showWindDown(progress, remaining)`
changes signature to take `endsAt`.

Two side benefits: the animation gets smoother than 1Hz steps, and 60 messages
per session become 1.

### Step 4 — Heartbeat backstop

`chrome.alarms.create('heartbeat', { periodInMinutes: 0.5 })` — 30s is the
hard floor for the periodic form. Replaces the activity-check interval at
[src/background.ts:1141](../../src/background.ts).

This is a **backstop**, not the mechanism: it bounds any unobserved gap to ~30s
and keeps idle detection running. Detection latency goes to ~30s, but with
timestamps that doesn't corrupt data — `tabLastActivity` records when the user
actually last interacted, so a late check can retroactively exclude the idle
period. (Under tick-counting a late check can't; those seconds were already
banked.) Inactivity thresholds of 30–60s are unaffected.

### Step 5 — Manifest and build

- `manifest_version: 3`; `browser_action` → `action`; `<all_urls>` moves from
  `permissions` to `host_permissions`; `background.scripts` →
  `background.service_worker`; add `"alarms"` permission
- API shim: `const browser = globalThis.browser ?? chrome;`. Types already use
  `declare const browser: typeof chrome` ([src/types.ts:6](../../src/types.ts)),
  so there is no Firefox-specific type surface to unwind. All 26 `await
  browser.*` calls work as-is — Chrome MV3 promisifies everything.
- Listeners must be registered **synchronously at top level**. They already are;
  verify this holds after the refactor. `init()` at
  [src/background.ts:1149](../../src/background.ts) re-runs on every wake, which
  is correct MV3 behavior.
- [build.mjs](../../build.mjs): emit two manifests from one source. Firefox
  MV3 prefers event pages (`background.scripts`) over service workers, so the
  manifests differ in that key. Single-source with a build-time transform beats
  two diverging codebases, and keeps the AMO listing working.
- [build.sh](../../build.sh) uses `web-ext build` (Mozilla's tool). It zips a
  Chrome extension fine but you'll want a second artifact.

## Why this is also better on Firefox

MV2 background pages don't get killed like service workers, but they *are*
suspended on OS sleep, and tick-counting under-counts there too. The Chrome port
is the forcing function, not the only reason to do it.

## Verification

1. `npm run typecheck && npm test` — 34 tests currently pass; the session model
   in [src/shared/session-model.ts](../../src/shared/session-model.ts) is pure
   functions over an `ActiveSession` with a `startDaily` anchor, so it should
   need little change. **It is already timestamp-style** — this refactor makes
   the daily counter consistent with it.
2. Load unpacked in Chrome. Set a 2-minute session limit on a test domain.
3. Play a video and **do not touch the machine**. Confirm: countdown stays
   accurate, wind-down bar starts at T-60s and animates smoothly, blocker fires
   within ~1s of zero.
4. Force-kill the worker mid-session (`chrome://serviceworker-internals` → Stop)
   and confirm the count heals and the blocker still fires on time.
5. Sleep the laptop mid-session; confirm the gap is capped at the inactivity
   threshold rather than credited in full.
6. Regression-test the same flows in Firefox with the MV2 build.

## Open question

Q2 above — whether the worker dies unaided during silent playback. Closing it
means re-running the probe with the heartbeat alarm commented out in
[sw.js](sw.js) and leaving a video playing untouched for ~5 minutes. It does not
block the port; the design assumes the worker dies and schedules around it.
