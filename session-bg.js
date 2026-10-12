/* ============================================================================
 * Visor — Session manager (service worker)
 * ----------------------------------------------------------------------------
 * Loaded into background.js with importScripts. Only does anything while a
 * student has an active Visor writing session; outside one, the extension
 * behaves exactly as v3.6 did.
 *
 * During a session:
 *   • the toolbar badge says REC, with a title saying research is recorded;
 *   • the side panel is the session panel (sessionpanel.html) on every tab;
 *   • research is recorded (research capture below; research.js parses searches);
 *   • locked sessions keep the student on allowed sites (lockdown below), or,
 *     while they write in the side panel (research mode), off blocked sites;
 *   • every minute the queue of research events is sent, and the extension
 *     tells the server it's still here.
 *
 * Service workers sleep. All state lives in chrome.storage.session and every
 * handler reads it fresh; nothing important is kept in variables.
 * ==========================================================================*/

'use strict';

const SESSION_KEY = 'visorSession';
const AUTH_KEY = 'visorAuth';
const FLUSH_ALARM = 'visor-flush';
const SESSION_PANEL = 'sessionpanel.html';
const LIVE_FLAG = 'visorSessionLive';
const DOCS_PANEL = 'sidepanel.html';
const DEFAULT_TITLE = 'Visor — Writing Sessions & Google Docs History';

// ── State ──────────────────────────────────────────────────────────────────

async function getState() {
  const got = await chrome.storage.session.get(SESSION_KEY);
  return got[SESSION_KEY] || null;
}
async function setState(s) {
  if (s) await chrome.storage.session.set({ [SESSION_KEY]: s });
  else await chrome.storage.session.remove(SESSION_KEY);
  sessionPanelOn = !!(s && s.active);
}
async function patchState(fn) {
  const s = await getState();
  if (!s) return null;
  const out = fn(s) || s;
  await setState(out);
  return out;
}
async function getAuth() {
  const got = await chrome.storage.local.get(AUTH_KEY);
  return got[AUTH_KEY] || null;
}

// Kept in memory only so syncPanel (background.js) can answer without
// waiting; refreshed from storage whenever the worker wakes.
let sessionPanelOn = false;
const sessionReady = getState().then((s) => { sessionPanelOn = !!(s && s.active); }).catch(() => {});

async function hasHostPermission() {
  try { return await chrome.permissions.contains({ origins: ['<all_urls>'] }); } catch (_) { return false; }
}

// ── Talking to the Visor server ────────────────────────────────────────────

async function visorApi(path, { method = 'GET', body, origin } = {}) {
  const auth = await getAuth();
  if (!auth || !auth.token) { const e = new Error('not connected'); e.status = 401; throw e; }
  const base = origin || auth.origin;
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Visor-Token': auth.token },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) { const e = new Error(data.error || `Visor said ${res.status}`); e.status = res.status; e.data = data; throw e; }
  return data;
}

// ── The side panel: session panel during a session, v3.6 Docs panel otherwise ─

async function enterSessionPanelMode() {
  // A popup on the toolbar button would take the click instead of the panel
  await chrome.action.setPopup({ popup: '' }).catch(() => {});
  await chrome.sidePanel.setOptions({ path: SESSION_PANEL, enabled: true }).catch(() => {});
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  // Options set for one tab win over the global ones, and v3.6 sets them on
  // every tab it sees, so point each open tab at the session panel too.
  const tabs = await chrome.tabs.query({}).catch(() => []);
  for (const t of tabs) {
    panelEnabled.set(t.id, 'session');
    await chrome.sidePanel.setOptions({ tabId: t.id, path: SESSION_PANEL, enabled: true }).catch(() => {});
  }
}

// Exactly what v3.6 does: the Docs panel, only on the document tab it was
// opened from, and the toolbar button opens the popup.
async function restoreDocsPanelMode() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  await chrome.sidePanel.setOptions({ path: DOCS_PANEL, enabled: false }).catch(() => {});
  await chrome.action.setPopup({ popup: 'popup.html' }).catch(() => {});
  const tabs = await chrome.tabs.query({}).catch(() => []);
  panelEnabled.clear();
  for (const t of tabs) await syncPanel(t.id, t.url);
}

async function setBadge(on, recording = true) {
  if (on) {
    await chrome.action.setBadgeText({ text: 'REC' }).catch(() => {});
    await chrome.action.setBadgeBackgroundColor({ color: '#D9534F' }).catch(() => {});
    await chrome.action.setTitle({ title: recording ? 'Visor session: research is being recorded' : 'Visor session (research isn’t being recorded)' }).catch(() => {});
  } else {
    await chrome.action.setBadgeText({ text: '' }).catch(() => {});
    await chrome.action.setTitle({ title: DEFAULT_TITLE }).catch(() => {});
  }
}

// ── Starting and ending ────────────────────────────────────────────────────

