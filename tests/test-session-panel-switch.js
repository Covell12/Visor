/* ============================================================================
 * The side panel during a writing session, and after it.
 * ----------------------------------------------------------------------------
 * background.js + session-bg.js run against a mock of the chrome.* APIs they
 * use. A session switches every tab to the session panel and the toolbar
 * button to opening it; ending the session must put back exactly what v3.6
 * does: the Docs panel only on the document it was opened from, the popup on
 * the toolbar button, no badge.
 * ==========================================================================*/

'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const DIR = path.join(__dirname, '..');
const out = [];
const ck = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  out.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`}`);
};

// ── A small chrome.* ───────────────────────────────────────────────────────
function makeChrome() {
  const calls = [];
  const ev = () => { const fns = []; return { addListener: (f) => fns.push(f), fns }; };
  const store = (area) => {
    const data = {};
    return {
      data,
      get: async (k) => (typeof k === 'string' ? (k in data ? { [k]: data[k] } : {}) : { ...data }),
      set: async (o) => { Object.assign(data, JSON.parse(JSON.stringify(o))); onChanged.fns.forEach((f) => f(Object.fromEntries(Object.keys(o).map((k) => [k, { newValue: o[k] }])), area)); },
      remove: async (k) => { delete data[k]; onChanged.fns.forEach((f) => f({ [k]: { newValue: undefined } }, area)); }
    };
  };
  const onChanged = ev();
  const tabs = [
    { id: 1, windowId: 1, url: 'https://docs.google.com/document/d/abc/edit' },
    { id: 2, windowId: 1, url: 'https://en.wikipedia.org/wiki/Sleep' },
    { id: 5, windowId: 1, url: 'http://localhost:3000/write/a1' }
  ];
  const rec = (name) => async (...args) => { calls.push([name, ...JSON.parse(JSON.stringify(args))]); };
  const chrome = {
    runtime: { onMessage: ev(), onInstalled: ev(), getManifest: () => ({ version: '4.0.0' }), lastError: null, id: 'test', getURL: (p) => `chrome-extension://test/${p}` },
    sidePanel: { setOptions: rec('setOptions'), setPanelBehavior: rec('setPanelBehavior'), open: rec('open') },
    action: { setBadgeText: rec('setBadgeText'), setBadgeBackgroundColor: rec('setBadgeBackgroundColor'), setTitle: rec('setTitle'), setPopup: rec('setPopup') },
    tabs: { onUpdated: ev(), onActivated: ev(), onRemoved: ev(), query: async () => tabs, get: async (id) => tabs.find((t) => t.id === id), update: rec('tabs.update') },
    windows: { onFocusChanged: ev(), create: rec('windows.create'), WINDOW_ID_NONE: -1 },
    storage: { local: store('local'), session: store('session'), onChanged },
    alarms: { create: rec('alarms.create'), clear: rec('alarms.clear'), onAlarm: ev() },
    permissions: { contains: async () => false, request: async () => false },
    scripting: { registerContentScripts: rec('registerContentScripts'), unregisterContentScripts: rec('unregisterContentScripts'), getRegisteredContentScripts: async () => [], executeScript: async () => [] },
    webNavigation: { onCommitted: ev() },
    contextMenus: { create: rec('contextMenus.create'), removeAll: rec('contextMenus.removeAll'), update: rec('contextMenus.update'), onClicked: ev() },
    commands: { onCommand: ev() },
    declarativeNetRequest: { updateDynamicRules: rec('dnr.update'), getDynamicRules: async () => [] }
  };
  return { chrome, calls, tabs };
}

