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

Two runs: run 1 with a 30s heartbeat (precision mode), run 2 without (lifetime
mode). Both ~10 minutes of YouTube playback with no interaction.

| Question | Result |
|---|---|
| `alarms.create({when})` precision | **0–4ms** typical across 5s–120s delays; one 952ms outlier in 13 samples |
| Same, when the worker must be **cold-started** to receive it | **~1s** (180s requested → 181s delivered, 3/3 samples) |
| Content-script `setTimeout` over 90s, active tab | **1–7ms** typical; one 691ms outlier in 5 samples |
| Worker death during silent video playback, no heartbeat | **Dies constantly — 7 boots in 10 minutes** |
| Worker survival *with* a 30s heartbeat | Survived 9 min, single boot id, no resurrections |

### The worker dies, and video does not keep it alive

Run 2 is unambiguous. Three consecutive 3-minute alarms fired at 8:39:33,
8:42:34 and 8:45:35 under **three different boot ids** (`2u20za`, `jythqp`,
`uei0wi`) — the worker died in every gap and was cold-started to deliver each
alarm. `AUDIBLE_CHANGE` at 8:39:46 was followed by a fresh boot 57s later while
audio was still playing.

So: `audible` is an **edge** event (fires at playback start/stop only). Audio
keeps a tab *counted* but does not keep the worker *alive*. An assumption that
engaged timewaster use would keep the worker up by generating events is
**false** — silent video is the common case and it generates nothing.

Alarms remained accurate through all of this. The ~1s on cold-start delivery is
worker startup cost, not scheduling drift. **Alarm precision does not depend on
the worker being alive**, which is what makes the whole design viable.

### Writes can be lost during teardown

Run 2 logged a boot id (`lbc1dc`, 8:46:13) with no `WORKER_BOOT` row — the
module-scope `storage.local` write lost the race with worker shutdown. Treat any
async write issued as the worker is being torn down as **unreliable**. State
must be persisted at the moment of the transition that changes it, not batched
for later. See Step 1.

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
4. **Never show a number we can't vouch for.** Showing nothing is better than
   showing something wrong: a timer that jumps around is a timer you stop
   trusting, and an untrusted tool gets ignored. Where the display can't be
   verified, it hides (Step 3b).

The background remains the source of truth for session state, daily totals,
cooldowns, and storage. The content script is a renderer and an alarm clock; it
never decides anything the background doesn't confirm.

### What this guarantees

| | Accurate? |
|---|---|
| Recorded count, at any observable moment | **Yes, exactly** |
| Session end / blocker firing | **Yes, ~1s** (measured) |
| Nudges, wind-down start | **Yes**, scheduled identically |
| Display while active | Yes — input wakes the worker continuously |
| Display while idle | Yes — frozen, which is correct; time isn't accruing |
| Display during silent video | Yes — local countdown, Step 3a |
| Display when a push was lost | Hidden rather than wrong, ≤~30s (Step 3b) |

The count never needs a live worker to *accumulate*; it needs one only at the
two boundaries (clock start, clock stop), and every boundary is an event that
wakes the worker. Between them, `now - activeSince` is arithmetic that doesn't
care what was running.

This is a stronger guarantee than the current Firefox build, which loses time
outright on OS sleep with no way to recover it.

### Step 0 — Work on a branch

Do the port on **`chrome-mv3`**, not `main`. Every change here (timestamps,
alarms, `chrome.idle`, content-script rendering) touches the tracking core that
the shipping Firefox add-on depends on, and `main` is what goes to AMO.

Firefox supports all of it — MV3, `alarms`, `idle`, service workers since v109 —
so the intent is to merge back once both platforms are verified, not to keep a
permanent fork. Until then a regression on `main` would ship to real users.

Merge only after verification step 10 (Firefox regression) passes.

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

