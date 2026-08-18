// Does a mousemove/scroll actually count as user activity?
//
// This is the caller-bypasses-correct-logic class: the inactivity gate in
// clock-gates.ts is right, and the background polls it every second. The bug
// was in what the content script FED it — a mousemove fires whenever the
// element under the pointer changes, not only when the pointer moves, so an
// autoplaying carousel refreshed tabLastActivity forever and the countdown
// never reached the threshold.
//
// So this runs the real listeners against real events rather than reading the
// source: the thing under test is whether a stationary-pointer event reaches
// sendMessage at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Minimal DOM: records listeners so the test can dispatch to them directly. */
function makeEnv() {
  const listeners = {};
  const sent = [];
  const el = () => ({
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    append() {}, appendChild() {}, remove() {}, setAttribute() {},
    addEventListener() {}, querySelectorAll: () => [], textContent: '',
  });
  globalThis.document = {
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    createElement: el,
    querySelectorAll: () => [],
    querySelector: () => null,
    body: el(),
    documentElement: el(),
    readyState: 'complete',
    hidden: false,
  };
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    location: { hostname: 'example.com', href: 'https://example.com/' },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  globalThis.browser = globalThis.chrome = {
    runtime: {
      sendMessage: msg => { sent.push(msg); return { catch() {} }; },
      onMessage: { addListener() {} },
      id: 'test',
    },
    storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
  };
  return { listeners, sent };
}

const env = makeEnv();

// The content script arms intervals at import time. They would keep the test
// process alive forever, and none of them are what is under test here — the
// listeners are registered synchronously during the same import.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;

const out = mkdtempSync(join(tmpdir(), 'webtime-activity-test-'));
const outFile = join(out, 'content.mjs');
await build({
  entryPoints: ['src/content.ts'],
  bundle: true,
  format: 'esm',
  outfile: outFile,
  platform: 'browser',
});
await import(pathToFileURL(outFile).href);
globalThis.setInterval = realSetInterval;

const fire = (type, ev) => (env.listeners[type] || []).forEach(fn => fn(ev));
const activityPings = () => env.sent.filter(m => m && m.type === 'USER_ACTIVE').length;

/** A mousemove at fixed screen coords, as a moving page under a still cursor sends. */
const moveAt = (x, y) => ({ type: 'mousemove', screenX: x, screenY: y, clientX: x, clientY: y, isTrusted: true });

test('the listeners the activity path needs are registered', () => {
  for (const type of ['mousemove', 'scroll', 'keydown']) {
    assert.ok((env.listeners[type] || []).length > 0, `no ${type} listener`);
  }
});

test('a page moving under a stationary cursor is not user activity', () => {
  // The exact shape of the bug: identical screen coords, fired for as long as
  // the carousel animates. Time must ADVANCE between events — the 5s ping
  // throttle would otherwise swallow them on its own and prove nothing about
  // the coordinate check. A real animation runs for minutes.
  fire('mousemove', moveAt(500, 400)); // establishes the position
  const before = activityPings();
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    for (let i = 0; i < 40; i++) {
      t += 10_000; // 10s apart: every one of these clears the 5s throttle
      fire('mousemove', moveAt(500, 400));
    }
  } finally {
    Date.now = realNow;
  }
  assert.equal(
    activityPings(), before,
    'a mousemove with unchanged screen coordinates must not count as activity',
  );
});

test('scrolling under a still pointer is not a mouse move', () => {
  // Client coords are viewport-relative, so a scroll changes them while the
  // pointer is perfectly still — the same false positive one layer down. Only
  // screen coords stay fixed, which is why the check uses them.
  fire('mousemove', moveAt(500, 400));
  const before = activityPings();
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    for (let i = 1; i <= 20; i++) {
      t += 10_000;
      // Pointer unmoved on screen; the document scrolled 40px under it.
      fire('mousemove', {
        type: 'mousemove', isTrusted: true,
        screenX: 500, screenY: 400,
        clientX: 500, clientY: 400 - i * 40,
      });
    }
  } finally {
    Date.now = realNow;
  }
  assert.equal(
    activityPings(), before,
    'scrolling under a stationary pointer must not count as a mouse move',
  );
});

test('a real mouse move is still user activity', () => {
  // Defeat the 5s ping throttle by moving, waiting past it, and moving again.
  fire('mousemove', moveAt(10, 10));
  const before = activityPings();
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try {
    fire('mousemove', moveAt(700, 300));
    assert.equal(activityPings(), before + 1, 'a genuine pointer move must ping');
  } finally {
    Date.now = realNow;
  }
});

test('a scroll the page drives itself is not user activity', () => {
  const before = activityPings();
  const realNow = Date.now;
  Date.now = () => realNow() + 120_000; // past the throttle, so only isTrusted decides
  try {
    fire('scroll', { type: 'scroll', isTrusted: false });
    assert.equal(activityPings(), before, 'an untrusted scroll must not count as activity');
  } finally {
    Date.now = realNow;
  }
});

test('a scroll the user drives is user activity', () => {
  const before = activityPings();
  const realNow = Date.now;
  Date.now = () => realNow() + 180_000;
  try {
    fire('scroll', { type: 'scroll', isTrusted: true });
    assert.equal(activityPings(), before + 1, 'a trusted scroll must count as activity');
  } finally {
    Date.now = realNow;
  }
});
