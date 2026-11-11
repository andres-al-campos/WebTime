// The wind-down bar once ran on a local deadline in content.ts and kept
// draining while the clock was paused (alt-tab, a popup), out of step with the
// timer beside it. It now renders from the timer's own numbers through
// windDownProgress. Needs a browser to see go wrong, so this reads the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/content.ts', 'utf8');
const start = src.indexOf('// Wind-Down Overlay');
const end = src.indexOf('// End Session Early');
const section = src.slice(start, end);

test('wind-down bar reads the timer, not a clock of its own', () => {
  assert.ok(start > 0 && end > start, 'wind-down section markers moved: update this test');
  assert.ok(!/Date\.now\(\)/.test(section),
    'content.ts wind-down code calls Date.now(): the bar would advance on its own ' +
    'while the clock is paused. Render it from lastSessionTime/lastSessionLimitSeconds ' +
    'via windDownProgress instead.');
  assert.match(section, /windDownProgress\(lastSessionTime!?, lastSessionLimitSeconds!?\)/,
    'the wind-down bar must take its progress from windDownProgress(lastSessionTime, lastSessionLimitSeconds).');
});