function load() {
  const { chrome, calls, tabs } = makeChrome();
  const fetches = [];
  const ctx = {
    chrome, console, setTimeout, clearTimeout, setInterval, clearInterval, URL, TextEncoder, crypto: require('crypto').webcrypto,
    fetch: async (url, init) => {
      fetches.push([url, init && init.method, init && init.body ? JSON.parse(init.body) : null]);
      const body = /session\/beat/.test(url) ? { active: true } : { ok: true };
      return { ok: true, status: 200, json: async () => body };
    }
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  ctx.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f }));
  vm.runInContext(fs.readFileSync(path.join(DIR, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  const send = (msg, sender) => new Promise((resolve) => {
    let answered = false;
    for (const f of chrome.runtime.onMessage.fns) {
      const keep = f(msg, sender || {}, (r) => { answered = true; resolve(r); });
      if (keep === true || answered) return;
    }
    resolve(undefined);
  });
  return { chrome, calls, tabs, fetches, send, ctx };
}

const visor = { origin: 'http://localhost:3000', url: 'http://localhost:3000/write/a1', tab: { id: 5, windowId: 1 } };
const settle = () => new Promise((r) => setTimeout(r, 20));
const callsOf = (calls, name) => calls.filter((c) => c[0] === name).map((c) => c.slice(1));

(async () => {
  const h = load();
  await settle();

  // Pages other than Visor's own are refused
  const stranger = await h.send({ channel: 'visor-bridge', type: 'PING', payload: {} }, { origin: 'https://evil.example', url: 'https://evil.example/', tab: { id: 9 } });
  ck('a page that isn’t Visor gets nothing', stranger.ok, false);

  let r = await h.send({ channel: 'visor-bridge', type: 'PING', payload: {} }, visor);
  ck('ping: installed, not connected yet', [r.installed, r.connected, r.version], [true, false, '4.0.0']);
  await h.send({ channel: 'visor-bridge', type: 'CONNECT', payload: { token: 'tok', user: { id: 'u1', name: 'Sam' } } }, visor);
  r = await h.send({ channel: 'visor-bridge', type: 'PING', payload: {} }, visor);
  ck('ping after connect', [r.connected, r.user.name], [true, 'Sam']);

  // The first SESSION_START (no token) only confirms to the server
  h.calls.length = 0;
  r = await h.send({ channel: 'visor-bridge', type: 'SESSION_START', payload: { docId: 'd1', assignmentId: 'a1', sessionToken: null, settings: {} } }, visor);
  ck('confirmation: acked to the server', [r.ok, r.acked, h.fetches.at(-1)[0]], [true, true, 'http://localhost:3000/api/ext/session/ack']);
  ck('  and changes nothing in the browser', h.calls.filter((c) => c[0] === 'setOptions' || c[0] === 'setBadgeText').length, 0);

  // The session starts
  r = await h.send({ channel: 'visor-bridge', type: 'SESSION_START', payload: { docId: 'd1', assignmentId: 'a1', sessionToken: 'wsess', settings: { mode: 'open', researchTracking: true, title: 'Essay' } } }, visor);
  ck('session started', r.ok, true);
  ck('  the toolbar badge says REC', callsOf(h.calls, 'setBadgeText').at(-1), [{ text: 'REC' }]);
  ck('  the toolbar button opens the panel (no popup)', [callsOf(h.calls, 'setPopup').at(-1), callsOf(h.calls, 'setPanelBehavior').at(-1)], [[{ popup: '' }], [{ openPanelOnActionClick: true }]]);
  ck('  the session panel is the global panel', callsOf(h.calls, 'setOptions').find((c) => c[0].tabId === undefined), [{ path: 'sessionpanel.html', enabled: true }]);
  ck('  …and every open tab’s', callsOf(h.calls, 'setOptions').filter((c) => c[0].tabId).map((c) => [c[0].tabId, c[0].path, c[0].enabled]), [[1, 'sessionpanel.html', true], [2, 'sessionpanel.html', true], [5, 'sessionpanel.html', true]]);
  ck('  the minute alarm is set', callsOf(h.calls, 'alarms.create').at(-1), ['visor-flush', { periodInMinutes: 1 }]);
  ck('  research isn’t recorded without the permission', callsOf(h.calls, 'registerContentScripts').length, 0);

  // A tab navigating during the session keeps the session panel
  h.calls.length = 0;
  h.chrome.tabs.onUpdated.fns.forEach((f) => f(3, { status: 'loading', url: 'https://docs.google.com/document/d/zzz/edit' }, { id: 3, url: 'https://docs.google.com/document/d/zzz/edit' }));
  await settle();
  ck('a new tab during the session gets the session panel', callsOf(h.calls, 'setOptions').map((c) => [c[0].tabId, c[0].path, c[0].enabled]), [[3, 'sessionpanel.html', true]]);
  // The Docs launcher asking for the panel during a session still gets the session panel
  h.calls.length = 0;
  await h.send({ type: 'OPEN_SIDE_PANEL' }, { tab: { id: 1, windowId: 1 } });
  ck('the Docs launcher during a session opens the session panel', callsOf(h.calls, 'setOptions').map((c) => c[0].path), ['sessionpanel.html']);

  const ps = await h.send({ type: 'VISOR_PANEL_STATE' }, {});
  ck('the panel learns the session', [ps.active, ps.assignmentId, ps.origin, ps.title, ps.extToken], [true, 'a1', 'http://localhost:3000', 'Essay', 'tok']);

  // The session ends: v3.6 behavior, exactly
  h.calls.length = 0;
  r = await h.send({ channel: 'visor-bridge', type: 'SESSION_END', payload: { docId: 'd1' } }, visor);
  ck('session ended', r.ok, true);
  ck('  badge cleared', callsOf(h.calls, 'setBadgeText').at(-1), [{ text: '' }]);
  ck('  toolbar button back to the popup', [callsOf(h.calls, 'setPanelBehavior').at(-1), callsOf(h.calls, 'setPopup').at(-1)], [[{ openPanelOnActionClick: false }], [{ popup: 'popup.html' }]]);
  ck('  global panel off', callsOf(h.calls, 'setOptions').find((c) => c[0].tabId === undefined), [{ path: 'sidepanel.html', enabled: false }]);
  // The Docs tab it was opened from (tab 1, via OPEN_SIDE_PANEL above) keeps the Docs panel; every other tab has none
  ck('  each tab back to the Docs panel rules', callsOf(h.calls, 'setOptions').filter((c) => c[0].tabId).map((c) => [c[0].tabId, c[0].path, c[0].enabled]), [[1, 'sidepanel.html', true], [2, 'sidepanel.html', false], [5, 'sidepanel.html', false]]);
  ck('  the alarm is cleared', callsOf(h.calls, 'alarms.clear').at(-1), ['visor-flush']);
  ck('  no session state left', (await h.chrome.storage.session.get('visorSession')).visorSession, undefined);

  // After the session, the v3.6 flow works as before
  h.calls.length = 0;
  await h.send({ type: 'OPEN_SIDE_PANEL' }, { tab: { id: 1, windowId: 1 } });
  ck('v3.6: the Docs panel opens on its document', [callsOf(h.calls, 'setOptions').map((c) => [c[0].tabId, c[0].path, c[0].enabled]), callsOf(h.calls, 'open').length], [[[1, 'sidepanel.html', true]], 1]);
  h.calls.length = 0;
  h.chrome.tabs.onActivated.fns.forEach((f) => f({ tabId: 2 }));
  await settle();
  ck('v3.6: switching to another tab closes it there', callsOf(h.calls, 'setOptions').map((c) => [c[0].tabId, c[0].enabled]), []);
  const ps2 = await h.send({ type: 'VISOR_PANEL_STATE' }, {});
  ck('the panel knows there’s no session', ps2.active, false);

  console.log(out.every(Boolean) ? `\nall passed (${out.length} checks)` : `\n${out.filter((x) => !x).length} FAILED`);
  process.exit(out.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