// SESSION_START comes twice: without a token (confirm to the server that the
// extension is here, Section 7.1) and with one once the session has begun.
async function sessionStart(payload, sender) {
  const { docId, assignmentId, sessionToken, settings = {} } = payload || {};
  const auth = await getAuth();
  if (!auth || !auth.token) return { ok: false, connected: false, error: 'The Visor extension isn’t connected.' };
  if (!docId) return { ok: false, error: 'no document' };
  const origin = sender && sender.origin ? sender.origin : auth.origin;
  const perm = await hasHostPermission();
  try {
    await visorApi('/api/ext/session/ack', { method: 'POST', body: { docId, version: chrome.runtime.getManifest().version, hasHostPermission: perm }, origin });
  } catch (e) {
    if (e.status === 401) await disconnectedByServer();
    return { ok: false, error: e.message };
  }
  if (!sessionToken) return { ok: true, acked: true, hasHostPermission: perm };

  const prev = await getState();
  const recording = !!settings.researchTracking && perm;
  const state = {
    active: true, docId, assignmentId, sessionToken, origin,
    settings: { ...settings, blockedSites: Array.isArray(settings.blockedSites) ? settings.blockedSites : VisorConfig.DEFAULT_AI_SITES, allowedSites: Array.isArray(settings.allowedSites) ? settings.allowedSites : [] },
    startedAt: settings.startedAt || (prev && prev.docId === docId ? prev.startedAt : new Date().toISOString()),
    deadlineAt: settings.deadlineAt || null,
    visorTabId: sender && sender.tab ? sender.tab.id : (prev && prev.visorTabId) || null,
    visorWindowId: sender && sender.tab ? sender.tab.windowId : (prev && prev.visorWindowId) || null,
    recording, hasHostPermission: perm,
    researchQueue: prev && prev.docId === docId ? prev.researchQueue || [] : [],
    lastFlush: null,
    // Sent again for the same session (a reload, another tab): keep the open visit
    current: prev && prev.docId === docId ? prev.current || null : null,
    lastSearch: prev && prev.docId === docId ? prev.lastSearch || null : null,
    // Writing in the side panel (locked sessions): kept across a re-send too,
    // or, if the extension lost its state (a browser restart), as the page says
    researchMode: prev && prev.docId === docId ? !!prev.researchMode : !!settings.research,
    lockActive: false
  };
  await setState(state);
  // Survives a browser restart (session storage doesn't): if Chrome restarts
  // mid-session, startup finds this and undoes the session's changes.
  await chrome.storage.local.set({ [LIVE_FLAG]: { docId, at: new Date().toISOString() } });
  await setBadge(true, recording);
  await enterSessionPanelMode();
  if (recording) await startResearchCapture();
  if (state.settings.mode === 'locked' || state.settings.blockAiSites) await relock();
  // One-click citing turned off for this assignment: no right-click item
  if (state.settings.oneClickCite === false) removeCiteMenu();
  else addCiteMenu();
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
  await extBeat();
  return { ok: true, recording, lockActive: (await getState()).lockActive };
}

// Session over (the page said so, the server said so, or the token stopped
// working): stop recording, put everything back the way v3.6 had it.
async function sessionEnd(reason) {
  const s = await getState();
  if (s && s.active) {
    await withState((x) => closeCurrentVisit(x, Date.now())).catch(() => {});
    if (flushing) await flushing.catch(() => {});
    await flushResearch().catch(() => {});
  }
  await stopResearchCapture();
  await lockChained(() => lockdownOff());
  await chrome.alarms.clear(FLUSH_ALARM).catch(() => {});
  removeCiteMenu();
  await setState(null);
  await chrome.storage.local.remove(LIVE_FLAG);
  await setBadge(false);
  await restoreDocsPanelMode();
  return { ok: true, ended: reason || 'ended' };
}

// Chrome restarted (or the extension reloaded) in the middle of a session:
// session storage is gone but the lockdown rules, badge, menu and panel
// settings aren't. Undo them, so the browser isn't left locked.
async function recoverFromLostSession() {
  const s = await getState();
  if (s && s.active) return;
  const flag = (await chrome.storage.local.get(LIVE_FLAG))[LIVE_FLAG];
  let rules = [];
  try { rules = (await chrome.declarativeNetRequest.getDynamicRules()).filter((r) => r.id >= VisorLockdown.RULE_BASE && r.id < VisorLockdown.RULE_BASE + 1000); } catch (_) {}
  if (!flag && !rules.length) return;
  await stopResearchCapture();
  await clearRules();
  await chrome.alarms.clear(FLUSH_ALARM).catch(() => {});
  removeCiteMenu();
  await chrome.storage.local.remove(LIVE_FLAG);
  await setBadge(false);
  await restoreDocsPanelMode();
}
sessionReady.then(recoverFromLostSession).catch(() => {});

async function disconnectedByServer() {
  await chrome.storage.local.remove(AUTH_KEY);
  if (await getState()) await sessionEnd('token-rejected');
}

// The extension's beat: the server learns it's still here and whether the
// lockdown is on; the extension learns whether the session is still running,
// and which surface holds the editing lease (leaseSurf).
async function extBeat() {
  const s = await getState();
  if (!s || !s.active) return;
  try {
    const r = await visorApi('/api/ext/session/beat', { method: 'POST', body: { docId: s.docId, lockActive: !!s.lockActive, hasHostPermission: await hasHostPermission(), version: chrome.runtime.getManifest().version }, origin: s.origin });
    if (!r.active) return sessionEnd('server');
    if (r.deadlineAt !== s.deadlineAt) await patchState((x) => { x.deadlineAt = r.deadlineAt; });
    // The tab drives research mode; this catches up if a message was missed.
    // Not right after a switch: the tab moves the lease just after its message.
    const settling = s.researchAt && Date.now() - s.researchAt < RESEARCH_SETTLE_MS;
    if (s.settings.mode === 'locked' && s.settings.panelBrowsing !== false && !settling) {
      if (r.leaseSurf === 'panel' && !s.researchMode) await setResearchMode(true);
      else if (r.leaseSurf === 'tab' && s.researchMode) await setResearchMode(false);
    }
  } catch (e) {
    if (e.status === 401) return disconnectedByServer();
  }
}

