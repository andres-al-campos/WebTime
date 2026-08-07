// Probe content script.
//
// IMPORTANT: every message sent to the background is itself a wake source, so
// this deliberately stays quiet. It announces when video playback starts and
// then says nothing until playback ends. The silence in between is exactly the
// condition we are trying to measure (Q2: does the worker die during silent
// audible playback?).
//
// It also records, locally, whether a local setTimeout scheduled for a distant
// instant fires on time in the active foreground tab -- the content-script half
// of the "scheduled wake" design.

(function () {
  const seen = new WeakSet();

  function report(kind, detail) {
    try {
      chrome.runtime.sendMessage({ kind, detail });
    } catch (e) {
      // Worker teardown races are expected and are not interesting here.
    }
  }

  function watch(el) {
    if (seen.has(el)) return;
    seen.add(el);

    el.addEventListener('play', () => {
      report('VIDEO_PLAY', { src: (el.currentSrc || '').slice(0, 80) });

      // Content-script timer accuracy check: schedule a single ping 90s out.
      // If this fires close to on time, the content script is a reliable
      // scheduler for session deadlines even while the worker is dead.
      const target = Date.now() + 90000;
      setTimeout(() => {
        report('CS_TIMER_FIRED', { driftMs: Date.now() - target, plannedMs: 90000 });
      }, 90000);
    });

    el.addEventListener('pause', () => report('VIDEO_PAUSE', {}));
    el.addEventListener('ended', () => report('VIDEO_ENDED', {}));
  }

  function scan() {
    document.querySelectorAll('video, audio').forEach(watch);
  }

  scan();
  new MutationObserver(scan).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
