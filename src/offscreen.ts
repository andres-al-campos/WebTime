// Keep-alive companion for the MV3 service worker.
//
// WHY THIS EXISTS
//
// Chrome terminates the service worker after ~30 seconds idle (measured: 7
// deaths in 10 minutes of untouched video playback). WebTime is a timer, so a
// background that stops running is the one thing it can't tolerate — the count
// freezes, then jumps when the worker next wakes.
//
// Everything else we tried worked around the death rather than preventing it:
// the content script kept its own clock, a staleness rule decided when to
// trust it, and a recovery step credited the gap on wake. Three mechanisms,
// each correct alone, disagreeing at the edges — the timer drifted, hid
// itself, and leapt forward. Keeping the worker alive removes the problem
// instead of compensating for it.
//
// The mechanism: a long-lived message port from this document resets the
// worker's idle timer. Reconnecting on disconnect covers the case where Chrome
// tears the port down anyway.
//
// Cost: the worker stays resident, which uses some battery. That's the trade
// deliberately accepted — a timer that doesn't behave like a timer is not
// worth saving power for.
//
// CHROME ONLY — BUT BUILT FOR BOTH
//
// Nothing here runs on Firefox. Its background page is persistent, so there is
// no worker death to prevent, and it has no offscreen API at all: the document
// is created at runtime by chrome.offscreen.createDocument(), which
// background.ts guards behind a `chrome.offscreen !== undefined` check that is
// false on Firefox. No manifest references offscreen.html on either browser.
//
// The bundle is still emitted into `extension/dist/` for the Firefox build,
// where nothing ever loads it: a dead file costing a few kilobytes, against a
// second conditional build path that could get the live browser wrong. If
// AMO's linter ever flags the unreferenced file, that is the trade to
// revisit — see build.mjs, which makes the same call from its end.

import { MSG, PORT } from './shared/protocol.js';


// Chrome's idle timer is ~30s. Reconnecting well inside that keeps the worker
// up even if a port is dropped silently.
const RECONNECT_MS = 20000;

function connect(): void {
  const port = chrome.runtime.connect({ name: PORT.KEEPALIVE });

  port.onDisconnect.addListener(() => {
    // The worker was replaced (extension reload/update) or Chrome dropped the
    // port. Reconnecting re-establishes the keep-alive against the new worker.
    setTimeout(connect, 1000);
  });

  // Periodic traffic on the port, not just its existence. An open-but-silent
  // port is not reliably enough to reset the idle timer across Chrome versions.
  const beat = setInterval(() => {
    try {
      port.postMessage({ type: MSG.KEEPALIVE });
    } catch {
      clearInterval(beat);   // port is dead; onDisconnect handles reconnecting
    }
  }, RECONNECT_MS);
}

connect();
