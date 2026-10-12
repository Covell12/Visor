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
function makeChrome(seed = {}) {
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
  const ipc = () => new Promise((r) => setTimeout(r, 2));
  const chrome = {
    runtime: { onMessage: ev(), onInstalled: ev(), getManifest: () => ({ version: '4.0.0' }), lastError: null, id: 'test', getURL: (p) => `chrome-extension://test/${p}` },
    sidePanel: { setOptions: rec('setOptions'), setPanelBehavior: rec('setPanelBehavior'), open: rec('open') },
    action: { setBadgeText: rec('setBadgeText'), setBadgeBackgroundColor: rec('setBadgeBackgroundColor'), setTitle: rec('setTitle'), setPopup: rec('setPopup') },
    tabs: { onUpdated: ev(), onActivated: ev(), onRemoved: ev(), query: async () => tabs, get: async (id) => tabs.find((t) => t.id === id), update: rec('tabs.update'), create: rec('tabs.create'), sendMessage: async (...args) => { await rec('tabs.sendMessage')(...args); return { ok: true }; } },
    // No Chrome window in focus: nothing is being looked at
    windows: { onFocusChanged: ev(), create: rec('windows.create'), update: rec('windows.update'), getLastFocused: async () => ({ id: 1, focused: false, tabs }), WINDOW_ID_NONE: -1 },
    storage: { local: store('local'), session: store('session'), onChanged },
    alarms: { create: rec('alarms.create'), clear: rec('alarms.clear'), onAlarm: ev() },
    permissions: { contains: async () => false, request: async () => false },
    // Records which tab, which files and which arguments (a toast's text)
    scripting: { registerContentScripts: rec('registerContentScripts'), unregisterContentScripts: rec('unregisterContentScripts'), getRegisteredContentScripts: async () => [], executeScript: async (o) => { calls.push(['executeScript', JSON.parse(JSON.stringify({ tabId: o.target && o.target.tabId, files: o.files, args: o.args }))]); return []; } },
    webNavigation: { onCommitted: ev() },
    contextMenus: { create: rec('contextMenus.create'), removeAll: (cb) => { calls.push(['contextMenus.removeAll']); if (cb) cb(); }, update: rec('contextMenus.update'), onClicked: ev() },
    commands: { onCommand: ev() },
    // Like Chrome: each call takes a moment, and adding a rule whose id is already there fails
    declarativeNetRequest: {
      updateDynamicRules: async (u) => { calls.push(['dnr.update', JSON.parse(JSON.stringify(u))]); await ipc(); const kept = dnr.filter((r) => !(u.removeRuleIds || []).includes(r.id)); if ((u.addRules || []).some((a) => kept.some((r) => r.id === a.id))) throw new Error('duplicate rule id'); dnr = kept.concat(u.addRules || []); },
      getDynamicRules: async () => { await ipc(); return dnr; }
    }
  };
  let dnr = seed.dnr || [];
  Object.assign(chrome.storage.local.data, seed.local || {});
  return { chrome, calls, tabs };
}