// Research mode: a locked session writing in the side panel. Other tabs are
// research then, so the allowed list is set aside and only the blocked (AI)
// sites stay blocked. Everything is recorded as usual.
const RESEARCH_SETTLE_MS = 15_000;
// One rule rebuild at a time (a session starting, a research switch, the
// beat catching up, the session ending): two at once would collide, and each
// one reads the state fresh, so none can undo a newer one
let lockChain = Promise.resolve();
function lockChained(job) {
  const run = lockChain.then(job);
  lockChain = run.catch(() => {});
  return run;
}
function relock() {
  return lockChained(async () => {
    const cur = await getState();
    if (cur && cur.active && (cur.settings.mode === 'locked' || cur.settings.blockAiSites)) await lockdownOn(cur);
  });
}
function setResearchMode(on) {
  return lockChained(() => switchResearchMode(on));
}
async function switchResearchMode(on) {
  const s = await getState();
  if (!s || !s.active) return { ok: false, error: 'no session' };
  if (s.settings.mode === 'locked' && s.settings.panelBrowsing === false) return { ok: false, error: 'Side-panel mode is turned off for this assignment.' };
  // Open sessions have no allowed list: nothing to change
  if (s.settings.mode !== 'locked') return { ok: true, researchMode: !!s.researchMode };
  // Already there (the tab says so once per page load): nothing to rebuild
  if (!!s.researchMode === !!on) return { ok: true, researchMode: !!on };
  // In the state chain, so a research event being written can't undo it
  await withState((x) => { x.researchMode = !!on; x.researchAt = Date.now(); });
  // The rules are rebuilt both ways. Tabs opened while researching stay as
  // they are: the teacher allowed that research, and back in full screen the
  // student can't look at them without a pause being recorded.
  const next = await getState();
  if (next && next.active) await lockdownOn(next, { sweep: false });
  return { ok: true, researchMode: !!on };
}

// ── Messages from the Visor page (site-bridge.js) ─────────────────────────

async function handleBridge(msg, sender) {
  const p = msg.payload || {};
  // Only Visor's own pages may talk to the extension this way
  if (!sender || !VisorConfig.isVisorOrigin(sender.url || sender.origin || '')) return { ok: false, error: 'not a Visor page' };
  switch (msg.type) {
    case 'PING': {
      const auth = await getAuth();
      const s = await getState();
      return {
        ok: true, installed: true, version: chrome.runtime.getManifest().version,
        connected: !!(auth && auth.token && auth.origin === sender.origin),
        user: auth && auth.origin === sender.origin ? auth.user : null,
        hasHostPermission: await hasHostPermission(),
        lockActive: !!(s && s.lockActive),
        session: s && s.active ? { docId: s.docId, assignmentId: s.assignmentId } : null
      };
    }
    case 'CONNECT': {
      if (!p.token) return { ok: false, error: 'no token' };
      await chrome.storage.local.set({ [AUTH_KEY]: { token: String(p.token), user: p.user || null, origin: sender.origin, connectedAt: new Date().toISOString() } });
      await chrome.storage.session.remove('visorLinked');
      return { ok: true };
    }
    case 'DISCONNECT': {
      await chrome.storage.local.remove(AUTH_KEY);
      if (await getState()) await sessionEnd('disconnected');
      return { ok: true };
    }
    case 'SESSION_START': return sessionStart(p, sender);
    case 'SESSION_END': {
      const s = await getState();
      if (s && (!p.docId || p.docId === s.docId)) return sessionEnd('page');
      return { ok: true };
    }
    case 'OPEN_PANEL': {
      // Needs the click that sent this message, so open() is called first thing
      try {
        await chrome.sidePanel.open({ windowId: sender.tab.windowId });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: 'Click the Visor icon in Chrome’s toolbar to open the side panel.' };
      }
    }
    case 'REQUEST_PERMISSION': return requestHostPermission();
    case 'RESEARCH_MODE': {
      // The tab moved the editing lease to the side panel, or took it back
      const s = await getState();
      if (!s || !s.active || !p.docId || p.docId !== s.docId) return { ok: false, error: 'no session' };
      return setResearchMode(!!p.on);
    }
  }
  return { ok: false, error: 'unknown request' };
}

// <all_urls> is optional and must be granted from a click in one of the
// extension's own pages. The page can't do that, so a small Visor window asks.
let permissionWaiters = [];
async function requestHostPermission() {
  if (await hasHostPermission()) return { ok: true, granted: true };
  return new Promise((resolve) => {
    permissionWaiters.push(resolve);
    if (permissionWaiters.length === 1) {
      chrome.windows.create({ url: 'permission.html', type: 'popup', width: 440, height: 420, focused: true }).catch(() => {
        permissionWaiters.splice(0).forEach((r) => r({ ok: false, granted: false }));
      });
    }
    setTimeout(() => { const i = permissionWaiters.indexOf(resolve); if (i >= 0) { permissionWaiters.splice(i, 1); resolve({ ok: true, granted: false }); } }, 115000);
  });
}
async function permissionAnswered(granted) {
  const s = await getState();
  if (granted && s && s.active && s.settings.researchTracking && !s.recording) {
    await patchState((x) => { x.recording = true; x.hasHostPermission = true; });
    await startResearchCapture();
    await setBadge(true, true);
  }
  permissionWaiters.splice(0).forEach((r) => r({ ok: true, granted: !!granted }));
}

