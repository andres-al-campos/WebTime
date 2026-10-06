# WebTime

Browser extension that tracks time per site and enforces session limits. Ships
on Firefox (MV2) and Chrome (MV3) from one source.

## Build

`./build.sh` is the entry point. It typechecks, tests, and refreshes both
loadable dirs: `extension/` (Firefox) and `dist-chrome/` (Chrome). Never build
only one.

Debug logging is on for `./build.sh` and off for `release.sh`
(`WEBTIME_DEBUG=0`), substituted by esbuild rather than edited by hand.

## Architecture

Functional core, imperative shell. Decisions and arithmetic are pure modules in
`src/shared/`, tested without a browser. Effects — messaging, storage, alarms,
tickers — live in `src/background.ts`.

- `time-clock.ts` — timestamp accounting (`banked` + `runningSince`). Not tick
  counting: an MV3 worker dies mid-count and a tick that never fires is time
  silently lost.
- `clock-gates.ts` — whether time should be accruing. **Ordering is
  load-bearing** and has broken three times; it is tested for that reason.
- `session-model.ts` — session lifecycle arithmetic, nudge times, wake schedules.
- `interventions.ts` — which intervention is due (limit reached, nudge).

`background.ts` is the shell: listeners, dispatch, and the state the gates read.

## What actually breaks here

Both real regressions in the Chrome port were **callers bypassing correct
logic**, not wrong logic. Unit tests structurally cannot see this.

- A cached engagement flag recomputed only on tab/focus events, so it decayed
  to false during silent video playback.
- `handleTimerState` calling `startTimer`/`stopTimer` off engagement alone while
  `shouldClockRun()` was the real gate — two deciders that disagreed.

So: when a condition exists in more than one place, that is the bug. Route every
start/stop through `syncClock()`, which asks `shouldClockRun()`.

Chrome's keep-alive hides this class of bug by re-deriving state constantly.
Firefox's persistent background does not. **Test both.**

## Naming

`ensure*` means idempotent-with-effects (`ensureKeepAlive`, `ensureHeartbeat`,
`ensureSessionStarted`). A plain `get*` must not persist or schedule.

`ensureSessionStarted` was once `getOrStartSession`, which read as a getter
while it persisted state and re-armed the alarm schedule. That name caused a
real reordering bug during refactoring.

## Before renaming anything

Check whether the identifier crosses a serialization boundary — message `type`
strings, `storage.local` keys, alarm names. Those are string-matched at runtime
and TypeScript cannot follow them.

To prove a rename is behavior-preserving: rebuild, substitute the old name back
into the emitted bundle, and diff against the previous build. Byte-identical
means identifier-only.

`src/shared/protocol.ts` holds every such string as a named constant (`MSG`,
`STORAGE`, `ALARM`, `PORT`), so "is this serialized?" has one answer and a
rename is a compile error where it was missed. The values there are the wire
format and the on-disk keys: change a key and existing users' data is orphaned.

## Tests

`npm test` (node:test). Pure modules are bundled by esbuild and imported.

Test files bundle sources *without* esbuild's `define`, so anything reading
`__WEBTIME_DEBUG__` needs the `typeof` guard in `utils.ts`.

A few tests in `background-wiring.test.mjs` assert against `background.ts` as
source text. That is blunt and only as good as its patterns — used where the
failure is silent and needs a browser to reproduce (a popup gate that freezes
the clock forever).

**Always verify a new test fails when the code is broken.** Two tests written in
one session were green and useless until checked.

## Refactoring

Name the unnamed concepts first, then read the tension. Both bugs above existed
because a concept had no name: "whether the clock should run" was scattered
conditions until it became `clock-gates.ts`.

More small well-named files beats fewer big ones. In one file, drift between two
functions is invisible — there is no boundary for it to violate. The friction of
a boundary is the signal, not the cost.

A file being large is not itself a reason to split it. Extract when there is a
decision worth testing or a bug worth pinning. `checkWindDown` was left alone:
its arithmetic is already pure in `windDownState` and what remains is a
three-line edge flag.
