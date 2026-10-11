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
 *   • locked sessions keep the student on allowed sites (lockdown below);
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

async function setBadge(on) {
  if (on) {
    await chrome.action.setBadgeText({ text: 'REC' }).catch(() => {});
    await chrome.action.setBadgeBackgroundColor({ color: '#D9534F' }).catch(() => {});
    await chrome.action.setTitle({ title: 'Visor session: research is being recorded' }).catch(() => {});
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
    lastFlush: null, current: null, lastSearch: null,
    lockActive: false
  };
  await setState(state);
  await setBadge(true);
  await enterSessionPanelMode();
  if (recording) await startResearchCapture();
  if (state.settings.mode === 'locked' || state.settings.blockAiSites) await lockdownOn(state);
  addCiteMenu();
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
    await flushResearch().catch(() => {});
  }
  await stopResearchCapture();
  await lockdownOff();
  await chrome.alarms.clear(FLUSH_ALARM).catch(() => {});
  removeCiteMenu();
  await setState(null);
  await setBadge(false);
  await restoreDocsPanelMode();
  return { ok: true, ended: reason || 'ended' };
}

async function disconnectedByServer() {
  await chrome.storage.local.remove(AUTH_KEY);
  if (await getState()) await sessionEnd('token-rejected');
}

// The extension's beat: the server learns it's still here and whether the
// lockdown is on; the extension learns whether the session is still running.
async function extBeat() {
  const s = await getState();
  if (!s || !s.active) return;
  try {
    const r = await visorApi('/api/ext/session/beat', { method: 'POST', body: { docId: s.docId, lockActive: !!s.lockActive, hasHostPermission: await hasHostPermission(), version: chrome.runtime.getManifest().version }, origin: s.origin });
    if (!r.active) return sessionEnd('server');
    if (r.deadlineAt !== s.deadlineAt) await patchState((x) => { x.deadlineAt = r.deadlineAt; });
  } catch (e) {
    if (e.status === 401) return disconnectedByServer();
  }
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
async function navigated(details) {
  if (details.frameId !== 0) return;
  await withState(async (s) => {
    if (!s.recording) return;
    const now = Date.now();
    const search = VisorResearch.parseSearch(details.url);
    if (search) {
      const last = s.lastSearch;
      if (!(last && last.engine === search.engine && last.query === search.query && now - last.t < SEARCH_DEDUPE_MS)) {
        queueEvent(s, { type: 'search', url: capUrl(details.url), host: hostOf(details.url), query: search.query, engine: search.engine, t: now });
      }
      s.lastSearch = { ...search, t: now };
    }
  });
  const tab = await lookingAt();
  if (tab && tab.id === details.tabId) await focusChanged();
}

// Before a main-frame navigation: AI sites are recorded even when the lockdown
// is about to redirect them to blocked.html (so the commit never shows them).
async function beforeNavigate(details) {
  if (details.frameId !== 0) return;
  await withState(async (s) => {
    const hit = VisorResearch.siteMatch(details.url, s.settings.blockedSites);
    if (!hit) return;
    const blocked = !!s.settings.blockAiSites || (s.settings.mode === 'locked' && s.lockActive && (s.settings.allowedSites || []).length > 0);
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
  await withState(async (s) => {
    if (!s.recording) return;
    queueEvent(s, { type: 'copy', url: capUrl(url), host: hostOf(url), title: String(msg.title || (sender.tab && sender.tab.title) || '').slice(0, 300), copy: { hash, len: Number(msg.len) || text.length, preview: text.slice(0, 140) } });
  });
}

// Send queued events to the server, 200 at a time. They stay queued (in
// session storage, which survives the worker sleeping) until the server has them.
let flushing = false;
async function flushResearch() {
  if (flushing) return;
  flushing = true;
  try {
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
      await stateChain;
      const now = await getState();
      if (!now) return;
      now.researchQueue = (now.researchQueue || []).slice(batch.length);
      now.lastFlush = new Date().toISOString();
      await setState(now);
    }
  } finally { flushing = false; }
}

chrome.webNavigation.onCommitted.addListener((d) => { navigated(d).catch(() => {}); });
chrome.webNavigation.onBeforeNavigate && chrome.webNavigation.onBeforeNavigate.addListener((d) => { beforeNavigate(d).catch(() => {}); });
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

const CITE_MENU = 'visor-cite';

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
    const base = (auth && auth.origin) || VisorConfig.VISOR_DEFAULT_ORIGIN;
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

async function lockdownOn(state) {
  await clearRules();
  const rules = VisorLockdown.buildBlockRules(state.settings, { visorOrigin: state.origin, blockedPage: chrome.runtime.getURL('blocked.html') });
  let ok = false;
  if (rules.length) {
    try { await chrome.declarativeNetRequest.updateDynamicRules({ addRules: rules }); ok = true; } catch (e) { console.warn('Visor lockdown rules failed:', e && e.message); }
  }
  await patchState((x) => { x.lockActive = ok && x.settings.mode === 'locked'; x.aiBlockActive = ok; });
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

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return false;
  if (msg.type === 'VISOR_BLOCKED') {
    // From blocked.html: the attempt is part of the session record
    withState((x) => { queueEvent(x, { type: 'blocked', url: capUrl(msg.url), host: hostOf(msg.url) }); }).catch(() => {});
  }
  if (msg.type === 'VISOR_BACK_TO_WRITING') {
    getState().then(async (s) => {
      if (!s || s.visorTabId == null) return;
      try { await chrome.tabs.update(s.visorTabId, { active: true }); } catch (_) {}
      if (s.visorWindowId != null) chrome.windows.update(s.visorWindowId, { focused: true }).catch(() => {});
      if (sender.tab && sender.tab.id !== s.visorTabId) chrome.tabs.remove(sender.tab.id).catch(() => {});
    });
  }
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
    citationStyle: s.settings.citationStyle || 'mla', sessionToken: s.sessionToken, extToken: auth ? auth.token : null
  };
}
