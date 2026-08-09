// Keep-alive companion for the MV3 service worker.
//
// WHY THIS EXISTS
//
// Chrome terminates the service worker after ~30 seconds idle (measured: 7
// deaths in 10 minutes of untouched video playback, tools/mv3-probe). WebTime
// is a timer, so a background that stops running is the one thing it can't
// tolerate — the count freezes, then jumps when the worker next wakes.
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

const PORT_NAME = 'webtime-keepalive';

// Chrome's idle timer is ~30s. Reconnecting well inside that keeps the worker
// up even if a port is dropped silently.
const RECONNECT_MS = 20000;

function connect(): void {
  const port = chrome.runtime.connect({ name: PORT_NAME });

  port.onDisconnect.addListener(() => {
    // The worker was replaced (extension reload/update) or Chrome dropped the
    // port. Reconnecting re-establishes the keep-alive against the new worker.
    setTimeout(connect, 1000);
  });

  // Periodic traffic on the port, not just its existence. An open-but-silent
  // port is not reliably enough to reset the idle timer across Chrome versions.
  const beat = setInterval(() => {
    try {
      port.postMessage({ type: 'KEEPALIVE' });
    } catch {
      clearInterval(beat);   // port is dead; onDisconnect handles reconnecting
    }
  }, RECONNECT_MS);
}

connect();
