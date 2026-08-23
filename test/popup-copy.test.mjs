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

// Zero means "no nudges", but a box reading "0 min" reads as an interval that
// happens to be zero rather than a state. The stepper renders a word there
// instead and hides the unit. Source-text, like the rest of this file: nothing
// throws when a setting merely reads wrong.
const card = readFileSync('src/popup/session-card.ts', 'utf8');

test('the nudge stepper shows a word at zero, not "0 min"', () => {
  assert.match(card, /zeroLabel: 'Disabled'/, "the nudge stepper must pass a zeroLabel");
});

test('the zero label hides the unit suffix', () => {
  // "Off min" would be worse than "0 min".
  assert.match(
    card,
    /if \(unitEl\) unitEl\.style\.display = off \? 'none' : '';/,
    'the unit must be hidden while the zero label shows'
  );
});

test('the zero label is accepted back when typed', () => {
  // The field is contentEditable and renders "Off"; committing that text must
  // mean zero, not revert to the previous value.
  assert.match(card, /raw\.toLowerCase\(\) === opts\.zeroLabel\.toLowerCase\(\)/);
});

// ── Zero as a state vs zero as a quantity ────────────────────────────────────
// "Disabled" was right for the nudge interval because a zero there is a real,
// handled state. The other steppers are not the same case, and these pin the
// two that were looked at and deliberately left without a zero label.

const uiMgr = readFileSync('src/popup/ui-manager.ts', 'utf8');

test('the cooldown pair cannot be set to 0m0s', () => {
  // A zero cooldown makes the session limit inert — hit it, wait nothing, keep
  // going. If sessions are on, the cooldown is part of the deal. The floor sits
  // on the pair (0s is fine above a minute), so it reads the minutes box.
  assert.match(card, /min: \(\) => \(coolMin === 0 \? 5 : 0\)/,
    'the seconds box must floor at 5s while the minutes box is 0');

  // The seconds floor cannot see a change made in the minutes box, so dropping
  // to 0m with the seconds already at 0 needs its own push.
  const onMin = /coolMin = v;([\s\S]*?)persistCooldown\(\);/.exec(card);
  assert.ok(onMin, "the minutes stepper's onChange must be findable");
  assert.match(onMin[1], /coolMin === 0 && coolSec === 0/,
    'dropping to 0m at 0s must lift the seconds off zero');
  assert.match(onMin[1], /secStepper\.setValue/,
    'the seconds box must be told, or its display desyncs from the stored value');
});

test('inactivity floors above zero, because zero stops the clock forever', () => {
  // isActive() is `now - lastActivity < threshold`. At 0 that is false the
  // instant activity is recorded, so the tab never counts as active and time
  // never accrues. A "0 = instant" label would name a state the code breaks in.
  const call = /'inactivity-stepper'[\s\S]*?\}\);/.exec(uiMgr);
  assert.ok(call, 'the inactivity stepper must be findable');
  assert.match(call[0], /min: 5\b/, 'inactivity must not be settable to 0');
  assert.match(call[0], /step: 5\b/, 'inactivity steps in 5s, like the cooldown seconds');
  assert.doesNotMatch(call[0], /zeroLabel/, 'zero is unreachable here, so a zero label would be dead code');
});

test('a dynamic min is honoured when typing, not just when stepping', () => {
  // Two commit paths read the bound. If only stepOnce used the live value,
  // typing "0" into the seconds box would walk straight through the floor.
  assert.match(card, /const minOf = \(\) =>/, 'the stepper must resolve min through one helper');
  assert.match(card, /cur = quantize\(Math\.max\(minOf\(\)/, 'commitTyped must clamp to the live min');
  assert.match(card, /const min = minOf\(\);/, 'stepOnce must read the live min');
});

test('aborting a shortcut capture restores what was there, not the default', () => {
  // The field showed '(disabled)' while dataset.disabled stayed set. Restoring a
  // hardcoded 'Ctrl+E' on abort left the display saying Ctrl+E while save() —
  // which reads the dataset flag, not the text — still stored null. Two deciders
  // for one state, disagreeing. It also forgot custom shortcuts on a stray focus.
  assert.match(uiMgr, /let priorValue = input\.value;/, 'capture must remember the prior value');
  assert.match(uiMgr, /priorValue = input\.value;[\s\S]{0,120}input\.value = 'Press a key combo/,
    'the prior value must be captured on focus, before the placeholder overwrites it');
  assert.match(uiMgr, /input\.value = priorValue;/, 'abort must restore it');
  assert.doesNotMatch(uiMgr, /input\.value = 'Ctrl\+E';/, "abort must not hardcode the default");
});

test('the shortcut label is display text, not program state', () => {
  // "(disabled)" was BOTH the label and a sentinel that saveSettings compared
  // against. That made rewording the label a behaviour change: rename it and the
  // comparison stops matching, so a disabled shortcut saves as enabled. The
  // dataset flag is the one decider now, and the label is free to be reworded.
  const save = /export async function saveSettings[\s\S]*?\n\}/.exec(uiMgr);
  assert.ok(save, 'saveSettings must be findable');
  assert.doesNotMatch(save[0], /value !== SHORTCUT_DISABLED_LABEL|value !== '\(disabled\)'/,
    'save must not decide disabled-ness by comparing the displayed text');
  assert.match(save[0], /dataset\.disabled === 'true'/, 'the dataset flag is the decider');

  // One definition of the word, so it cannot drift between the three sites.
  assert.match(uiMgr, /const SHORTCUT_DISABLED_LABEL = /, 'the label must be defined once');
  assert.doesNotMatch(uiMgr, /'\(disabled\)'/, 'no stray literal copies of the label');
});

test('reopening the settings sheet keeps a disabled shortcut disabled', () => {
  // The flag used to be set only by the clear button, so after a reload the
  // field read "disabled" while the flag was unset — the next save re-enabled
  // the shortcut the user had turned off.
  assert.match(uiMgr, /if \(sc === null\) endSessionShortcutEl\.dataset\.disabled = 'true';\s*\n\s*else delete endSessionShortcutEl\.dataset\.disabled;/,
    'load must sync the flag to the stored value in both directions');
});

test('the settings sheet wires its controls once, not once per open', () => {
  // loadSettings runs on every open. Everything it mounts is guarded — the
  // steppers and dropdown keep registries, setupShortcutCapture uses a dataset
  // flag — except the shortcut's clear button, which stacked a listener per
  // open. Harmless only because the handler is idempotent.
  const clear = /const endSessionShortcutClearEl[\s\S]*?\n    \}/.exec(uiMgr);
  assert.ok(clear, 'the clear-button wiring must be findable');
  assert.match(clear[0], /dataset\.clearSetup !== 'true'/, 'the clear button must be wired once');
  assert.match(clear[0], /dataset\.clearSetup = 'true'/, 'and must record that it was');

  // The handler outlives the loadSettings call that wired it, so it must look
  // the field up when it fires rather than capturing a possibly-stale node.
  assert.match(clear[0], /getElementById\('end-session-shortcut'\)/,
    're-query the field inside the handler, do not close over it');
});
