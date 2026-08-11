// The two popup gates freeze the clock while a modal is up, and must not
// strand it frozen when the modal closes.
//
// clock-gates.test.mjs already proves a raised flag stops the clock. What it
// cannot see is the wiring: whether every OPEN has a CLOSE that clears the same
// flag, and whether both re-run the gate afterwards. Those live in
// background.ts's message dispatch, which needs a browser to execute — so this
// asserts against the source instead.
//
// A source-level test is a blunt instrument and only as good as its patterns.
// It is here because the failure it guards against is bad and silent: a popup
// that sets the flag but never clears it leaves the timer frozen for the rest
// of the session, with nothing on screen to say why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/background.ts', 'utf8');

/** The flag each popup message pair drives. */
const GATES = [
  { open: 'END_SESSION_CONFIRM_OPEN', close: 'END_SESSION_CONFIRM_CLOSE', flag: 'endSessionConfirmOpen' },
  { open: 'AVERAGE_POPUP_OPEN', close: 'AVERAGE_POPUP_CLOSE', flag: 'averagePopupOpen' },
];

/** The dispatch body following `message.type === "<type>"`, up to the next branch. */
function branchBody(type) {
  const at = src.indexOf(`message.type === "${type}"`);
  assert.notEqual(at, -1, `no dispatch branch for ${type}`);
  const rest = src.slice(at);
  const next = rest.indexOf('message.type ===', 1);
  return next === -1 ? rest : rest.slice(0, next);
}

for (const { open, close, flag } of GATES) {
  test(`${open} raises ${flag} and re-runs the gate`, () => {
    const body = branchBody(open);
    assert.match(body, new RegExp(`${flag}\\s*=\\s*true`), `${open} must set ${flag} = true`);
    assert.match(body, /syncClock\(\)/, `${open} must call syncClock() so the freeze takes effect now`);
  });

  test(`${close} clears ${flag} and re-runs the gate`, () => {
    const body = branchBody(close);
    assert.match(body, new RegExp(`${flag}\\s*=\\s*false`), `${close} must set ${flag} = false`);
    assert.match(body, /syncClock\(\)/, `${close} must call syncClock() or the clock stays frozen`);
  });
}

test('each popup flag is only ever assigned by its own open/close pair', () => {
  // A third writer would make the flag's lifetime impossible to reason about
  // from the dispatch alone — the shape that produced two deciders for the
  // clock, where one caller set state another was responsible for.
  for (const { flag } of GATES) {
    // Exclude the `let flag = false` declaration; only reassignments count.
    const writes = src.match(new RegExp(`(?<!let\\s)${flag}\\s*=\\s*(true|false)`, 'g')) || [];
    assert.equal(writes.length, 2, `${flag} should have exactly one true and one false assignment`);
  }
});

test('the dispatch is a single chain, so message types stay mutually exclusive', () => {
  // Ten independent ifs meant every message tested every condition, and a
  // duplicated type string would silently run two handlers.
  const at = src.indexOf('function handleMessageReceived(');
  assert.notEqual(at, -1);
  const body = src.slice(at, src.indexOf('\n}\n', at));
  const branches = body.match(/if \(message\.type === "/g) || [];
  const chained = body.match(/} else if \(message\.type === "/g) || [];
  assert.equal(
    chained.length,
    branches.length - 1,
    'every dispatch branch after the first must be chained with else',
  );
});
