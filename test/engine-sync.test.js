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

// The document model (formats, runs, deltas): edited in public/, copied to lib/
test('lib/doc-format.js is identical to public/doc-format.js', () => {
  const a = fs.readFileSync(path.join(ROOT, 'lib', 'doc-format.js'));
  const b = fs.readFileSync(path.join(ROOT, 'public', 'doc-format.js'));
  assert.ok(a.equals(b), 'run `npm run sync-engine`');
});

// An assignment's settings in plain words: edited in public/, copied to lib/
test('lib/assignment-text.js is identical to public/assignment-text.js', () => {
  const a = fs.readFileSync(path.join(ROOT, 'lib', 'assignment-text.js'));
  const b = fs.readFileSync(path.join(ROOT, 'public', 'assignment-text.js'));
  assert.ok(a.equals(b), 'run `npm run sync-engine`');
});