// ── Research capture (Section 8.3) ─────────────────────────────────────────
//
// Only while a session is active and its assignment records research, and only
// with the optional <all_urls> permission. Events:
//   visit   a page became the one the student is looking at
//   leave   it stopped being that page (with how long it was open: dwellMs)
//   search  a search on one of the engines research.js knows (deduplicated over 10 s)
//   copy    20+ characters copied from a page (hash, length, first 140 characters)
//   ai-site a visit to a site on the assignment's AI list (blocked or not)
//   blocked / cite  (from the lockdown and the cite button)
// They queue in session storage and go to the server every minute, 200 at a time.

const CAPTURE_ID = 'visor-research';
const QUEUE_MAX = 5000;
const SEARCH_DEDUPE_MS = 10_000;

// Session state changes one at a time: events arrive faster than storage writes
let stateChain = Promise.resolve();
function withState(fn) {
  const run = stateChain.then(async () => {
    const s = await getState();
    if (!s || !s.active) return null;
    const out = await fn(s);
    await setState(s);
    return out;
  });
  stateChain = run.catch(() => {});
  return run;
}

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ''; } };
const capUrl = (url) => String(url || '').slice(0, 2000);

function queueEvent(s, ev) {
  s.researchQueue = s.researchQueue || [];
  if (s.researchQueue.length >= QUEUE_MAX) s.researchQueue.shift();
  s.researchQueue.push({ t: Date.now(), ...ev });
}

async function startResearchCapture() {
  try {
    const have = await chrome.scripting.getRegisteredContentScripts({ ids: [CAPTURE_ID] });
    if (!have.length) {
      await chrome.scripting.registerContentScripts([{ id: CAPTURE_ID, js: ['cite.js', 'research-capture.js'], matches: ['<all_urls>'], runAt: 'document_idle', allFrames: false, persistAcrossSessions: false }]);
    }
  } catch (_) { /* no permission: nothing recorded */ }
  // Pages already open don't get registered scripts until they reload
  const tabs = await chrome.tabs.query({}).catch(() => []);
  for (const t of tabs) {
    if (!VisorResearch.isRecordable(t.url || '', VisorConfig.VISOR_WEB_ORIGINS)) continue;
    chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['cite.js', 'research-capture.js'] }).catch(() => {});
  }
  await focusChanged();
}

async function stopResearchCapture() {
  await chrome.scripting.unregisterContentScripts({ ids: [CAPTURE_ID] }).catch(() => {});
}

// The page the student is looking at changed: close the old visit, open the new one
async function closeCurrentVisit(s, now) {
  const cur = s.current;
  if (!cur) return;
  let title = cur.title;
  try { const t = await chrome.tabs.get(cur.tabId); if (t && t.url === cur.url && t.title) title = t.title; } catch (_) {}
  queueEvent(s, { type: 'leave', url: cur.url, host: cur.host, title: String(title || '').slice(0, 300), dwellMs: Math.max(0, now - cur.since), t: now });
  s.current = null;
}
function openVisit(s, tab, now) {
  if (!tab || !VisorResearch.isRecordable(tab.url || '', VisorConfig.VISOR_WEB_ORIGINS)) return;
  s.current = { tabId: tab.id, url: capUrl(tab.url), host: hostOf(tab.url), title: String(tab.title || '').slice(0, 300), since: now };
  queueEvent(s, { type: 'visit', url: s.current.url, host: s.current.host, title: s.current.title, t: now });
}

// Which tab the student is looking at right now (focused window, active tab)
async function lookingAt() {
  try {
    const win = await chrome.windows.getLastFocused({ populate: true });
    if (!win || !win.focused) return null;
    return (win.tabs || []).find((t) => t.active) || null;
  } catch (_) { return null; }
}

async function focusChanged() {
  const tab = await lookingAt();
  await withState(async (s) => {
    if (!s.recording) return;
    const now = Date.now();
    if (s.current && tab && s.current.tabId === tab.id && s.current.url === capUrl(tab.url)) return;
    await closeCurrentVisit(s, now);
    if (tab) openVisit(s, tab, now);
  });
}

// A main-frame navigation committed: a new page (and maybe a search)
// The top-level document of a tab (frameId 0), or a prerendered page that
// became one (Chrome gives those another frameId)
const topFrame = (d) => d.frameId === 0 || d.frameType === 'outermost_frame';

async function navigated(details) {
  if (!topFrame(details) || details.documentLifecycle === 'prerender') return;
  await recordSearch(details.url);
  const tab = await lookingAt();
  if (tab && tab.id === details.tabId) await focusChanged();
}

// One search, however many navigation events report it (deduplicated over 10 s)
async function recordSearch(url) {
  const search = VisorResearch.parseSearch(url);
  if (!search) return;
  await withState(async (s) => {
    if (!s.recording) return;
    const now = Date.now();
    const last = s.lastSearch;
    if (!(last && last.engine === search.engine && last.query === search.query && now - last.t < SEARCH_DEDUPE_MS)) {
      queueEvent(s, { type: 'search', url: capUrl(url), host: hostOf(url), query: search.query, engine: search.engine, t: now });
    }
    s.lastSearch = { ...search, t: now };
  });
}

