/* ============================================================================
 * research-capture.js: the copy listener a session puts on every site.
 * ----------------------------------------------------------------------------
 * A page's own script can fire a "copy" event over text it selected itself,
 * without anything reaching the clipboard; only the browser's own copy events
 * (isTrusted) are reported to the session.
 * ==========================================================================*/

'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const out = [];
const ck = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  out.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`}`);
};

function load(selection) {
  const listeners = {};
  const sent = [];
  const ctx = {
    window: {},
    self: {},
    location: { href: 'https://example.com/article' },
    document: {
      title: 'An article',
      addEventListener: (type, fn) => { listeners[type] = fn; },
      getSelection: () => ({ toString: () => selection })
    },
    chrome: { runtime: { lastError: null, sendMessage: (m, cb) => { sent.push(m); if (cb) cb(); }, onMessage: { addListener() {} } } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'research-capture.js'), 'utf8'), ctx, { filename: 'research-capture.js' });
  return { copy: (isTrusted) => listeners.copy({ isTrusted }), sent };
}

const page = load('A sentence the student selected and copied from the page.');
page.copy(false);
ck('a copy event fired by the page’s own script is ignored', page.sent.length, 0);
page.copy(true);
ck('a real copy is reported, with the page it came from', [page.sent.length, page.sent[0] && page.sent[0].type, page.sent[0] && page.sent[0].url], [1, 'VISOR_RESEARCH_COPY', 'https://example.com/article']);

const short = load('too short');
short.copy(true);
ck('fewer than 20 characters: not reported', short.sent.length, 0);

console.log(out.every(Boolean) ? `\nall passed (${out.length} checks)` : `\n${out.filter((x) => !x).length} FAILED`);
process.exit(out.every(Boolean) ? 0 : 1);
