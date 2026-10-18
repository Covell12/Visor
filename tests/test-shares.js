/* ============================================================================
 * What the percentages count: pastes left out, by default, and the switches.
 * ----------------------------------------------------------------------------
 *   1. The recount itself (shares.js).
 *   2. The bar in the document: its percentages, its pill and menu, and the
 *      stored setting the side panel shares.
 * ==========================================================================*/

'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { makeDom } = require('./dom');
const { visorShares, visorShareSettings, visorShareLabel } = require('../shares.js');

const DIR = path.join(__dirname, '..');
const out = [];
const ck = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  out.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`}`);
};

const people = [
  { id: 'w', name: 'Whitney', inserted: 9000, externalPastedChars: 2500, internalPastedChars: 600 },
  { id: 'k', name: 'Kayla', inserted: 1600, externalPastedChars: 0, internalPastedChars: 0 },
  { id: 'e', name: 'Emily', inserted: 1000, externalPastedChars: 0, internalPastedChars: 200 }
];
const pct = (list) => list.map((c) => `${c.name} ${Math.round(c.share * 100)}`);

// ── 1. The recount ────────────────────────────────────────────────────────────
ck('both kinds of paste are left out unless switched off', visorShareSettings({}), { excludeExternal: true, excludeInternal: true });
ck('  an explicit off is off', visorShareSettings({ visor_share_excl_ext: false }), { excludeExternal: false, excludeInternal: true });
ck('by default, pastes don\'t count toward anyone\'s share', pct(visorShares(people)), ['Whitney 71', 'Kayla 19', 'Emily 10']);
ck('  counting outside pastes again', pct(visorShares(people, { excludeExternal: false, excludeInternal: true })), ['Whitney 78', 'Kayla 15', 'Emily 7']);
ck('  counting everything: the plain share of the text added', pct(visorShares(people, { excludeExternal: false, excludeInternal: false })), ['Whitney 78', 'Kayla 14', 'Emily 9']);
ck('the order follows the recounted shares', visorShares([
  { id: 'a', name: 'A', inserted: 1000, externalPastedChars: 900, internalPastedChars: 0 },
  { id: 'b', name: 'B', inserted: 500, externalPastedChars: 0, internalPastedChars: 0 }]).map((c) => c.name), ['B', 'A']);
ck('a document that is all pastes reads 0%, not a division by zero',
  pct(visorShares([{ id: 'a', name: 'A', inserted: 50, externalPastedChars: 50, internalPastedChars: 0 }])), ['A 0']);
ck('the analysis itself is left alone', (() => { const c = [{ ...people[0] , share: .5 }]; visorShares(c); return c[0].share; })(), .5);
ck('labels', [visorShareLabel({ excludeExternal: true, excludeInternal: true }), visorShareLabel({ excludeExternal: true, excludeInternal: false }),
  visorShareLabel({ excludeExternal: false, excludeInternal: true }), visorShareLabel({ excludeExternal: false, excludeInternal: false })],
  ['Excl. pastes', 'Excl. outside pastes', 'Excl. pastes from within', 'All text']);