// Before a main-frame navigation: AI sites are recorded even when the lockdown
// is about to redirect them to blocked.html (so the commit never shows them).
async function beforeNavigate(details) {
  if (!topFrame(details)) return;
  // A search that redirects straight to a result (Wikipedia's exact-title
  // search) never commits its own URL, so it's read here too
  if (details.documentLifecycle !== 'prerender' && VisorResearch.parseSearch(details.url)) await recordSearch(details.url);
  await withState(async (s) => {
    const hit = VisorResearch.siteMatch(details.url, s.settings.blockedSites);
    if (!hit) return;
    const blocked = !!s.settings.blockAiSites || (s.settings.mode === 'locked' && s.lockActive && !inResearch(s) && (s.settings.allowedSites || []).length > 0);
    const ev = { type: 'ai-site', url: capUrl(details.url), host: hostOf(details.url), site: hit, blocked };
    // Recorded with or without research tracking: it's part of the session
    queueEvent(s, ev);
  });
}

async function copied(msg, sender) {
  const url = (sender && sender.tab && sender.tab.url) || msg.url;
  if (!VisorResearch.isRecordable(url || '', VisorConfig.VISOR_WEB_ORIGINS)) return;
  const text = String(msg.text || '');
  const norm = text.replace(/\s+/g, ' ').trim();
  if (norm.length < 20) return;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm));
  const hash = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const queued = await withState(async (s) => {
    if (!s.recording) return false;
    queueEvent(s, { type: 'copy', url: capUrl(url), host: hostOf(url), title: String(msg.title || (sender.tab && sender.tab.title) || '').slice(0, 300), copy: { hash, len: Number(msg.len) || text.length, preview: text.slice(0, 140) } });
    return true;
  });
  // A copy is usually pasted within seconds: send it now rather than at the
  // next minute, so the paste can show which page it came from
  if (queued) { clearTimeout(copyFlushTimer); copyFlushTimer = setTimeout(() => flushResearch().catch(() => {}), 1500); }
}
let copyFlushTimer = null;

// Send queued events to the server, 200 at a time. They stay queued (in
// session storage, which survives the worker sleeping) until the server has them.
let flushing = null;   // the flush in progress, if any
function flushResearch() {
  if (flushing) return flushing;
  flushing = (async () => {
    for (let i = 0; i < 10; i++) {
      const s = await getState();
      if (!s || !s.researchQueue || !s.researchQueue.length) return;
      const batch = s.researchQueue.slice(0, 200);
      try {
        await visorApi('/api/ext/research', { method: 'POST', body: { sessionToken: s.sessionToken, docId: s.docId, events: batch }, origin: s.origin });
      } catch (e) {
        if (e.status === 401 && e.data && e.data.reconnect) { await disconnectedByServer(); return; }
        if (e.status === 410) { await withState((x) => { x.researchQueue = []; }); return; }
        return; // try again on the next alarm
      }
      // Drop what was sent (events queued meanwhile stay), inside the state chain
      await withState((x) => {
        const q = x.researchQueue || [];
        const sentT = new Set(batch.map((e) => `${e.t}|${e.type}|${e.url || ''}`));
        let drop = 0;
        while (drop < q.length && drop < batch.length && sentT.has(`${q[drop].t}|${q[drop].type}|${q[drop].url || ''}`)) drop++;
        x.researchQueue = q.slice(drop);
        x.lastFlush = new Date().toISOString();
      });
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

chrome.webNavigation.onCommitted.addListener((d) => { navigated(d).catch(() => {}); });
chrome.webNavigation.onBeforeNavigate && chrome.webNavigation.onBeforeNavigate.addListener((d) => { beforeNavigate(d).catch(() => {}); });
// Single-page sites (YouTube's search box, Perplexity) change the address without a new page load
chrome.webNavigation.onHistoryStateUpdated && chrome.webNavigation.onHistoryStateUpdated.addListener((d) => { navigated(d).catch(() => {}); });
// A prerendered page the student actually opens shows up as the tab's new address
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!info.url || !tab || !tab.active) return;
  getState().then((st) => { if (st && st.active && st.recording) navigated({ tabId, frameId: 0, url: info.url }).catch(() => {}); });
});
chrome.tabs.onActivated.addListener(() => { focusChanged().catch(() => {}); });
chrome.windows.onFocusChanged.addListener(() => { focusChanged().catch(() => {}); });
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'VISOR_RESEARCH_COPY') copied(msg, sender).catch(() => {});
  return false;
});

// ── The cite button (Section 8.6) ──────────────────────────────────────────
//
// Triggers: the session panel's button, the right-click item "Cite this page
// with Visor" (only during a session) and Alt+Shift+C. The page's citation
// details are read in the page by cite.js; the Visor editor formats them in
// the assignment's style, inserts the in-text citation and adds the entry.
// Outside a session the button still works: it copies an MLA citation.
// A teacher can turn one-click citing off for an assignment (oneClickCite:
// false): then all three only say so. Sources added by hand still work.

const CITE_MENU = 'visor-cite';
const CITE_OFF = 'One-click citing is turned off for this assignment.';

async function readCitationMeta(tab) {
  if (!tab || !/^https?:/.test(tab.url || '') || VisorConfig.isVisorOrigin(tab.url)) {
    throw new Error('Open the page you want to cite, then cite it.');
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['cite.js'] });
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => self.VisorCite.extractCitationMeta(document, location.href) });
    if (!res || !res.result) throw new Error('empty');
    return res.result;
  } catch (e) {
    throw new Error('Visor can’t read this page. Allow research recording for Visor, or cite it by hand in Sources.');
  }
}

