// Tests for the MV2 → MV3 manifest transform.
//
// These matter because a wrong manifest fails QUIETLY: Chrome loads the
// extension and it simply cannot see any pages, or the worker never starts.
// Checking the real manifest (not just a fixture) means adding a permission in
// Firefox and forgetting Chrome is caught here rather than at load time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { toMv3 } from '../manifest-chrome.mjs';

const real = JSON.parse(await readFile('extension/manifest.json', 'utf8'));

test('sets manifest_version to 3', () => {
  assert.equal(toMv3(real).manifest_version, 3);
});

test('browser_action becomes action, with the same content', () => {
  const mv3 = toMv3(real);
  assert.equal(mv3.browser_action, undefined);
  assert.deepEqual(mv3.action, real.browser_action);
});

test('background scripts become a single service worker', () => {
  const mv3 = toMv3(real);
  assert.equal(mv3.background.scripts, undefined);
  assert.equal(mv3.background.service_worker, real.background.scripts[0]);
});

test('multiple background scripts are a hard error, not a silent drop', () => {
  const two = { ...real, background: { scripts: ['a.js', 'b.js'] } };
  assert.throws(() => toMv3(two), /exactly one service worker/);
});

test('host patterns move from permissions to host_permissions', () => {
  const mv3 = toMv3(real);
  const isHost = p => p.includes('://') || p === '<all_urls>';
  // No host pattern may remain in permissions — Chrome ignores it there, and
  // the extension would load with no page access at all.
  assert.equal(mv3.permissions.filter(isHost).length, 0);
  // Every host pattern from the source survives the move.
  for (const p of real.permissions.filter(isHost)) {
    assert.ok(mv3.host_permissions.includes(p), `${p} missing from host_permissions`);
  }
});

test('non-host permissions are preserved', () => {
  const mv3 = toMv3(real);
  const isHost = p => p.includes('://') || p === '<all_urls>';
  for (const p of real.permissions.filter(p => !isHost(p))) {
    assert.ok(mv3.permissions.includes(p), `dropped permission: ${p}`);
  }
});

test('the permissions the MV3 port depends on are present', () => {
  // alarms drives every scheduled session deadline; idle is the third activity
  // signal. Losing either degrades silently rather than failing loudly.
  const mv3 = toMv3(real);
  assert.ok(mv3.permissions.includes('alarms'), 'alarms permission missing');
  assert.ok(mv3.permissions.includes('idle'), 'idle permission missing');
});

// The keep-alive is what makes the timer behave like a timer under MV3: without
// it Chrome kills the worker every ~30s and the count freezes and jumps. It is
// also invisible when broken — the extension loads and just keeps worse time —
// so the wiring is asserted here rather than left to manual testing.
test('the offscreen permission is added for Chrome', () => {
  assert.ok(toMv3(real).permissions.includes('offscreen'), 'offscreen permission missing');
});

test('offscreen is Chrome-only and stays out of the shared manifest', () => {
  // Firefox has a persistent background page and no offscreen API; the
  // permission there would only produce a warning.
  assert.ok(!(real.permissions || []).includes('offscreen'));
});

test('adding offscreen is idempotent', () => {
  // Guards the case where the shared manifest later gains it for some reason:
  // a duplicated permission is a load-time warning in Chrome.
  const once = toMv3(real).permissions.filter(p => p === 'offscreen');
  assert.equal(once.length, 1);
  const twice = toMv3(toMv3(real)).permissions.filter(p => p === 'offscreen');
  assert.equal(twice.length, 1);
});

test('the Firefox-only block is dropped', () => {
  assert.equal(toMv3(real).browser_specific_settings, undefined);
});

test('unrelated keys pass through untouched', () => {
  const mv3 = toMv3(real);
  assert.equal(mv3.version, real.version);
  assert.equal(mv3.name, real.name);
  assert.deepEqual(mv3.content_scripts, real.content_scripts);
  assert.deepEqual(mv3.icons, real.icons);
});

test('the transform does not mutate its input', () => {
  const before = JSON.parse(JSON.stringify(real));
  toMv3(real);
  assert.deepEqual(real, before);
});
