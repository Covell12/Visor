// The assignment page's Session settings save one setting at a time
// (assignments.js asSave: PATCH { writing: { <key>: value } }). Each such
// change must leave every other setting as it was, and a refused value must
// change nothing. Pure lib/assignments.js checks; no server, no network.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const A = require('../lib/assignments');

// What the page sends for each control, and a value of the other kind
const CHANGES = {
  timeLimitMin: '30', windowStart: '2026-11-01T14:00:00.000Z', windowEnd: '2026-11-02T14:00:00.000Z',
  allowPaste: 'block', researchTracking: false, blockAiSites: false, blockedSites: ['chatgpt.com', 'claude.ai'],
  allowedSites: ['en.wikipedia.org'], requireExtension: true, panelBrowsing: false, citationStyle: 'apa', oneClickCite: false,
  worksCited: 'panel', docStyle: 'docs', minWords: '200', maxWords: '900', templateText: 'Name:\nPeriod:', autoSubmitOnTimeUp: true, pauseGraceSec: '15'
};

test('each setting saved on its own leaves the rest alone', () => {
  for (const [k, v] of Object.entries(CHANGES)) {
    const before = A.defaultWriting('open');
    const after = A.cleanWriting({ [k]: v }, before);
    for (const other of Object.keys(before)) {
      if (other === k) continue;
      assert.deepStrictEqual(after[other], before[other], `saving ${k} changed ${other}`);
    }
    assert.notDeepStrictEqual(after[k], before[k], `${k} didn't change`);
  }
});

test('the session type: locked turns the extension on and follows its time-up default', () => {
  const open = A.defaultWriting('open');
  const locked = A.cleanWriting({ mode: 'locked' }, open);
  assert.deepStrictEqual([locked.mode, locked.requireExtension, locked.autoSubmitOnTimeUp], ['locked', true, true]);
  // turning the extension off is ignored while locked
  assert.strictEqual(A.cleanWriting({ requireExtension: false }, locked).requireExtension, true);
  const back = A.cleanWriting({ mode: 'open' }, locked);
  assert.deepStrictEqual([back.mode, back.autoSubmitOnTimeUp], ['open', false]);
  // the other settings stay
  assert.deepStrictEqual(back.blockedSites, open.blockedSites);
});

test('refused values change nothing', () => {
  const w = A.cleanWriting({ windowStart: '2026-11-02T14:00:00.000Z' }, A.defaultWriting('open'));
  const snapshot = JSON.stringify(w);
  for (const bad of [{ windowEnd: '2026-11-01T14:00:00.000Z' }, { timeLimitMin: '0' }, { timeLimitMin: '601' }, { allowPaste: 'sometimes' }, { worksCited: 'end' }, { pauseGraceSec: '-1' }, { mode: 'strict' }]) {
    assert.throws(() => A.cleanWriting(bad, w), { status: 400 }, JSON.stringify(bad));
    assert.strictEqual(JSON.stringify(w), snapshot);
  }
  // min above max is refused whichever is saved second
  const withMax = A.cleanWriting({ maxWords: '300' }, w);
  assert.throws(() => A.cleanWriting({ minWords: '400' }, withMax), { status: 400, message: 'Maximum words must be at least the minimum' });
  // empty boxes mean "none"
  assert.strictEqual(A.cleanWriting({ timeLimitMin: null }, A.defaultWriting('locked')).timeLimitMin, null);
  assert.strictEqual(A.cleanWriting({ pauseGraceSec: 0 }, w).pauseGraceSec, 0);
});