async function activeTabForCite(windowId) {
  const q = windowId != null ? { active: true, windowId } : { active: true, lastFocusedWindow: true };
  const [tab] = await chrome.tabs.query(q).catch(() => []);
  return tab || null;
}

async function citeTab(tab, from) {
  const s = await getState();
  // The panel button, the right-click item and Alt+Shift+C all come here
  if (s && s.active && s.settings.oneClickCite === false) {
    if (from !== 'panel') toastInTab(tab, CITE_OFF);
    return { ok: false, error: CITE_OFF };
  }
  let meta;
  try { meta = await readCitationMeta(tab); }
  catch (e) { if (from !== 'panel') toastInTab(tab, e.message); return { ok: false, error: e.message }; }
  if (s && s.active) {
    // Both editors hear it; the one holding the editing lease acts on it
    let delivered = false;
    try { const r = await chrome.runtime.sendMessage({ type: 'VISOR_CITE_TO_PANEL', meta }); delivered = !!(r && r.ok); } catch (_) {}
    if (s.visorTabId != null) {
      try { await chrome.tabs.sendMessage(s.visorTabId, { channel: 'visor-to-page', type: 'CITE', meta }); delivered = true; } catch (_) {}
    }
    if (!delivered) return { ok: false, error: 'Open your Visor document (the side panel or the Visor tab) to add the citation.' };
    if (from !== 'panel') toastInTab(tab, `Cited in your essay: ${meta.title || meta.url}`);
    return { ok: true, meta, message: `Cited: ${meta.title || 'this page'}` };
  }
  // No session: copy a formatted citation to the clipboard
  let text = '';
  try {
    const auth = await getAuth();
    const base = (auth && auth.origin) || await openVisorOrigin();
    const r = await fetch(`${base}/api/ext/cite/format`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meta, style: 'mla' }) });
    if (r.ok) text = (await r.json()).text;
  } catch (_) {}
  // Visor couldn't be reached: the bare minimum, so the student has the source
  const fallback = !text;
  if (fallback) text = [meta.authors && meta.authors[0], meta.title ? `“${meta.title}.”` : '', meta.siteName, meta.url].filter(Boolean).join(' ');
  await copyInTab(tab, text, fallback ? 'Copied the page’s title and link (Visor couldn’t be reached to format it).' : 'MLA citation copied');
  return { ok: true, copied: true, text };
}

// The page shows a small note, and (outside a session) puts the text on the clipboard
async function copyInTab(tab, text, note) {
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [text, note], func: (t, n) => {
    const done = () => {
      const el = document.createElement('div');
      el.textContent = n;
      el.setAttribute('role', 'status');
      el.style.cssText = 'position:fixed;z-index:2147483647;left:50%;bottom:24px;transform:translateX(-50%);background:#10303D;color:#fff;font:600 14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;padding:10px 16px;border-radius:999px;box-shadow:0 6px 24px rgba(0,0,0,.2)';
      document.documentElement.appendChild(el);
      setTimeout(() => el.remove(), 3200);
    };
    const old = () => { const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;opacity:0'; document.documentElement.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (_) {} ta.remove(); };
    (navigator.clipboard ? navigator.clipboard.writeText(t).catch(old) : Promise.resolve(old())).then(done, done);
  } }).catch(() => {});
}
async function toastInTab(tab, note) {
  if (!tab || !/^https?:/.test(tab.url || '')) return;
  chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [note], func: (n) => {
    const el = document.createElement('div');
    el.textContent = n; el.setAttribute('role', 'status');
    el.style.cssText = 'position:fixed;z-index:2147483647;left:50%;bottom:24px;transform:translateX(-50%);background:#10303D;color:#fff;font:600 14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;padding:10px 16px;border-radius:999px;box-shadow:0 6px 24px rgba(0,0,0,.2)';
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  } }).catch(() => {});
}

function addCiteMenu() {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({ id: CITE_MENU, title: 'Cite this page with Visor', contexts: ['page', 'selection', 'link', 'image'] }, () => void chrome.runtime.lastError);
  });
}
function removeCiteMenu() { chrome.contextMenus.removeAll(() => void chrome.runtime.lastError); }

chrome.contextMenus.onClicked.addListener((info, tab) => { if (info.menuItemId === CITE_MENU) citeTab(tab, 'menu'); });
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'cite-page') return;
  citeTab(tab || await activeTabForCite(), 'command');
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'VISOR_CITE_ACTIVE') return false;
  activeTabForCite(sender.tab ? sender.tab.windowId : undefined).then((tab) => citeTab(tab, msg.from)).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
  return true;
});

// ── Lockdown (Section 8.4) ─────────────────────────────────────────────────
//
// Locked sessions: declarativeNetRequest sends pages that aren't allowed to
// blocked.html (lockdown.js builds the rules), and tabs opening the browser's
// own extension and settings pages are sent back to the Visor tab. Open
// sessions with "block AI sites" get only the AI-site rules. What an extension
// can't stop (a second device, incognito unless the school turns it off) is
// in docs/IT-GUIDE.md.

async function clearRules() {
  try {
    const have = await chrome.declarativeNetRequest.getDynamicRules();
    const ids = have.map((r) => r.id).filter((id) => id >= VisorLockdown.RULE_BASE && id < VisorLockdown.RULE_BASE + 1000);
    if (ids.length) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
  } catch (_) {}
}

// Research mode (setResearchMode above) loosens a locked session's rules
function inResearch(s) {
  return !!s.researchMode && s.settings.panelBrowsing !== false;
}

