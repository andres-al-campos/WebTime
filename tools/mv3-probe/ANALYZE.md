# Reading the probe results

Open the probe's service worker console:
`chrome://extensions` → MV3 Probe → **service worker** → Console tab.

Paste this in and it prints both answers:

```js
chrome.storage.local.get('log').then(({log = []}) => {
  const fired = log.filter(e => e.ev === 'ALARM_FIRED');
  console.log('--- Q1: alarm precision (alarms.create({when})) ---');
  console.table(fired.map(e => ({
    requestedDelayMs: e.requestedDelay,
    driftMs: e.driftMs,
  })));
  if (fired.length) {
    const drifts = fired.map(e => e.driftMs);
    console.log('drift min/median/max ms:',
      Math.min(...drifts),
      drifts.sort((a,b)=>a-b)[Math.floor(drifts.length/2)],
      Math.max(...drifts));
  }

  console.log('--- Q2: worker deaths ---');
  const boots = [...new Set(log.map(e => e.boot))];
  console.log('distinct worker boots:', boots.length);
  const play = log.filter(e =>
    ['VIDEO_PLAY','VIDEO_PAUSE','VIDEO_ENDED','WORKER_BOOT','HEARTBEAT','CS_TIMER_FIRED','AUDIBLE_CHANGE']
      .includes(e.ev));
  console.table(play.map(e => ({
    ev: e.ev,
    boot: e.boot,
    t: new Date(e.at).toLocaleTimeString(),
    detail: e.detail ? JSON.stringify(e.detail).slice(0,60) : '',
  })));

  console.log('--- content-script timer accuracy ---');
  console.table(log.filter(e => e.ev === 'MSG' && e.kind === 'CS_TIMER_FIRED')
    .map(e => e.detail));
});
```

## How to read it

**Q1 — alarm precision.** Look at `driftMs`. Near zero (tens of ms) means
`alarms.create({when})` is precise enough to schedule session ends directly,
and the content-script timer is pure redundancy. Consistently large or erratic
(seconds) means the content-script `setTimeout` has to be the primary
scheduler, with the alarm as backup.

**Q2 — worker death during silent playback.** Between a `VIDEO_PLAY` and the
next event, check whether the `boot` id changed. Same boot id throughout = the
worker stayed alive. A new boot id = it died and was resurrected. If boot ids
change every ~30s during playback, the worker is dying constantly and every
tick-based assumption in the current design is broken on Chrome.

**Content-script timer.** `CS_TIMER_FIRED` drift over a 90s window in the
active tab. Small drift confirms the content script can be trusted to fire
session deadlines on time.

## Lifetime run (Q2)

With `MODE = 'lifetime'` in [sw.js](sw.js) there is no heartbeat and a single
3-minute alarm, so the worker gets a real idle window. Reload the extension,
play a video, and leave the machine alone for ~5 minutes. Then:

```js
chrome.storage.local.get('log').then(({log = []}) => {
  const boots = [...new Set(log.map(e => e.boot))];
  console.log('distinct worker boots:', boots.length);
  console.log(boots.length > 1
    ? 'Q2: worker DIED and was resurrected — heartbeat is mandatory'
    : 'Q2: worker survived unaided across the idle window');
  console.table(log.map(e => ({
    ev: e.ev, boot: e.boot,
    t: new Date(e.at).toLocaleTimeString(),
    gapSec: '',
  })));
});
```

More than one boot id = the worker died. One boot id across a 5-minute
untouched window = it survived on its own.

## Running it

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select `tools/mv3-probe/` in this repo
3. Open a YouTube video, start playback, then **do not touch the mouse or
   keyboard** for ~3 minutes. Leave the Chrome window focused.
4. Run the analysis snippet above.

The no-touching part is the whole experiment — any interaction generates events
that keep the worker alive and mask the behavior being measured.
