/* ============================================================================
 * The side panel's five-minute refresh.
 * ----------------------------------------------------------------------------
 * What matters is not that it re-reads — it is that the reader does not notice.
 * No loading screen, the same sub-tab, the same scroll position, and nothing
 * sent that would disturb a replay running in the document.
 * ==========================================================================*/

'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { makeDom } = require('./dom');

const DIR = path.join(__dirname, '..');

const out = [];
const ck = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  out.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`}`);
};

const ANALYSIS = {
  contributors: [{ id: '1', name: 'Ethan', color: '#5AC8FA', chars: 5, share: 1, activeMinutes: 1, words: 1, sessions: 1, pasted: 0, deleted: 0 }],
  totals: { finalChars: 5, finalWords: 1, mutations: 1, activeMinutes: 1, pasteCount: 0, deleted: 0, spanDays: 1,
            externalPasted: 0, internalPasted: 0, pasted: 0, inserted: 5, sessions: 1, days: 1 },
  growth: [{ length: 1, t: 1 }, { length: 5, t: 2 }],
  sessions: [], heatmap: [], pastes: [], deletions: [], recovered: [],
  behavior: { enough: false }, calendar: { days: [], hours: [], weekdays: [] },
  pasteThreshold: { value: 20, source: 'floor', samples: 0 },
  tabState: { tabs: [], pick: 'current', selected: null, current: null, resolvable: false }
};

function load() {
  const { win, document, clock } = makeDom({ autoIds: true });

  const asks = [];
  const overrides = {};
  win.chrome = {
    tabs: {
      query: async () => [{ id: 7, url: 'https://docs.google.com/document/d/DOC1/edit' }],
      sendMessage: (id, msg, cb) => {
        asks.push(msg);
        const replies = {
          VISOR_STATUS: { state: 'ready', meta: { title: 'Essay', fileId: 'DOC1', kind: 'document' } },
          VISOR_ANALYZE: { state: 'ready', analysis: ANALYSIS, meta: { title: 'Essay' }, tabState: ANALYSIS.tabState }
        };
        // A microtask, not a timer: the test drives time itself.
        Promise.resolve().then(() => cb && cb(overrides[msg.type] || replies[msg.type] || { ok: true }));
      },
      onActivated: { addListener() {} },
      create() {}
    },
    runtime: { lastError: null, onMessage: { addListener(fn) { win.__onMessage = fn; } }, sendMessage() {}, getURL: (p) => p },
    storage: { local: { get: (k, cb) => cb && cb({}), set() {} }, onChanged: { addListener() {} } }
  };
  win.visorApplyTheme = () => {};
  win.visorInitTheme = async () => 'light';
  win.visorSetTheme = async () => {};
  win.matchMedia = () => ({ matches: false, addEventListener() {} });

  // A few nodes the panel expects to exist by class rather than by id.
  for (const cls of ['v-icon-sun', 'v-icon-moon', 'v-tab', 'v-panel']) {
    const el = document.createElement('div');
    el.className = cls;
    if (cls === 'v-panel') el.id = 'panel-overview';
    if (cls === 'v-tab') el.dataset.tab = 'overview';
    document.body.appendChild(el);
  }
  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync(`${DIR}/sidepanel.js`, 'utf8'), ctx, { filename: 'sidepanel.js' });
  return { ctx, document, clock, asks, replies: overrides, run: (code) => vm.runInContext(code, ctx) };
}

// Advance the clock in slices, letting promises run between them: a reply that
// is scheduled by an earlier reply's handler still has to arrive.
const settle = async (h, ms = 1) => {
  const slices = 12;
  for (let i = 0; i < slices; i++) {
    h.clock.advance(Math.ceil(ms / slices));
    for (let k = 0; k < 80; k++) await Promise.resolve();
  }
};