async function lockdownOn(state, { sweep = true } = {}) {
  await clearRules();
  const research = inResearch(state);
  const rules = VisorLockdown.buildBlockRules(state.settings, { visorOrigin: state.origin, blockedPage: chrome.runtime.getURL('blocked.html'), research });
  let ok = false;
  if (rules.length) {
    try { await chrome.declarativeNetRequest.updateDynamicRules({ addRules: rules }); ok = true; } catch (e) { console.warn('Visor lockdown rules failed:', e && e.message); }
  }
  // A locked session with nothing to redirect (no list, AI sites only flagged)
  // is still locked: the browser-page bounce below applies
  const locked = state.settings.mode === 'locked' && (ok || !rules.length);
  await patchState((x) => { x.lockActive = locked; x.aiBlockActive = ok; });
  // Pages already open don't go through the new rules: send away the ones
  // that aren't allowed now. Not in research mode: those rules are looser.
  if (ok && !research && sweep) {
    const tabs = await chrome.tabs.query({}).catch(() => []);
    for (const t of tabs) {
      if (!t.url || !VisorLockdown.blockedReason(t.url, state.settings, state.origin, { research })) continue;
      queueBlocked(t.url);
      chrome.tabs.update(t.id, { url: `${chrome.runtime.getURL('blocked.html')}?u=${t.url}` }).catch(() => {});
    }
  }
}
function queueBlocked(url) {
  withState((x) => { queueEvent(x, { type: 'blocked', url: capUrl(url), host: hostOf(url) }); }).catch(() => {});
}

async function lockdownOff() {
  await clearRules();
  await patchState((x) => { x.lockActive = false; x.aiBlockActive = false; });
}

// Send a tab back to the Visor tab (and say why on the blocked page)
async function bounce(tabId, url) {
  const s = await getState();
  if (!s || !s.active) return;
  try { await chrome.tabs.update(tabId, { url: `${chrome.runtime.getURL('blocked.html')}?u=${url}` }); } catch (_) {}
  if (s.visorTabId != null) {
    try { await chrome.tabs.update(s.visorTabId, { active: true }); } catch (_) {}
    if (s.visorWindowId != null) chrome.windows.update(s.visorWindowId, { focused: true }).catch(() => {});
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url) return;
  const s = await getState();
  if (!s || !s.active || !s.lockActive) return;
  if (VisorLockdown.shouldBounce(info.url)) {
    await withState((x) => { queueEvent(x, { type: 'blocked', url: capUrl(info.url), host: hostOf(info.url) }); });
    bounce(tabId, info.url);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === 'VISOR_BLOCKED') {
    // From blocked.html: the attempt is part of the session record. An AI site
    // was already recorded (an ai-site event, blocked) before the redirect, so
    // only other sites get a 'blocked' event. The answer says which it was, for
    // the page's wording.
    getState().then(async (s) => {
      const reason = s && s.active ? VisorLockdown.blockedReason(msg.url, s.settings, s.origin, { research: inResearch(s) }) : null;
      if (reason !== 'ai') await withState((x) => { queueEvent(x, { type: 'blocked', url: capUrl(msg.url), host: hostOf(msg.url) }); }).catch(() => {});
      sendResponse({ reason });
    }).catch(() => sendResponse({ reason: null }));
    return true;
  }
  if (msg.type === 'VISOR_BACK_TO_WRITING') {
    getState().then(async (s) => {
      if (!s) return;
      // The blocked page took over the Visor tab itself (or that tab is gone):
      // load the essay in this tab instead
      let visorTab = null;
      if (s.visorTabId != null) visorTab = await chrome.tabs.get(s.visorTabId).catch(() => null);
      if (!visorTab || (sender.tab && sender.tab.id === s.visorTabId) || !VisorConfig.isVisorOrigin(visorTab.url || '')) {
        if (sender.tab) {
          await chrome.tabs.update(sender.tab.id, { url: `${s.origin}/write/${encodeURIComponent(s.assignmentId)}` }).catch(() => {});
          await patchState((x) => { x.visorTabId = sender.tab.id; x.visorWindowId = sender.tab.windowId; });
        }
        return;
      }
      // Writing in the side panel (research mode): the panel is next to every
      // tab, so just leave the blocked page (or close it if there's no way back)
      if (inResearch(s) && sender.tab && sender.tab.id !== s.visorTabId) {
        chrome.tabs.goBack(sender.tab.id).catch(() => chrome.tabs.remove(sender.tab.id).catch(() => {}));
        return;
      }
      try { await chrome.tabs.update(s.visorTabId, { active: true }); } catch (_) {}
      if (s.visorWindowId != null) chrome.windows.update(s.visorWindowId, { focused: true }).catch(() => {});
      if (sender.tab && sender.tab.id !== s.visorTabId) chrome.tabs.remove(sender.tab.id).catch(() => {});
    });
  }
  return false;
});

// ── Group documents (Section 8.7) ──────────────────────────────────────────
//
// Works with or without a session. When the student is connected and a Google
// Doc they open is linked to one of their group projects, each fresh analysis
// the content script makes goes to that project (at most every 5 minutes per
// document). The side panel's "Send to Visor" box sends on request, to a
// project picked from a list (connected) or by project code (not connected,
// the original code-based route).

const LINKED_TTL_MS = 10 * 60 * 1000;
const AUTO_SEND_EVERY_MS = 5 * 60 * 1000;