**Persist at the transition, not on a schedule.** Run 2 showed a `storage.local`
write being lost to worker teardown. Every gate transition must write
`activeSince` / `accumulatedToday` in the same handler that observes it
(`onFocusChanged`, cooldown start, popup open, …), while the worker is
demonstrably alive because it is running that handler. Do not rely on a
periodic flush, and do not rely on anything issued during shutdown — there is
no `onSuspend` guarantee in MV3.

### Step 1b — Idle detection: three signals, all event-driven

Heartbeat-only idle detection is correct in the data but wrong in the UI, so
idleness must be detected at the moment it happens rather than polled for.

With a 30s heartbeat and a 30s threshold, detection lands **30–60s late** (two
unsynchronised 30s cycles; 30s is Chrome's hard floor for `periodInMinutes`).
The accounting survives that — `tabLastActivity` records when input actually
stopped, so a late check banks time only up to that instant and retroactively
excludes the idle period. Today's tick counter cannot do this; those seconds
were already `++`'d and are unrecoverable. So the data is *more* accurate than
Firefox today, just less prompt.

The display is the problem. `updateTimerText()`
([src/content.ts:179](../../src/content.ts)) is **passive** — it renders
whatever the background last sent and has no clock of its own. So during the lag
it freezes at a stale value, and the late correction makes the number jump
**backward** (time is given back, because the freeze happened later than the
moment counting stopped).

The jump is small and in the forgiving direction, but it is disproportionately
likely to be *seen*: the correction is triggered by the user returning and
moving the mouse, which is exactly when they look at the widget.

**Fix: `chrome.idle` plus the two signals that already exist.** Nothing here
needs polling — each signal fires an event at its own transition, which is
exactly what timestamp accounting wants (bank on close, restart on open).

| Signal | Catches | Wakes worker | Status |
|---|---|---|---|
| `browserIsFocused` | user is in another app | `windows.onFocusChanged` | exists, [background.ts:490](../../src/background.ts) |
| `chrome.idle.onStateChanged` | user is away from the machine | **yes** | **new** — needs `"idle"` permission |
| content-script input events | in Chrome, but not on this page | message | exists, [content.ts:1068-1070](../../src/content.ts) |

Count only while all three agree the user is present.

```js
chrome.idle.setDetectionInterval(thresholdSeconds);   // min 15s
chrome.idle.onStateChanged.addListener(state => {     // 'active' | 'idle' | 'locked'
  // fires at the transition; no polling, and it wakes the worker
});
```

`chrome.idle` is the important addition because **it fires when nothing else
would**. During silent video with no input there is no other event that says
"the user left" — this is the one signal that will resurrect the worker to say
it. It is OS-level, so it also catches a locked screen (`locked`, immediate and
unambiguous) which currently looks identical to sitting still.

The three don't overlap, they cover each other's blind spots. `chrome.idle` is
machine-wide, so typing in Slack while a video plays in Chrome reports `active`
even though the user isn't watching — `browserIsFocused` is what catches that.
Conversely the content script sees only its own page, so it can't tell "away
from the machine" from "reading a different tab".

Keep the content script's own idle timer as well: it freezes the *display* at
exactly the threshold with the correct value, which is what removes the backward
jump. It can also send `{ type: 'USER_IDLE', since: lastActivityTime }` as a
redundant wake. Resuming was never a problem — the first `mousemove` sends
`USER_ACTIVE` and wakes the worker immediately.

**Do not use a keep-alive hack.** The common ecosystem advice is to ping an
extension API every ~25s so a `setInterval` survives (any extension API call
resets the 30s idle timer). Avoid it — not for battery, but because it depends
on a side effect Chrome has repeatedly narrowed. If a future release tightens
it, the extension silently stops counting and the first symptom is wrong data.
Scheduled wakes don't depend on Chrome tolerating a workaround.

Per-second work in the *content script* is fine and stays — it's a page timer
doing trivial work, exactly as the Firefox build does today, and it only
repaints. If it lags or dies, accounting is unaffected.

**No idle indicator.** Two reasons. `.web-time-timer:hover` already uses
`opacity: 0.25` ([extension/timer.css:29](../../extension/timer.css)), so
dimming for idle would be indistinguishable from hover and would break the
"see what's behind the widget" gesture on an already-dim timer. And with the
freeze happening at the right moment with the right value, a stopped timer
during inactivity is simply what a correct timer does — it needs no explanation.

This does not eliminate stale displays in the *broken* case (worker dead, a
scheduled wake missed). That's a bug, and the fix is the bug, not an indicator.
If a safety net is ever wanted, the better signal is the content script noticing
it has heard nothing from the background for N minutes *while active*.

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

**Main implementation risk:** rescheduling must happen on every path that
mutates session state — `getOrStartSession`, the `changeLength` path
(~[src/background.ts:694-725](../../src/background.ts)), `naturalEnd`,
`endEarly`, cooldown start/end, settings changes. A missed call site leaves a
stale alarm, which means the blocker doesn't fire — the worst failure this
extension has. Scattered manual calls are the kind of thing that reviews clean
and still breaks in the one path nobody considered.

Three mitigations, all cheap, meant to be used together:

1. **A pure deadline function.** `sessionEndsAt(session, dailyTotal) → epoch ms`
   lives in [session-model.ts](../../src/shared/session-model.ts) alongside the
   existing pure helpers, and gets unit tests in the current harness (34 tests,
   no browser needed). The scheduling layer becomes a thin wrapper with nothing
   to get wrong.
2. **A `commitSession(domain, session)` funnel.** Every mutation goes through
   one function that writes `sessions[domain]`, persists, *and* reschedules.
   Rescheduling stops being something to remember and becomes what committing
   means. One place to audit instead of eight.
3. **Recompute on every wake.** Unconditionally clear and re-derive the alarm
   from current state at the top of each wake. A stale alarm then self-corrects
   regardless of which path forgot — and with the heartbeat, "next wake" is at
   most ~30s away.

Not compiler-enforced: someone can still assign `sessions[domain]` directly.
Making `sessions` module-private would close that, but it's a larger refactor
than the port and the threat model (below) doesn't justify it.

### Step 3 — The content script owns all rendering

Both the countdown and the wind-down bar move from "background pushes every
second" to "content script renders locally from a deadline". Same change, two
places.

#### 3a — The timer countdown

This closes the last real gap in the design: **watching a silent video.** Time
is accruing (the user is watching) but no events are generated, so the worker
dies and no updates arrive. `updateTimerText()`
([src/content.ts:179](../../src/content.ts)) is passive — it renders whatever
the background last sent — so the corner number goes stale while the count
itself stays correct.

Give the content script `sessionEndsAt` and let it count down against its own
clock:

```js
const remaining = Math.max(0, (sessionEndsAt - Date.now()) / 1000);
```

Now the worker's death is irrelevant to the display: nothing is being waited
for. The background pushes only when something *changes* the deadline (settings
edit, cooldown, session restart), not once per second to drive an animation.
Message volume drops from ~1/sec to a handful per session.

**Worker death cannot be predicted** — there is no API, no warning, and no
reliable `onSuspend` in MV3. Chrome kills the worker ~30s after the last event,
and any stray event resets that invisibly. Do not try to anticipate it; make
the display not care.

#### 3b — When the deadline can't be verified: slide out

The residual case: the content script's `sessionEndsAt` is stale because the
background changed it and the push was lost. Rare, and bounded to ~30s by the
heartbeat — but possible.

Detect it by observing rather than predicting: *"I am active, I expected an
update, and I haven't had one."* Only meaningful while active — silence during
idle is correct. During activity the content script's own `USER_ACTIVE`
messages keep waking the worker, so continued silence means something is
genuinely wrong, not that the worker is napping.

```js
if (Date.now() - lastActivityTime < IDLE_THRESHOLD_MS &&
    Date.now() - lastUpdateReceived > STALE_THRESHOLD_MS) { /* unverified */ }
```

`STALE_THRESHOLD_MS` ~5s: cold start costs ~1s (measured), so anything under
~3s false-positives on an ordinary wake.

**Then slide the timer out.** Showing nothing beats showing a number that might
be wrong. Motion also avoids the `opacity: 0.25` hover collision
([extension/timer.css:29](../../extension/timer.css)) and reads as deliberate
rather than broken.

Coming back is already free: `mousemove` / `scroll` / `keydown`
([src/content.ts:1068-1070](../../src/content.ts)) send `USER_ACTIVE`, which
wakes the worker and produces a fresh push. Slide back in on the next verified
update.

Try a repair first — send a message requesting a state push (the message itself
wakes the worker) and only slide out if nothing arrives within ~2s. A transient
hiccup then self-heals with no visible change.

#### 3c — Nudges

Same treatment, and the easiest piece: `computeNudgeTimes(sessionLimitSeconds,
nudgeSeed, count)` is already pure and returns **all** nudge offsets up front,
so they are known at session start exactly like `sessionEndsAt`. Schedule one
alarm per unfired nudge.

Two safeguards already exist:

- `firedNudges` is persisted ([src/background.ts:793](../../src/background.ts)),
  so a worker restart can't re-fire one. This is the hard part of scheduling,
  already done.
- `nextNudgeToFire()`
  ([src/shared/session-model.ts](../../src/shared/session-model.ts)) returns the
  *latest* unfired nudge at or before now — so a missed alarm fires once on the
  next wake instead of replaying a backlog. Written for skipped ticks; works
  identically for missed alarms.

So: alarms as the primary path, `nextNudgeToFire` on every wake as
reconciliation. Keep `checkPhiNudges` as that reconciliation step rather than
deleting it.

Nudge times shift when the session length changes mid-session (`changeLength`),
so they reschedule on the same paths as `sessionEndsAt` — the `commitSession`
funnel in Step 2, no extra machinery.

#### 3d — Wind-down bar

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

**The bar hides under the same rule as the countdown (3b)** — and it matters
more here. A half-filled bar asserts something stronger and more specific than
a number does ("your session ends in ~40 seconds"), and it's the component
whose whole job is easing the user toward the cooldown. A stale one either
warns for a session that already ended or fails to warn for one that's about to.

Since the bar is driven by a local `endsAt` after this change, it stays correct
exactly when the countdown does. If the deadline can't be verified, hide the bar
rather than animate an unverified one — same detection, same slide-out.

### Step 4 — Heartbeat (backstop)

`chrome.alarms.create('heartbeat', { periodInMinutes: 0.5 })` — 30s is the
hard floor for the periodic form. Replaces the activity-check interval at
[src/background.ts:1141](../../src/background.ts).

Run 2 made a periodic wake look mandatory: the worker dies within ~30s of idle
and silent video generates no events, so there were long stretches with no wake
source at all. **`chrome.idle.onStateChanged` (Step 1b) now covers that case
directly**, so the heartbeat is a third fallback rather than the only thing
standing between the user and an unenforced limit.

Keep it anyway — it costs one alarm and bounds any unobserved gap to ~30s when
both `chrome.idle` and the content script miss (tab closed, script never
loaded, message lost, `chrome.idle` unavailable). It is **not** the primary idle
detector: at 30s periodicity it detects idleness 30–60s late and produces the
visible backward jump Step 1b exists to remove.

Late detection doesn't corrupt data — `tabLastActivity` records when input
actually stopped, so a late check retroactively excludes the idle period.
(Under tick-counting it can't; those seconds were already banked.) Inactivity
thresholds of 30–60s are unaffected; below 15s, `chrome.idle` can't be used at
all and the content script is the only detector.

### Step 5 — Manifest and build

- `manifest_version: 3`; `browser_action` → `action`; `<all_urls>` moves from
  `permissions` to `host_permissions`; `background.scripts` →
  `background.service_worker`; add `"alarms"` and `"idle"` permissions
  (neither shows a scary install warning)
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

## What other extensions do (surveyed 2026-08-06)

Checked so it doesn't get re-researched later. **Nothing worth copying.**

[Web Activity Time Tracker](https://github.com/Stigmatoz/web-activity-time-tracker)
(MV3, ~100k users, closest feature match — tracking, limits, blocking) uses
`setInterval(trackTime, 1000)` with `summaryTime += 1` per tick. It holds the
`alarms` permission but uses alarms **only** for daily summary notifications,
never for tracking or blocking. Structurally the same tick-counting this plan
is replacing.

It may work better than it deserves: `trackTime` calls
`windows.getLastFocused()` and `idle.queryState()` every second, and any
extension API call resets the 30s idle timer, so it likely keeps its own worker
alive as a side effect. That is accidental, and once the worker does die there
is no alarm to resurrect it. (Inferred from source, not measured.)

The common advice on
[chromium-extensions](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/7Ag1vPlb_qU)
is the keep-alive hack — see Step 1b for why not.

One genuinely useful find: `chrome.idle`, which WATT uses via `queryState` but
which is better used as `onStateChanged` (an event, so it wakes the worker).
Adopted in Step 1b.

**Correction to an earlier assumption:** since Chrome 110 there is no hard
5-minute worker lifetime cap — a worker lives as long as it receives events,
and any extension API call resets the timer. The 5-minute limit now applies only
to a single long-running request. This doesn't change the design (run 2 measured
7 deaths in 10 minutes of real use), but it isn't the ceiling it once was.

## Threat model

Worth stating, because it decides how much of the enforcement can safely live
in the content script — and the answer is "more than you'd assume."

This is a tool for overcoming your own bad habits, under rules you set for
yourself. The adversary is not a hostile user; it's you in a weak moment taking
the path of least resistance. So the goal is that **the easy path is the honest
one**, not that the hard path is impossible. Someone who opens devtools to
suppress a blocker has made a deliberate decision, and at that point
uninstalling is the more honest move. Defending against that costs complexity
and buys nothing.

What does matter is the *accidental* failure: a blocker that doesn't fire
because of a bug, or a timer that undercounts because the worker slept. That
isn't the user cheating, it's the tool being unreliable, and it erodes trust
until they stop using it.

Engineering effort therefore goes to correctness, not tamper-resistance. This
is why the content script can own the display and even show the blocker
optimistically at its local deadline, and why the three mitigations in Step 2
are aimed at bugs rather than at a determined user.

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
5. **Idle freeze, watching the widget.** Set the inactivity threshold to 30s,
   stop touching the machine, and watch the timer. It must stop within ~1s of
   the threshold and then **never jump backward** when you return and move the
   mouse. A backward jump means `USER_IDLE` isn't firing and the heartbeat is
   doing the detection — the artifact Step 1b exists to remove.
6. **Silent video, watching the widget.** Play a video and don't touch anything
   for 3+ minutes. The countdown must keep ticking accurately the whole time
   even though the worker is dying repeatedly (run 2: 7 deaths in 10 min). A
   frozen countdown here means 3a isn't working and the display is still
   passive.
7. **Slide-out.** Force the unverified state (kill the worker via
   `chrome://serviceworker-internals` while moving the mouse). The timer should
   slide out rather than hold a stale number, and slide back in on the next
   update. It must never show a number that later jumps.
8. **Lock the screen** mid-session with a video playing. `chrome.idle` should
   report `locked` immediately and the clock should stop — this is new
   behaviour; today a locked screen is indistinguishable from sitting still.
9. Sleep the laptop mid-session; confirm the gap is capped at the inactivity
   threshold rather than credited in full.
10. Regression-test the same flows in Firefox with the MV2 build.

## Open questions

None blocking. Both probe questions are answered (see Measured facts).

Worth checking during implementation:

- **Content-script timer under tab throttling.** Measured only in the active
  foreground tab, which is the case that matters. Background tabs throttle
  timers, but a session's tab is by definition the one being used. The alarm
  path is unaffected either way.
- **Cold-start cost under load.** The ~1s cold-start delivery was measured on an
  otherwise idle machine. If it degrades badly under load, the content-script
  timer becomes the more accurate of the two paths — which is already a reason
  to keep both.
