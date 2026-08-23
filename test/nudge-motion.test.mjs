// The nudge's blur, media pause, and timer scale-up are one interruption made
// of three moving parts, and nothing throws when they drift apart. The original
// bug was exactly that drift: the blur ran the full animation while the timer
// peaked at the halfway point, so the page stayed blurred through the shrink
// and the blur outlasted the number it was meant to point at. Media also
// resumed on the same timer that STARTED the 300ms blur fade, so video came
// back while the page was still visibly blurred.
//
// The paused window is deliberately short — grow only, no hold at the peak.
//
// Source-text, for the reason background-wiring.test.mjs is: reproducing this
// needs a browser and a stopwatch, and the failure looks like "the nudge feels
// off" rather than a stack trace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const content = readFileSync('src/content.ts', 'utf8');
const constants = readFileSync('src/shared/constants.ts', 'utf8');

/** The body of showNudge(), up to its closing brace at column 0. */
function showNudgeBody() {
  const i = content.indexOf('function showNudge()');
  assert.notEqual(i, -1, 'showNudge() not found');
  const end = content.indexOf('\n}\n', i);
  return content.slice(i, end);
}

test('the nudge durations are named phases, not one ambiguous total', () => {
  // NUDGE_MS meant both "blur length" and "half the animation", which is how
  // the two got tied together in the first place.
  assert.ok(!/NUDGE_MS\b/.test(constants), 'NUDGE_MS is back — split it into phases');
  for (const k of ['NUDGE_GROW_MS', 'NUDGE_SHRINK_MS']) {
    assert.match(constants, new RegExp(`${k}:\\s*\\d+`), `${k} missing from constants`);
  }
});

test('blur and media resume end together, at the timer peak', () => {
  const body = showNudgeBody();
  // One timeout, holding both effects, firing at grow+hold — the peak.
  const combined = /setTimeout\(\(\) => \{\s*hideBlurOverlay\(\);\s*playingMedia\.forEach\([^;]+;\s*\},\s*NUDGE_GROW_MS\)/;
  assert.match(
    body,
    combined,
    'hideBlurOverlay and the media resume must share one timeout at NUDGE_GROW_MS'
  );
  // And neither may be scheduled against the full animation.
  assert.ok(
    !/NUDGE_SHRINK_MS/.test(body.slice(body.indexOf('hideBlurOverlay'))),
    'the blur must not wait for the shrink'
  );
});

test('the shrink begins the moment the timer peaks — no hold', () => {
  // A hold was tried and cut: freezing the page longer read as too aggressive,
  // and at 8x the size already does the work. Reading time comes from the
  // shrink, which plays out unblurred.
  const body = showNudgeBody();
  assert.match(
    body,
    /transform = 'scale\(1\)';\s*\},\s*NUDGE_GROW_MS\)/,
    'the shrink must start at NUDGE_GROW_MS'
  );
  assert.ok(!/NUDGE_HOLD_MS/.test(body), 'the hold is gone; do not reintroduce it silently');
});

test('the paused window stays short', () => {
  // Grow IS the paused window — blur and playback end at the peak — so this is
  // the only number that can make the nudge feel aggressive. The shrink is
  // free and deliberately unbounded here.
  const m = /NUDGE_GROW_MS:\s*(\d+)/.exec(constants);
  assert.ok(m, 'NUDGE_GROW_MS not found');
  assert.ok(Number(m[1]) <= 600, `the page is held for ${m[1]}ms; 750 already read as too aggressive`);
});

test('the nudge reuses pauseAllMedia rather than re-inlining it', () => {
  const body = showNudgeBody();
  assert.match(body, /const playingMedia = pauseAllMedia\(\);/);
  assert.ok(
    !/querySelectorAll\('video, audio'\)/.test(body),
    'showNudge re-inlines the media walk; use pauseAllMedia()'
  );
});

test('the timer grows enough to be seen from across the screen', () => {
  const m = /const NUDGE_SCALE = (\d+)/.exec(content);
  assert.ok(m, 'NUDGE_SCALE not found');
  const scale = Number(m[1]);
  assert.ok(scale >= 7, `NUDGE_SCALE is ${scale}; 5x was too small to notice`);
  assert.ok(scale <= 8, `NUDGE_SCALE is ${scale}; past 8x it covers too much of the page`);
});