// Not connected: the Visor site open in a tab (a local copy while testing),
// else the default address
async function openVisorOrigin() {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  for (const t of tabs) {
    try { const o = new URL(t.url || '').origin; if (VisorConfig.VISOR_WEB_ORIGINS.includes(o)) return o; } catch (_) {}
  }
  return VisorConfig.VISOR_DEFAULT_ORIGIN;
}

async function linkedDocs(force) {
  const auth = await getAuth();
  if (!auth || !auth.token) return [];
  const got = await chrome.storage.session.get('visorLinked');
  const cache = got.visorLinked;
  if (!force && cache && cache.origin === auth.origin && Date.now() - cache.at < LINKED_TTL_MS) return cache.docs;
  try {
    const r = await visorApi('/api/ext/linked-docs');
    await chrome.storage.session.set({ visorLinked: { at: Date.now(), origin: auth.origin, docs: r.docs || [] } });
    return r.docs || [];
  } catch (e) {
    if (e.status === 401) await chrome.storage.local.remove(AUTH_KEY);
    return cache ? cache.docs : [];
  }
}

async function sentLog() { return (await chrome.storage.local.get('visorSent')).visorSent || {}; }
async function noteSent(fileId, names) {
  const log = await sentLog();
  log[fileId] = { at: Date.now(), to: names };
  // keep the 50 most recent documents
  const keep = Object.entries(log).sort((a, b) => b[1].at - a[1].at).slice(0, 50);
  await chrome.storage.local.set({ visorSent: Object.fromEntries(keep) });
}

// A Doc linked a moment ago shouldn't wait out the 10-minute cache: on a
// miss, a cache older than a minute is refreshed
async function isLinked(fileId) {
  if ((await linkedDocs()).some((d) => d.fileId === fileId)) return true;
  const cache = (await chrome.storage.session.get('visorLinked')).visorLinked;
  if (cache && Date.now() - cache.at < 60 * 1000) return false;
  return (await linkedDocs(true)).some((d) => d.fileId === fileId);
}

async function autoSend(msg) {
  const fileId = msg.fileId || (msg.report && msg.report.meta && msg.report.meta.fileId);
  if (!fileId || !msg.report) return { ok: false };
  if (!(await isLinked(fileId))) return { ok: false, linked: false };
  const last = (await sentLog())[fileId];
  if (last && Date.now() - last.at < AUTO_SEND_EVERY_MS) return { ok: true, throttled: true };
  try {
    const r = await visorApi('/api/ext/ingest', { method: 'POST', body: { report: msg.report } });
    await noteSent(fileId, r.sent.map((x) => x.project.name));
    return { ok: true, sent: r.sent };
  } catch (e) { return { ok: false, error: e.message }; }
}

// For the side panel's "Send to Visor" box
async function sendState(fileId) {
  const auth = await getAuth();
  const last = fileId ? (await sentLog())[fileId] || null : null;
  if (!auth || !auth.token) return { connected: false, lastSent: last };
  let projects = [];
  try { projects = (await visorApi('/api/ext/projects')).projects || []; } catch (e) { if (e.status === 401) return { connected: false, lastSent: last }; }
  return { connected: true, user: auth.user, projects: projects.map((p) => ({ ...p, linked: !!fileId && p.fileId === fileId })), lastSent: last };
}

async function sendNow(msg) {
  const report = msg.report;
  const fileId = report && report.meta && report.meta.fileId;
  if (!report) return { ok: false, error: 'Nothing to send yet.' };
  try {
    if (msg.code) {
      // Not connected: the project code route (no sign-in needed)
      const auth = await getAuth();
      const base = (auth && auth.origin) || await openVisorOrigin();
      const res = await fetch(`${base}/api/extension/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: String(msg.code).trim().toUpperCase(), report }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data.error || `Visor said ${res.status}` };
      if (fileId) await noteSent(fileId, [data.project.name]);
      return { ok: true, to: [data.project.name] };
    }
    const r = await visorApi('/api/ext/ingest', { method: 'POST', body: { report, projectId: msg.projectId || undefined } });
    const names = r.sent.map((x) => x.project.name);
    if (fileId) await noteSent(fileId, names);
    return { ok: true, to: names };
  } catch (e) { return { ok: false, error: e.message }; }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  const reply = (p) => { p.then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) })); return true; };
  if (msg.type === 'VISOR_IS_LINKED') return reply(isLinked(msg.fileId).then((linked) => ({ linked })));
  if (msg.type === 'VISOR_AUTO_SEND') return reply(autoSend(msg));
  if (msg.type === 'VISOR_SEND_STATE') return reply(sendState(msg.fileId));
  if (msg.type === 'VISOR_SEND') return reply(sendNow(msg));
  return false;
});

// ── Wiring ─────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== FLUSH_ALARM) return;
  flushResearch().catch(() => {});
  extBeat();
});

// The session panel asks what to show
async function panelState() {
  const s = await getState();
  const auth = await getAuth();
  if (!s || !s.active) return { active: false };
  return {
    active: true, docId: s.docId, assignmentId: s.assignmentId, origin: s.origin, title: s.settings.title || 'Writing session',
    startedAt: s.startedAt, deadlineAt: s.deadlineAt, recording: !!s.recording, mode: s.settings.mode,
    citationStyle: s.settings.citationStyle || 'mla', sessionToken: s.sessionToken, extToken: auth ? auth.token : null,
    oneClickCite: s.settings.oneClickCite !== false, panelBrowsing: s.settings.panelBrowsing !== false, researchMode: !!s.researchMode
  };
}