// ── 2. The bar ────────────────────────────────────────────────────────────────
function loadBar(stored = {}) {
  const { win, document, clock } = makeDom();
  const store = { ...stored };
  const listeners = [];
  win.location.origin = 'https://docs.google.com';
  win.postMessage = () => {};
  win.VisorChangelog = {
    async fetchChangelog() { return { entries: [{ mutation: { ty: 'is', ibi: 1, s: 'x' }, time: 1, rev: 1, userId: 'w', sid: null }], users: [], lastRevision: 5, diagnostics: {}, tabs: [] }; },
    async latestRevision() { return 5; },
    buildTimeline: () => ({ steps: [{ i: 0, time: 1, userId: 'w', inserted: 5, deleted: 0, biggestInsert: 5, _norm: [] }], finalText: 'x', textAt: () => 'x' }),
    analyze: () => ({
      contributors: people.map((c, i) => ({ ...c, color: ['#7A56C2', '#118A7E', '#2A7E9E'][i], share: 0, activeMinutes: 10 })),
      totals: { finalChars: 1, finalWords: 1, mutations: 1, activeMinutes: 1, pasteCount: 0, deleted: 0, spanDays: 1 },
      growth: [], sessions: [], heatmap: [], pastes: [], deletions: [], behavior: { enough: false }, calendar: {},
      pasteThreshold: { value: 20 }, ownership: []
    }),
    constants: {}
  };
  win.chrome = {
    runtime: { id: 't', lastError: null, getURL: (p) => p, sendMessage: (m, cb) => cb && cb({ ok: true }), onMessage: { addListener() {} } },
    storage: {
      local: {
        get: (k, cb) => { const r = {}; (Array.isArray(k) ? k : [k]).forEach((x) => { if (x in store) r[x] = store[x]; }); cb && cb(r); },
        set: (o) => { const ch = {}; for (const [k, v] of Object.entries(o)) { ch[k] = { newValue: v }; store[k] = v; } listeners.forEach((fn) => fn(ch, 'local')); }
      },
      onChanged: { addListener: (fn) => listeners.push(fn) }
    }
  };
  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync(`${DIR}/shares.js`, 'utf8'), ctx, { filename: 'shares.js' });
  vm.runInContext(fs.readFileSync(`${DIR}/content.js`, 'utf8'), ctx, { filename: 'content.js' });
  vm.runInContext('probeResult = { editable: true, revisionHint: 0, liveTabs: [], ready: true };', ctx);
  return { document, clock, store, hud: () => document.getElementById('visor-hud') };
}
const settle = async (h, ms = 1) => {
  for (let left = ms; left > 0; left -= 50) { h.clock.advance(Math.min(50, left)); for (let k = 0; k < 12; k++) await Promise.resolve(); }
};
const chips = (h) => h.hud().querySelectorAll('.vh-pct').map((b) => b.textContent);

(async () => {
  {
    const h = loadBar();
    await settle(h, 1000);
    const tab = h.document.getElementById('visor-hud-tab');
    tab.fire('click', { target: tab.querySelector('.vt-open') });
    await settle(h, 100);
    ck('the bar shows shares with pastes left out', chips(h), ['71%', '19%', '10%']);
    ck('  and its pill says so', h.hud().querySelector('.vh-share-label').textContent, 'Excl. pastes');
    const btn = h.hud().querySelector('[data-act="share"]');
    const menu = h.hud().querySelector('.vh-share-menu');
    ck('the menu starts closed', menu.hidden, true);
    btn.fire('click', { target: btn });
    ck('  the pill opens it', [menu.hidden, btn.getAttribute('aria-expanded')], [false, 'true']);
    ck('  both switches on', h.hud().querySelectorAll('[data-share]').map((o) => o.getAttribute('aria-checked')), ['true', 'true']);
    menu.fire('click', { target: h.hud().querySelector('[data-share="ext"]') });
    await settle(h, 50);
    ck('counting outside pastes again recounts the bar', chips(h), ['78%', '15%', '7%']);
    ck('  stored for the side panel and next time', h.store.visor_share_excl_ext, false);
    ck('  the pill names the setting', h.hud().querySelector('.vh-share-label').textContent, 'Excl. pastes from within');
    ck('  its switch shows off', h.hud().querySelector('[data-share="ext"]').getAttribute('aria-checked'), 'false');
    menu.fire('click', { target: h.hud().querySelector('[data-share="int"]') });
    await settle(h, 50);
    ck('both off: every character counts', [chips(h), h.hud().querySelector('.vh-share-label').textContent], [['78%', '14%', '9%'], 'All text']);
    btn.fire('click', { target: btn });
    ck('the pill closes the menu again', menu.hidden, true);
  }
  {
    const h = loadBar({ visor_share_excl_ext: false, visor_share_excl_int: false });
    await settle(h, 1000);
    const tab = h.document.getElementById('visor-hud-tab');
    tab.fire('click', { target: tab.querySelector('.vt-open') });
    await settle(h, 100);
    ck('a stored choice is used from the start', chips(h), ['78%', '14%', '9%']);
  }

  const failed = out.filter((x) => !x).length;
  console.log(failed ? `${failed} of ${out.length} checks FAILED` : `all passed (${out.length} checks)`);
  process.exit(failed ? 1 : 0);
})();