function load(seed) {
  const { chrome, calls, tabs } = makeChrome(seed);
  const fetches = [];
  const beat = { active: true };   // what the server's beat answers (a test may add leaseSurf)
  const ctx = {
    chrome, console, setTimeout, clearTimeout, setInterval, clearInterval, URL, TextEncoder, crypto: require('crypto').webcrypto,
    fetch: async (url, init) => {
      fetches.push([url, init && init.method, init && init.body ? JSON.parse(init.body) : null]);
      const body = /session\/beat/.test(url) ? { ...beat } : { ok: true };
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
  return { chrome, calls, tabs, fetches, send, ctx, beat };
}

const visor = { origin: 'http://localhost:3000', url: 'http://localhost:3000/write/a1', tab: { id: 5, windowId: 1 } };
const settle = () => new Promise((r) => setTimeout(r, 20));
const callsOf = (calls, name) => calls.filter((c) => c[0] === name).map((c) => c.slice(1));
// The locked session's "everything else goes to the blocked page" rule, and an AI-site rule
const catchAll = (rules) => rules.some((x) => x.priority === 1 && x.action.type === 'redirect' && !x.condition.requestDomains && x.condition.regexFilter === '^https?://.*');
const blocksAi = (rules) => rules.some((x) => x.action.type === 'redirect' && (x.condition.requestDomains || []).includes('chatgpt.com'));
const sessionOf = async (h) => (await h.chrome.storage.session.get('visorSession')).visorSession;
const beatNow = async (h) => { h.chrome.alarms.onAlarm.fns.forEach((f) => f({ name: 'visor-flush' })); await settle(); await settle(); };
// The last research-mode switch was a minute ago (the beat waits 15 s after one)
const switchedLongAgo = (h) => { const s = h.chrome.storage.session.data.visorSession; if (s) s.researchAt = Date.now() - 60000; };
const CITE_OFF = 'One-click citing is turned off for this assignment.';

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
  ck('  the right-click cite item is added', callsOf(h.calls, 'contextMenus.create').map((c) => c[0].id), ['visor-cite']);

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
  ck('  one-click citing and side-panel mode default to on', [ps.oneClickCite, ps.panelBrowsing, ps.researchMode], [true, true, false]);
  r = await h.send({ channel: 'visor-bridge', type: 'RESEARCH_MODE', payload: { docId: 'd1', on: true } }, visor);
  ck('  research mode in an open session: succeeds, changes nothing', [r.ok, callsOf(h.calls, 'dnr.update').length, (await sessionOf(h)).researchMode], [true, 0, false]);

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

  // ── Chrome restarted mid-session: session storage is gone, the rest isn't ──
  const r2 = load({ local: { visorSessionLive: { docId: 'd1' } }, dnr: [{ id: 9100, priority: 1, action: { type: 'redirect' }, condition: {} }, { id: 5, priority: 1, action: { type: 'block' }, condition: {} }] });
  await settle(); await settle();
  ck('after a restart, Visor’s own lockdown rules are removed', (await r2.chrome.declarativeNetRequest.getDynamicRules()).map((x) => x.id), [5]);
  ck('  the badge is cleared and the popup is back', [callsOf(r2.calls, 'setBadgeText').at(-1), callsOf(r2.calls, 'setPopup').at(-1)], [[{ text: '' }], [{ popup: 'popup.html' }]]);
  ck('  the flag is gone', (await r2.chrome.storage.local.get('visorSessionLive')).visorSessionLive, undefined);
  const r3 = load();
  await settle(); await settle();
  ck('a normal start (no flag, no rules) changes nothing', callsOf(r3.calls, 'setPopup').length, 0);

  // ── A locked session: one-click citing off, research mode (side panel) ────
  const L = load();
  await settle();
  await L.send({ channel: 'visor-bridge', type: 'CONNECT', payload: { token: 'tok', user: { id: 'u1', name: 'Sam' } } }, visor);
  const locked = { mode: 'locked', researchTracking: true, title: 'Essay', allowedSites: ['en.wikipedia.org'], blockedSites: ['chatgpt.com'], blockAiSites: true, oneClickCite: false, panelBrowsing: true };
  const startLocked = (docId, settings) => L.send({ channel: 'visor-bridge', type: 'SESSION_START', payload: { docId, assignmentId: 'a2', sessionToken: 'wsess2', settings } }, visor);
  L.calls.length = 0;
  r = await startLocked('d2', locked);
  ck('locked session started', [r.ok, r.lockActive], [true, true]);
  ck('  one-click citing off: no right-click item', [callsOf(L.calls, 'contextMenus.create').length, callsOf(L.calls, 'contextMenus.removeAll').length > 0], [0, true]);
  ck('  the allowed list is enforced (catch-all redirect)', catchAll(await L.chrome.declarativeNetRequest.getDynamicRules()), true);
  ck('  an open tab off the list is sent away', callsOf(L.calls, 'tabs.update').map((c) => c[0]), [1]);
  let ps3 = await L.send({ type: 'VISOR_PANEL_STATE' }, {});
  ck('  the panel learns the switches', [ps3.oneClickCite, ps3.panelBrowsing, ps3.researchMode], [false, true, false]);

  r = await L.send({ type: 'VISOR_CITE_ACTIVE', from: 'panel' }, {});
  ck('the panel’s cite button is refused', r, { ok: false, error: CITE_OFF });
  L.calls.length = 0;
  L.chrome.commands.onCommand.fns.forEach((f) => f('cite-page', L.tabs[1]));
  L.chrome.contextMenus.onClicked.fns.forEach((f) => f({ menuItemId: 'visor-cite' }, L.tabs[1]));
  await settle();
  ck('Alt+Shift+C and a stale right-click item only say so', callsOf(L.calls, 'executeScript').map((c) => [c[0].tabId, c[0].files, c[0].args]), [[2, undefined, [CITE_OFF]], [2, undefined, [CITE_OFF]]]);
  ck('  and nothing reaches the editor', callsOf(L.calls, 'tabs.sendMessage').length, 0);

  L.calls.length = 0;
  r = await L.send({ channel: 'visor-bridge', type: 'RESEARCH_MODE', payload: { docId: 'd2', on: true } }, visor);
  ck('research mode on', r, { ok: true, researchMode: true });
  let rules = await L.chrome.declarativeNetRequest.getDynamicRules();
  ck('  the catch-all is gone, the AI rules stay', [catchAll(rules), blocksAi(rules)], [false, true]);
  ck('  the state says so', (await sessionOf(L)).researchMode, true);
  ck('  open tabs aren’t swept (the rules got looser)', callsOf(L.calls, 'tabs.update').length, 0);
  ps3 = await L.send({ type: 'VISOR_PANEL_STATE' }, {});
  ck('  the panel knows', ps3.researchMode, true);
  r = await L.send({ channel: 'visor-bridge', type: 'RESEARCH_MODE', payload: { docId: 'other', on: false } }, visor);
  ck('another document’s request is ignored', [r, (await sessionOf(L)).researchMode], [{ ok: false, error: 'no session' }, true]);
  r = await startLocked('d2', locked);
  ck('a re-sent SESSION_START (reload) keeps research mode', [(await sessionOf(L)).researchMode, catchAll(await L.chrome.declarativeNetRequest.getDynamicRules())], [true, false]);

  L.calls.length = 0;
  r = await L.send({ channel: 'visor-bridge', type: 'RESEARCH_MODE', payload: { docId: 'd2', on: false } }, visor);
  ck('research mode off', r, { ok: true, researchMode: false });
  rules = await L.chrome.declarativeNetRequest.getDynamicRules();
  ck('  the catch-all is back', [catchAll(rules), blocksAi(rules)], [true, true]);
  ck('  tabs opened while researching are left alone', callsOf(L.calls, 'tabs.update').map((c) => c[0]), []);
  r = await L.send({ channel: 'visor-bridge', type: 'RESEARCH_MODE', payload: { docId: 'd2', on: false } }, visor);
  ck('  saying it again changes nothing', [r, (await L.chrome.declarativeNetRequest.getDynamicRules()).length === rules.length], [{ ok: true, researchMode: false }, true]);

  // The beat says which surface holds the lease; the extension catches up
  L.beat.leaseSurf = 'panel';
  await beatNow(L);
  ck('beat: just after the tab switched, the beat doesn’t undo it', (await sessionOf(L)).researchMode, false);
  switchedLongAgo(L);
  await beatNow(L);
  ck('beat: the side panel holds the lease, so research mode goes on', [(await sessionOf(L)).researchMode, catchAll(await L.chrome.declarativeNetRequest.getDynamicRules())], [true, false]);
  switchedLongAgo(L);
  L.beat.leaseSurf = null;
  await beatNow(L);
  ck('beat: no lease news leaves it alone', (await sessionOf(L)).researchMode, true);
  L.beat.leaseSurf = 'tab';
  await beatNow(L);
  ck('beat: the tab took the lease back, so research mode goes off', [(await sessionOf(L)).researchMode, catchAll(await L.chrome.declarativeNetRequest.getDynamicRules())], [false, true]);
  // The tab's message and the beat at the same moment: one rebuild after the other
  const both = await Promise.all([1, 2].map(() => L.send({ channel: 'visor-bridge', type: 'RESEARCH_MODE', payload: { docId: 'd2', on: true } }, visor)));
  rules = await L.chrome.declarativeNetRequest.getDynamicRules();
  ck('two switches at once: both work, the lock stays on', [both.map((x) => x.ok), (await sessionOf(L)).lockActive, catchAll(rules), blocksAi(rules)], [[true, true], true, false, true]);
  await L.send({ channel: 'visor-bridge', type: 'RESEARCH_MODE', payload: { docId: 'd2', on: false } }, visor);

  // Side-panel mode turned off for the assignment
  L.beat.leaseSurf = null;
  await L.send({ channel: 'visor-bridge', type: 'SESSION_END', payload: { docId: 'd2' } }, visor);
  L.calls.length = 0;
  r = await startLocked('d3', { ...locked, oneClickCite: true, panelBrowsing: false });
  ck('one-click citing on: the right-click item is added', callsOf(L.calls, 'contextMenus.create').map((c) => c[0].id), ['visor-cite']);
  r = await L.send({ channel: 'visor-bridge', type: 'RESEARCH_MODE', payload: { docId: 'd3', on: true } }, visor);
  ck('side-panel mode off: research mode is refused', r, { ok: false, error: 'Side-panel mode is turned off for this assignment.' });
  ck('  the allowed list still applies', [(await sessionOf(L)).researchMode, catchAll(await L.chrome.declarativeNetRequest.getDynamicRules())], [false, true]);
  L.beat.leaseSurf = 'panel';
  await beatNow(L);
  ck('  a beat naming the panel doesn’t switch it either', (await sessionOf(L)).researchMode, false);
  ps3 = await L.send({ type: 'VISOR_PANEL_STATE' }, {});
  ck('  the panel learns the switches', [ps3.oneClickCite, ps3.panelBrowsing, ps3.researchMode], [true, false, false]);

  // Chrome restarted while the side panel held the lease: the reloaded page
  // says so in the settings, so the extension starts in research mode and
  // leaves the student's research tabs alone
  L.beat.leaseSurf = null;
  await L.send({ channel: 'visor-bridge', type: 'SESSION_END', payload: { docId: 'd3' } }, visor);
  const R = load();
  await settle();
  await R.send({ channel: 'visor-bridge', type: 'CONNECT', payload: { token: 'tok', user: { id: 'u1', name: 'Sam' } } }, visor);
  R.calls.length = 0;
  r = await R.send({ channel: 'visor-bridge', type: 'SESSION_START', payload: { docId: 'd4', assignmentId: 'a2', sessionToken: 'wsess4', settings: { ...locked, research: true } } }, visor);
  rules = await R.chrome.declarativeNetRequest.getDynamicRules();
  ck('restart mid-research: starts in research mode', [r.ok, (await sessionOf(R)).researchMode, catchAll(rules), blocksAi(rules)], [true, true, false, true]);
  ck('  research tabs aren’t sent away', callsOf(R.calls, 'tabs.update').length, 0);
  // A research switch racing a session start: whichever lands, the rules
  // match the state at the end
  await R.send({ channel: 'visor-bridge', type: 'SESSION_END', payload: { docId: 'd4' } }, visor);
  // (setting up the side panel on each tab takes a moment in a real browser;
  // the switch lands while the start is still doing that)
  const setOptions = R.chrome.sidePanel.setOptions;
  R.chrome.sidePanel.setOptions = (...a) => new Promise((done) => setTimeout(() => done(setOptions(...a)), 8));
  const race = [
    R.send({ channel: 'visor-bridge', type: 'SESSION_START', payload: { docId: 'd5', assignmentId: 'a2', sessionToken: 'wsess5', settings: locked } }, visor),
    new Promise((r) => setTimeout(r, 12)).then(() => R.send({ channel: 'visor-bridge', type: 'RESEARCH_MODE', payload: { docId: 'd5', on: true } }, visor))
  ];
  await Promise.all(race);
  await settle();
  const rs = await sessionOf(R);
  rules = await R.chrome.declarativeNetRequest.getDynamicRules();
  ck('a switch racing the start: the rules agree with the state', [rs.researchMode, rs.lockActive, catchAll(rules)], [true, true, false]);
  R.chrome.sidePanel.setOptions = setOptions;

  // The blocked page: an AI site was already recorded (ai-site, blocked) before
  // the redirect, so it isn't recorded again; another site off a locked list is
  const queued = async (h) => ((await sessionOf(h)).researchQueue || []).map((e) => `${e.type}:${e.host}`);
  await R.send({ channel: 'visor-bridge', type: 'RESEARCH_MODE', payload: { docId: 'd5', on: false } }, visor);
  switchedLongAgo(R);
  await settle();
  const before = (await queued(R)).length;
  r = await R.send({ type: 'VISOR_BLOCKED', url: 'https://chatgpt.com/' }, { tab: { id: 7 } });
  ck('blocked page, AI site: says so, records nothing more', [r.reason, (await queued(R)).length - before], ['ai', 0]);
  r = await R.send({ type: 'VISOR_BLOCKED', url: 'https://example.com/page' }, { tab: { id: 7 } });
  ck('blocked page, a site off the locked list: recorded as blocked', [r.reason, (await queued(R)).slice(before)], ['not-allowed', ['blocked:example.com']]);

  console.log(out.every(Boolean) ? `\nall passed (${out.length} checks)` : `\n${out.filter((x) => !x).length} FAILED`);
  process.exit(out.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
