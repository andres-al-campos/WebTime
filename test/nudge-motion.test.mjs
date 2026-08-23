// The nudge's blur, media pause, and timer scale-up are one interruption made
// of three moving parts, and nothing throws when they drift apart. The original
// bug was exactly that drift: the blur ran the full animation while the timer
// peaked at the halfway point, so the page stayed blurred through the shrink
// and the blur outlasted the number it was meant to point at. Media also
// resumed on the same timer that STARTED the 300ms blur fade, so video came
// back while the page was still visibly blurred.
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
  for (const k of ['NUDGE_GROW_MS', 'NUDGE_HOLD_MS', 'NUDGE_SHRINK_MS']) {
    assert.match(constants, new RegExp(`${k}:\\s*\\d+`), `${k} missing from constants`);
  }
});

test('blur and media resume end together, at the timer peak', () => {
  const body = showNudgeBody();
  // One timeout, holding both effects, firing at grow+hold — the peak.
  const combined = /setTimeout\(\(\) => \{\s*hideBlurOverlay\(\);\s*playingMedia\.forEach\([^;]+;\s*\},\s*NUDGE_GROW_MS \+ NUDGE_HOLD_MS\)/;
  assert.match(
    body,
    combined,
    'hideBlurOverlay and the media resume must share one timeout at NUDGE_GROW_MS + NUDGE_HOLD_MS'
  );
  // And neither may be scheduled against the full animation.
  assert.ok(
    !/NUDGE_SHRINK_MS/.test(body.slice(body.indexOf('hideBlurOverlay'))),
    'the blur must not wait for the shrink'
  );
});

test('the shrink starts after the hold, not at the halfway point', () => {
  const body = showNudgeBody();
  assert.match(
    body,
    /transform = 'scale\(1\)';\s*\},\s*NUDGE_GROW_MS \+ NUDGE_HOLD_MS\)/,
    'the timer must hold at full size before shrinking'
  );
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
  assert.ok(Number(m[1]) >= 8, `NUDGE_SCALE is ${m[1]}; 5x was already too small to notice`);
});
