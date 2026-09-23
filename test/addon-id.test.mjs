// The Firefox add-on id is where every user's data lives.
//
// Firefox keys an extension's storage to its id. A build with a new id is a
// different extension: it opens empty, and uninstalling the old copy deletes
// the old data. On 2026-06-17 a "cleanup" changed this id and months of
// history were lost that way. AMO also rejects any id but the published one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PUBLISHED_ID = 'webtime@somedomain.com';

test('the Firefox add-on id is the published one', () => {
  const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
  const id = manifest.browser_specific_settings?.gecko?.id;
  assert.equal(
    id,
    PUBLISHED_ID,
    `Add-on id changed to "${id}". Every existing install's data is stored ` +
      `under "${PUBLISHED_ID}" and would be orphaned, and AMO will reject the ` +
      `upload. Put the id back in extension/manifest.json.`
  );
});
