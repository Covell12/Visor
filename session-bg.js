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
  if (state.settings.mode === 'locked') await lockdownOn(state);
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
  await extBeat();
  return { ok: true, recording, lockActive: (await getState()).lockActive };
}

// Session over (the page said so, the server said so, or the token stopped
// working): stop recording, put everything back the way v3.6 had it.
async function sessionEnd(reason) {
  const s = await getState();
  if (s && s.active) {
    await closeCurrentVisit(s, Date.now());
    await flushResearch().catch(() => {});
  }
  await stopResearchCapture();
  await lockdownOff();
  await chrome.alarms.clear(FLUSH_ALARM).catch(() => {});
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
// Filled in with research capture: visit / leave / search / copy / AI sites.
async function startResearchCapture() {}
async function stopResearchCapture() {}
async function closeCurrentVisit() {}
async function flushResearch() {}

// ── Lockdown (Section 8.4) ─────────────────────────────────────────────────
// Filled in with lockdown: declarativeNetRequest rules and tab bouncing.
async function lockdownOn() {}
async function lockdownOff() {}

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