(async () => {
  const h = load();
  await settle(h, 10);

  ck('the panel reads the document once on open', h.asks.filter((m) => m.type === 'VISOR_ANALYZE').length, 1);
  ck('  and shows the figures', h.document.getElementById('main').classList.contains('hidden'), false);

  // Put the reader somewhere: a sub-tab, scrolled down.
  h.run(`
    const seg = document.getElementById('__seg'); `);
  const panel = h.document.getElementById('panel-overview') || h.document.getElementById('main');
  panel.scrollTop = 420;
  const segBtn = h.document.createElement('button');
  segBtn.className = 'v-seg-btn is-active';
  segBtn.dataset.ev = 'deletions';
  h.document.body.appendChild(segBtn);
  const evPane = h.document.createElement('div');
  evPane.className = 'v-ev';
  evPane.id = 'ev-deletions';
  h.document.body.appendChild(evPane);

  const before = h.asks.filter((m) => m.type === 'VISOR_ANALYZE').length;
  await settle(h, 5 * 60 * 1000);

  const analyzes = h.asks.filter((m) => m.type === 'VISOR_ANALYZE');
  ck('after five minutes it re-reads the document', analyzes.length, before + 1);
  ck('  and asks for a fresh read, not the cached one', analyzes[analyzes.length - 1].force, true);
  ck('  the loading screen never appears', h.document.getElementById('state-loading').classList.contains('hidden'), true);
  ck('  the figures stay on screen', h.document.getElementById('main').classList.contains('hidden'), false);
  ck('  the sub-tab the reader had open is still open', segBtn.classList.contains('is-active'), true);
  ck('  and it is still scrolled where they left it', panel.scrollTop, 420);

  // The bar refreshing in the document tells the panel; that must not start a
  // second read of its own.
  const n = h.asks.filter((m) => m.type === 'VISOR_ANALYZE').length;
  h.run("chrome.runtime.onMessage; ");
  h.ctx.__onMessage({ type: 'VISOR_DATA_REFRESHED' });
  await settle(h, 5);
  const after = h.asks.filter((m) => m.type === 'VISOR_ANALYZE');
  ck('when the bar has just read the document, the panel reuses that', after.length, n + 1);
  ck('  without forcing another read', after[after.length - 1].force, false);

  // ── Refreshing must not pile up hover handlers on the chart ──────────────
  // The chart's host element is static markup; only its contents are replaced.
  // Every refresh used to add another pointermove listener to it, and another
  // pair on the window, so after an hour of a document being edited a single
  // pointer move ran dozens of stale callbacks, each measuring layout.
  {
    const chart = h.document.getElementById('growth-chart');
    const before = {
      move: chart.listenerCount('pointermove'),
      enter: chart.listenerCount('pointerenter'),
      leave: chart.listenerCount('pointerleave'),
      scroll: h.ctx.listenerCount('scroll')
    };
    for (let i = 0; i < 6; i++) { h.ctx.__onMessage({ type: 'VISOR_DATA_REFRESHED' }); await settle(h, 5); }
    ck('six refreshes leave one hover handler, not seven', [
      chart.listenerCount('pointermove'),
      chart.listenerCount('pointerenter'),
      chart.listenerCount('pointerleave')
    ], [before.move, before.enter, before.leave]);
    ck('  and do not accumulate window listeners either', h.ctx.listenerCount('scroll'), before.scroll);
  }

  // ── A read already in flight must not strand the panel on the loader ─────
  {
    const g = load();
    await settle(g, 10);
    g.replies.VISOR_ANALYZE = { state: 'running' };
    const done = g.run('analyze(true)');
    await settle(g, 300);
    ck('while the page is already reading, the panel waits', g.document.getElementById('state-loading').classList.contains('hidden'), false);
    g.replies.VISOR_ANALYZE = null;      // back to the normal ready reply
    await settle(g, 900);
    await done;
    ck('  and comes back as soon as the read lands', g.document.getElementById('main').classList.contains('hidden'), false);
  }

  console.log(out.every(Boolean) ? `\nall passed (${out.length} checks)` : `\n${out.filter((x) => !x).length} FAILED`);
  process.exit(out.every(Boolean) ? 0 : 1);
})();
