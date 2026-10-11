// The web app's two engine copies must match each other and, when the
// extension sits next to this repo, the canonical extension/changelog.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const serverCopy = path.join(ROOT, 'lib', 'engine', 'changelog.js');
const browserCopy = path.join(ROOT, 'public', 'engine', 'changelog.js');
const canonical = path.join(ROOT, '..', 'extension', 'changelog.js');

test('the two web-app engine copies are identical', () => {
  assert.ok(fs.readFileSync(serverCopy).equals(fs.readFileSync(browserCopy)));
});

test('the engine copies match extension/changelog.js', t => {
  if (!fs.existsSync(canonical)) { t.skip('extension/ not next to web-app/; comparison skipped'); return; }
  assert.ok(fs.readFileSync(serverCopy).equals(fs.readFileSync(canonical)), 'run `npm run sync-engine`');
});

test('the engine loads under CommonJS', () => {
  const { VisorChangelog } = require('../lib/engine/changelog.js');
  assert.strictEqual(typeof VisorChangelog.buildTimeline, 'function');
  assert.strictEqual(typeof VisorChangelog.analyze, 'function');
});
