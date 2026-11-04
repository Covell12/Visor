/* ============================================================================
 * The report a group project receives, for a Doc that has tabs.
 * ----------------------------------------------------------------------------
 *   1. Send to Visor sends what the panel shows: the tab on screen.
 *   2. "Add files from Google Drive" asks for the whole document
 *      (VISOR_EXPORT with whole): every tab, without the user's selection,
 *      the bar or the panel moving, and from the fold cache the second time.
 *   3. The worker's "Send to Visor" state: the site's address for the
 *      project link, and whether a writing session is running.
 * content.js runs against tests/dom.js and a stand-in engine that says
 * which tab each fold was asked for.
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

function loadDoc() {
  const { win, clock } = makeDom();
  const folds = [];
  let listener = null;
  win.location.origin = 'https://docs.google.com';
  // The second of two tabs is on screen
  win.location.href = 'https://docs.google.com/document/d/DOC1/edit?tab=t.notes';
  win.document.title = 'Group essay - Google Docs';
  win.postMessage = () => {};
  win.VisorChangelog = {
    async fetchChangelog() {
      return {
        entries: [{ mutation: { ty: 'is', ibi: 1, s: 'x' }, time: 1, rev: 1, userId: '1', sid: null }],
        users: [{ id: '1', name: 'Maya' }], lastRevision: 9, diagnostics: { rows: 1 },
        tabs: [{ id: 't.0', title: 'Draft' }, { id: 't.notes', title: 'Notes' }]
      };
    },
    async latestRevision() { return 9; },
    buildTimeline: (entries, users, opts) => {
      const tab = opts && opts.tab ? opts.tab : 'all';
      folds.push(tab);
      return { tab, steps: [{ i: 0, time: 1, userId: '1', inserted: 1, deleted: 0, biggestInsert: 1, _norm: [] }], finalText: 'x', textAt: () => 'x' };
    },
    // Each fold's figures name the tab they were folded for
    analyze: (tl) => ({
      contributors: [{ id: '1', name: `Maya (${tl.tab})`, color: '#2F6FC4', inserted: 1, share: 1, activeMinutes: 1 }],
      totals: { finalChars: 1, finalWords: 1, mutations: 1, activeMinutes: 1, pasteCount: 0, deleted: 0, spanDays: 1 },
      growth: [], sessions: [], heatmap: [], pastes: [{ text: 'secret pasted text', length: 18, userId: '1', time: 1 }], deletions: [],
      behavior: { enough: false }, calendar: {}, pasteThreshold: { value: 20 }, ownership: [[0, 1, '1', 0]]
    }),
    constants: {}
  };
  win.chrome = {
    runtime: { id: 't', lastError: null, getURL: (p) => p, sendMessage: (m, cb) => cb && cb({ ok: true }), onMessage: { addListener: (fn) => { listener = fn; } } },
    storage: { local: { get: (k, cb) => cb && cb({}), set() {} }, onChanged: { addListener() {} } }
  };
  const ctx = vm.createContext(win);
  for (const f of ['edition.js', 'shares.js', 'content.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
  vm.runInContext('probeResult = { editable: true, revisionHint: 0, liveTabs: [], ready: true };', ctx);
  const ask = (msg) => new Promise((resolve) => {
    let done = false;
    const keep = listener(msg, {}, (r) => { done = true; resolve(r); });
    if (!keep && !done) resolve(undefined);
  });
  const settle = async (ms) => { for (let l = ms; l > 0; l -= 50) { clock.advance(50); for (let k = 0; k < 12; k++) await Promise.resolve(); } };
  return { ask, folds, settle };
}

(async () => {
  const h = loadDoc();
  const read = h.ask({ type: 'VISOR_ANALYZE' });
  await h.settle(200);
  const r = await read;
  ck('the Doc is read for the tab on screen', [r.state, r.tabState.selected, h.folds], ['ready', 't.notes', ['t.notes']]);

  // ── 1. Send to Visor: what the panel shows ──────────────────────────────────
  const plain = await h.ask({ type: 'VISOR_EXPORT' });
  ck('Send to Visor sends the tab on screen', [plain.report.scope, plain.report.analysis.contributors[0].name], ['the current tab (Notes)', 'Maya (t.notes)']);

  // ── 2. From Google Drive: the whole document ────────────────────────────────
  const whole = await h.ask({ type: 'VISOR_EXPORT', whole: true });
  ck('the whole document asked for: every tab', [whole.report.scope, whole.report.analysis.contributors[0].name], ['all tabs', 'Maya (all)']);
  ck('  with the read\'s revision and time', [whole.report.analysis.lastRevision, typeof whole.report.analysis.analyzedAt], [9, 'number']);
  ck('  and, as always, no text: no pasted passages, no AWARE map, no diagnostics',
    [whole.report.analysis.pastes[0].text, whole.report.analysis.ownership, whole.report.analysis.diagnostics, whole.report.analysis.pastes[0].length], [undefined, undefined, undefined, 18]);
  ck('  the same document', [whole.report.meta.fileId, whole.report.meta.title, whole.report.schema], ['DOC1', 'Group essay', 'visor-export/1']);
  const after = await h.ask({ type: 'VISOR_TAB_STATE' });
  ck('the user\'s selection hasn\'t moved', [after.selected, after.pick], ['t.notes', 'current']);
  const again = await h.ask({ type: 'VISOR_EXPORT' });
  ck('  and Send to Visor still sends the tab on screen', again.report.analysis.contributors[0].name, 'Maya (t.notes)');
  await h.ask({ type: 'VISOR_EXPORT', whole: true });
  ck('the whole document is folded once, then cached', h.folds, ['t.notes', 'all']);
  const set = await h.ask({ type: 'VISOR_SET_TAB', tabId: null });
  ck('  so choosing all tabs afterwards folds nothing new', [set.ok, set.tabState.selected, h.folds], [true, null, ['t.notes', 'all']]);
  const wholeNow = await h.ask({ type: 'VISOR_EXPORT', whole: true });
  ck('  with all tabs chosen, the whole document is what the panel shows', [wholeNow.report.scope, wholeNow.report.analysis.contributors[0].name], ['all tabs', 'Maya (all)']);

  // ── 3. The worker's "Send to Visor" state ───────────────────────────────────
  {
    const store = (seed) => {
      const data = { ...seed };
      return { data, get: async (k) => (k in data ? { [k]: data[k] } : {}), set: async (o) => Object.assign(data, o), remove: async (k) => { delete data[k]; } };
    };
    const evt = () => ({ addListener() {} });
    const local = store({ visorAuth: { token: 'tok', origin: 'https://visor-ed.com', user: { id: 'u1', name: 'Sam' } } });
    const session = store({});
    const listeners = [];
    const chrome = {
      runtime: { onMessage: { addListener: (f) => listeners.push(f) }, onInstalled: evt(), onConnect: evt(), getManifest: () => ({ version: '4.6.0' }), getURL: (p) => `chrome-extension://test/${p}`, lastError: null },
      storage: { local, session, onChanged: evt() },
      tabs: { onUpdated: evt(), onActivated: evt(), onRemoved: evt(), query: async () => [] },
      windows: { onFocusChanged: evt() }, alarms: { onAlarm: evt(), create() {}, clear: async () => {} },
      webNavigation: { onCommitted: evt(), onBeforeNavigate: evt() }, contextMenus: { onClicked: evt() }, commands: { onCommand: evt() },
      permissions: { onRemoved: evt(), onAdded: evt(), contains: async () => false },
      sidePanel: { setOptions: async () => {}, setPanelBehavior: async () => {} }, action: { setPopup: async () => {} }
    };
    const fetches = [];
    const ctx = {
      chrome, console, setTimeout, clearTimeout, URL, atob, crypto: require('crypto').webcrypto,
      fetch: async (url) => { fetches.push(url); return { ok: true, status: 200, json: async () => ({ projects: [{ id: 'p1', name: 'Group 2', fileId: 'DOC1' }] }) }; }
    };
    ctx.self = ctx;
    vm.createContext(ctx);
    ctx.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f }));
    vm.runInContext(fs.readFileSync(path.join(DIR, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
    const send = (msg) => new Promise((resolve) => { for (const f of listeners) { if (f(msg, { url: 'chrome-extension://test/drive-import.html' }, resolve) === true) return; } resolve(undefined); });
    let st = await send({ type: 'VISOR_SEND_STATE' });
    ck('the worker says where Visor is, for the link to the project', [st.connected, st.origin, st.projects.map((p) => p.name)], [true, 'https://visor-ed.com', ['Group 2']]);
    ck('  and that no writing session is running', st.sessionActive, false);
    ck('  asking Visor for the projects with the extension\'s token', fetches, ['https://visor-ed.com/api/ext/projects']);
    session.data.visorSession = { active: true, assignmentId: 'a1' };
    st = await send({ type: 'VISOR_SEND_STATE' });
    ck('  during a writing session, says so', st.sessionActive, true);
    delete local.data.visorAuth;
    st = await send({ type: 'VISOR_SEND_STATE' });
    ck('  not connected: no address, and still whether a session runs', [st.connected, st.origin, st.sessionActive], [false, undefined, true]);
  }

  const failed = out.filter((x) => !x).length;
  console.log(failed ? `${failed} of ${out.length} checks FAILED` : `all passed (${out.length} checks)`);
  process.exit(failed ? 1 : 0);
})();
