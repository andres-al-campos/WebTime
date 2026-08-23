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
  // and at 7x the size already does the work. Reading time comes from the
  // shrink, which plays out unblurred.
  const body = showNudgeBody();
  assert.ok(!/NUDGE_HOLD_MS/.test(body), 'the hold is gone; do not reintroduce it silently');

  // Walk from the scale(1) write to the delay that arms ITS setTimeout: the
  // first `}, X);` that closes at the same nesting depth the write sits at.
  // (Position alone is not enough — inner cleanup timeouts close first, and the
  // blur's own timeout further down also happens to use NUDGE_GROW_MS.)
  const from = body.indexOf("transform = 'scale(1)'");
  assert.ok(from !== -1, 'no shrink found');
  let depth = 0;
  let arm = null;
  for (let k = from; k < body.length; k++) {
    const ch = body[k];
    if (ch === '{' || ch === '(') depth++;
    else if (ch === '}' || ch === ')') {
      if (depth === 0 && ch === '}') {
        const m = /^\},\s*([^)]*?)\);/.exec(body.slice(k));
        if (m) { arm = m[1].trim(); break; }
      }
      depth--;
    }
  }
  assert.ok(arm !== null, 'could not find the delay arming the shrink');
  assert.equal(arm, 'NUDGE_GROW_MS', 'the shrink must be armed at NUDGE_GROW_MS exactly — no hold');
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

test('the timer text is suspended while the nudge animates', () => {
  // startLocalTick rewrites the text every second. At 7x that re-rasterizes the
  // enlarged glyphs mid-transform and stutters the animation, and a 1000ms
  // animation always crosses a second boundary.
  assert.match(content, /let nudgeAnimating = false;/, 'the suspend flag is gone');
  const update = content.slice(content.indexOf('function updateTimerText'));
  assert.match(
    update.slice(0, update.indexOf('\n}\n')),
    /if \(nudgeAnimating\) return;/,
    'updateTimerText must bail while a nudge animates'
  );
});

test('the suspend flag is always cleared, and the text catches up', () => {
  const body = showNudgeBody();
  assert.match(body, /nudgeAnimating = true;/);
  // Cleared at the END of the shrink, not at the peak — the element is still
  // scaled on the way down.
  assert.match(
    body,
    /nudgeAnimating = false;\s*updateTimerText\(\);\s*\},\s*NUDGE_SHRINK_MS\)/,
    'the flag must clear after the shrink and re-render immediately'
  );
});

test('a nudge cannot re-enter and strand the flag', () => {
  // Stacked timeouts would leave nudgeAnimating stuck true, freezing the timer
  // text permanently. nextNudgeToFire can hand over a backlog.
  const body = showNudgeBody();
  const guard = body.slice(0, body.indexOf('const { NUDGE_GROW_MS'));
  assert.match(guard, /if \(nudgeAnimating\) return;/, 'showNudge needs a re-entry guard');
});

test('the scaled timer gets its own compositor layer', () => {
  const body = showNudgeBody();
  assert.match(body, /willChange = 'transform';/);
  // And it must be released — a permanent willChange keeps a layer alive.
  assert.match(body, /willChange = '';/, 'willChange must be cleared after the animation');
});
