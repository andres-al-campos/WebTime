// The average popup's heading is nowrap in a fixed-width box, so its font size
// and its longest possible string are coupled: at 18px the longest primaryLine
// measures 296px against 302px of usable width inside the 350px dialog. Six
// pixels of headroom.
//
// This is a source-text test for the same reason background-wiring.test.mjs is:
// the failure is silent and needs a browser to see. Nothing throws when nowrap
// text overflows — it just runs out of the rounded corner, and only on the
// longer of the two strings, so a casual check of the popup misses it.
//
// It cannot measure text. What it can do is refuse to let the size drift
// without someone re-measuring, and refuse to let the strings grow past the
// ones that were measured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/content.ts', 'utf8');

/** The `makeEl` call assigned to `const <name>`, up to its closing `});`. */
function elementCall(name) {
  const at = src.indexOf(`const ${name} = makeEl(`);
  assert.notEqual(at, -1, `no makeEl call assigned to ${name}`);
  const end = src.indexOf('});', at);
  assert.notEqual(end, -1, `unterminated makeEl call for ${name}`);
  return src.slice(at, end);
}

test('the average popup heading keeps the size its nowrap was measured at', () => {
  const primary = elementCall('primary');
  assert.match(primary, /white-space: nowrap/, 'heading must stay nowrap');
  assert.match(
    primary,
    /font-size: 18px/,
    'heading is 18px because that is what the 296px-of-302px measurement was taken at — ' +
    'changing it needs a re-measure in a browser, not an edit here',
  );
});

test('the average popup heading strings stay the ones that were measured', () => {
  // 33 chars: "You've reached your 7-day average", the longer of the two.
  const MEASURED_MAX = 33;
  const lines = [...src.matchAll(/^\s*[:?]\s*`([^`]*7-day average)`/gm)].map(m => m[1]);
  assert.equal(lines.length, 2, 'expected both primaryLine branches');
  for (const line of lines) {
    // The interpolated count is at most 3 digits ("120 min until..."), and that
    // form is the shorter branch anyway, so raw length is a fair proxy here.
    const width = line.replace('${minutesLeft}', '120').length;
    assert.ok(
      width <= MEASURED_MAX,
      `"${line}" is ${width} chars, past the ${MEASURED_MAX} that fit at 18px — re-measure before lengthening`,
    );
  }
});
