/* Visor Writer — the writing session around the editor (writer.js).
   Starts, takes over, ends and submits sessions; sends a beat every 10
   seconds and on every focus change; tracks whether this surface may write;
   runs the timer; asks for full screen in locked mode; talks to the Visor
   extension through ext.js when it's there.

   Focus rule (Section 6.4): a surface is focused when the page is visible AND
   the document has focus. The editor accepts input only while its surface is
   focused, holds the lease, and the session is active. */

'use strict';

// Everything about the open writer page. writer.js adds the editor parts.
const WR = {
  assignmentId: null, embed: false, surf: 'tab',
  surfaceId: null,        // per browser tab, kept across reloads (see wsSurfaceId)
  data: null,            // GET /api/write/:assignmentId
  doc: null, session: null, token: null, lease: null, extToken: null,
  serverOffset: 0,       // server time − local time
  events: [],            // session events to send with the next beat
  offline: null,         // { since } while the network is down
  offlinePause: null,    // { from, to } to report once back online
  extPresent: false, extInfo: null, extMissingSince: null,
  timers: [], listeners: [], warned: false, timeUpShown: false, lastBeatAt: 0,
  seenMessage: null, unloadWarn: false
};

const serverNow = () => Date.now() + WR.serverOffset;

// This tab's surface id. sessionStorage keeps it across a reload of the same
// tab, so reloading doesn't hand the editing lease to "another" tab; a new tab
// or the side panel gets its own. Chrome's Duplicate copies sessionStorage, so
// while a page holds an id it marks it alive in localStorage (cleared when the
// page goes away): a copy that finds its id alive takes a new one.
const wsOwnedSurface = {};
const SURFACE_ALIVE_MS = 70000; // hidden tabs may only tick once a minute
function wsSurfaceId(embed) {
  const key = embed ? 'visor-surface-panel' : 'visor-surface';
  if (wsOwnedSurface[key]) return wsOwnedSurface[key];
  const aliveKey = x => `visor-surface-alive:${x}`;
  let id = null;
  try {
    id = sessionStorage.getItem(key);
    const seen = id && Number(localStorage.getItem(aliveKey(id)));
    if (seen && Date.now() - seen < SURFACE_ALIVE_MS) id = null;
    // forget marks left by pages that never said goodbye
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith('visor-surface-alive:') && Date.now() - Number(localStorage.getItem(k)) > SURFACE_ALIVE_MS) localStorage.removeItem(k);
    }
  } catch {}
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).slice(0, 18);
    try { sessionStorage.setItem(key, id); } catch {}
  }
  wsOwnedSurface[key] = id;
  let timer = null;
  const mark = () => { try { localStorage.setItem(aliveKey(id), String(Date.now())); } catch {} };
  const start = () => { mark(); clearInterval(timer); timer = setInterval(mark, 2000); };
  start();
  addEventListener('pagehide', () => { clearInterval(timer); try { localStorage.removeItem(aliveKey(id)); } catch {} });
  addEventListener('pageshow', e => { if (e.persisted) start(); });
  return id;
}

// The extension counts only if it's connected to the account using this page
// (a shared computer can have it connected to someone else)
function extIsMine(p) {
  if (!p || !p.installed || !p.connected) return false;
  return !p.user || !WR.data?.user || p.user.id === WR.data.user.id;
}
function wsNoteExt(p) {
  WR.extInfo = p; WR.extKnown = true;
  WR.extPresent = extIsMine(p);
  WR.extOther = p && p.installed && p.connected && !WR.extPresent ? (p.user?.name || 'another account') : null;
}
// The extension lost its record of this session (it was reloaded, or Chrome
// restarted) or is recording another document: tell it again.
function wsRearmExtension(p) {
  if (!window.VisorExt || WR.embed || !wsActive() || !WR.token || !extIsMine(p)) return;
  if (p.session && p.session.docId === WR.doc.id) return;
  VisorExt.startSession({ docId: WR.doc.id, assignmentId: WR.data.assignment.id, sessionToken: WR.token, settings: wsExtSettings() }).catch(() => {});
}
const wsActive = () => WR.session && WR.session.state !== 'ended';
const isLeaseHolder = () => !!(WR.lease && WR.lease.surfaceId === WR.surfaceId && WR.session && WR.lease.sessionId === WR.session.id);

// fetch with the session token (and the extension token inside the side panel)
async function wapi(path, { method = 'GET', body, keepalive = false } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (WR.token) headers['X-Visor-Session'] = WR.token;
  if (WR.extToken) headers['X-Visor-Token'] = WR.extToken;
  let r;
  try {
    r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin', keepalive });
  } catch (e) {
    const err = new Error('You seem to be offline.'); err.network = true; throw err;
  }
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(data.error || `Request failed (${r.status})`); e.status = r.status; e.data = data; throw e; }
  return data;
}

// The last teacher message shown, remembered across reloads so it isn't shown twice
function wsSeenMessage(id) {
  const key = `visor-msg:${WR.session?.id || ''}`;
  try { if (id) sessionStorage.setItem(key, id); return sessionStorage.getItem(key); } catch { if (id) WR.seenMessage = id; return WR.seenMessage; }
}

function wsNoteEvent(type, detail = {}) { WR.events.push({ type, t: Date.now(), ...detail }); }

/* ---- focus ---- */
function surfaceFocus() {
  const visible = document.visibilityState === 'visible';
  const focused = visible && document.hasFocus();
  const fullscreen = !!document.fullscreenElement;
  return { focused, visible, fullscreen };
}

// Why this surface can't write right now (null = it can)
function lockReason() {
  if (!wsActive()) return WR.session ? 'ended' : 'not-started';
  if (WR.session.pause?.reason === 'teacher') return 'teacher';
  if (!isLeaseHolder()) return 'mirror';
  if (WR.offline) return 'offline';
  const mode = WR.data.assignment.writing.mode;
  if (mode === 'locked' && !WR.embed && WR.extKnown && !WR.extPresent) return 'ext-missing';
  const f = surfaceFocus();
  if (!f.visible) return 'left-tab';
  if (!f.focused) return 'left-window';
  if (mode === 'locked' && !WR.embed && !f.fullscreen) return 'exit-fullscreen';
  return null;
}

/* ---- beats ---- */
let beatInFlight = false, beatAgain = false;
async function wsBeat() {
  if (!wsActive() || !WR.token) return;
  if (beatInFlight) { beatAgain = true; return; }
  beatInFlight = true;
  const f = surfaceFocus();
  const events = WR.events.splice(0);
  const offlinePause = WR.offlinePause; WR.offlinePause = null;
  try {
    const r = await wapi(`/api/write/${WR.doc.id}/beat`, { method: 'POST', body: {
      surfaceId: WR.surfaceId, surf: WR.surf, ...f, online: !WR.offline, extPresent: WR.extKnown ? WR.extPresent : undefined, extLock: WR.extInfo?.lockActive,
      events, offlinePause, seq: WR.seq, wantText: !isLeaseHolder()
    } });
    WR.lastBeatAt = Date.now();
    if (WR.offline) wsBackOnline();
    wsOnBeat(r);
  } catch (e) {
    WR.events.unshift(...events); if (offlinePause) WR.offlinePause = offlinePause;
    if (e.network) wsGoOffline();
    else if (e.status === 401) wsLost(e.message);
  } finally {
    beatInFlight = false;
    if (beatAgain) { beatAgain = false; wsBeat(); }
  }
}

function wsOnBeat(r) {
  WR.serverOffset = Date.parse(r.serverNow) - Date.now();
  const wasHolder = isLeaseHolder();
  WR.session = { ...WR.session, ...r };
  WR.lease = r.lease;
  if (r.teacherMessage && r.teacherMessage.id !== wsSeenMessage()) { wsSeenMessage(r.teacherMessage.id); writerBanner(`Message from your teacher: ${r.teacherMessage.text}`, 'teacher'); }
  if (r.ended) return wsSessionEnded(r);
  // Someone else (the side panel, another tab) took the lease: become a mirror
  if (wasHolder && !isLeaseHolder()) { writerFlush(); }
  if (!isLeaseHolder() && r.text != null) writerLoadServerText({ text: r.text, formats: r.formats, seq: r.seq });
  // Just became a mirror: this beat didn't ask for the text, so ask again now
  else if (!isLeaseHolder() && r.seq !== WR.seq) beatAgain = true;
  writerRefresh();
}

// The server says the session is over (time limit, timeout, window, teacher…)
async function wsSessionEnded(r) {
  const reason = r.endReason || r.session?.endReason;
  WR.session = { ...(WR.session || {}), ...(r.session || r), state: 'ended' };
  WR.token = null;
  if (window.VisorExt) VisorExt.endSession(WR.doc.id).catch(() => {});
  try { WR.data = await writerFetch(); WR.doc = WR.data.doc; } catch {}
  const msg = { 'time-limit': 'Time’s up.', timeout: 'Your session ended because Visor didn’t hear from this page for 3 minutes.', 'window-closed': 'The writing window has closed.', teacher: 'Your teacher ended the session.', submitted: 'Submitted.' }[reason];
  if (reason === 'time-limit') writerBanner(WR.doc.status === 'submitted' ? 'Time’s up. Your essay was submitted.' : 'Time’s up. Submit when you’re ready.', 'warn');
  else if (msg && reason !== 'student' && reason !== 'submitted') writerBanner(msg, 'warn');
  writerRefresh();
}

function wsLost(message) {
  WR.token = null; WR.session = WR.session ? { ...WR.session, state: 'ended' } : null;
  writerBanner(message || 'Your writing session has expired. Reload the page.', 'warn');
  writerRefresh();
}

/* ---- offline ---- */
function wsGoOffline() {
  if (WR.offline) return;
  WR.offline = { since: Date.now() };
  wsNoteEvent('offline');
  writerRefresh();
}
function wsBackOnline() {
  if (!WR.offline) return;
  WR.offlinePause = { from: WR.offline.since, to: Date.now() };
  wsNoteEvent('online');
  WR.offline = null;
  writerFlush();
  writerRefresh();
  wsBeat();
}

/* ---- start, lease, end, submit ---- */
async function wsStart() {
  const btn = $('wrStartBtn');
  const a = WR.data.assignment, w = a.writing;
  const setBtn = (html, disabled) => { if (btn) { btn.innerHTML = html; btn.disabled = disabled; } };
  WR.startError = null; WR.starting = true;
  formError('wrStartErr', '');
  setBtn('<span class="spinner spinner-sm"></span> Starting…', true);
  try {
    // Locked mode: full screen comes first, while this click still counts as a user gesture
    let fullscreen = !!document.fullscreenElement;
    if (w.mode === 'locked' && !WR.embed && !fullscreen) {
      try { await document.documentElement.requestFullscreen(); fullscreen = true; } catch { fullscreen = false; }
    }
    // The extension confirms to the server before the session can start
    let ext = { installed: false };
    if (window.VisorExt) {
      ext = await VisorExt.ping();
      wsNoteExt(ext);
      if (extIsMine(ext)) {
        // (Research permission is asked for with its own button on the start card,
        // so this click's gesture is still good for full screen.)
        await VisorExt.startSession({ docId: WR.doc.id, assignmentId: a.id, sessionToken: null, settings: wsExtSettings() }).catch(() => {});
      }
    }
    const r = await wapi(`/api/write/${WR.doc.id}/sessions`, { method: 'POST', body: { surfaceId: WR.surfaceId, surf: WR.surf, extPresent: WR.extPresent, extVersion: ext.version || null, fullscreen: WR.embed ? true : fullscreen } });
    WR.starting = false;
    await wsAdopt(r);
  } catch (e) {
    // Kept on WR so it survives the redraw that leaving full screen causes
    WR.starting = false; WR.startError = e.message;
    writerRefresh(true);
    if (document.fullscreenElement && !wsActive()) document.exitFullscreen().catch(() => {});
  }
}

// What the extension needs to run the session (Section 8.3)
function wsExtSettings() {
  const w = WR.data.assignment.writing;
  return { mode: w.mode, researchTracking: w.researchTracking, allowedSites: w.allowedSites, blockedSites: w.blockedSites, blockAiSites: w.blockAiSites, citationStyle: w.citationStyle, title: WR.data.assignment.title, origin: location.origin, deadlineAt: WR.session?.deadlineAt || null, startedAt: WR.session?.startedAt || null };
}

// A session (new, taken over, or the one already running) is ours now
async function wsAdopt(r) {
  WR.token = r.token; WR.session = r.session; WR.lease = r.lease || WR.lease;
  WR.serverOffset = Date.parse(r.serverNow || r.session.serverNow) - Date.now();
  if (r.doc) writerLoadServerText(r.doc, { force: true });
  if (r.doc) WR.doc = { ...WR.doc, ...r.doc };
  WR.warned = false; WR.timeUpShown = false;
  if (window.VisorExt && WR.extPresent && !WR.embed) VisorExt.startSession({ docId: WR.doc.id, assignmentId: WR.data.assignment.id, sessionToken: WR.token, settings: wsExtSettings() }).catch(() => {});
  writerRefresh();
  writerCheckStoredQueue();
  wsBeat();
}

async function wsTakeLease() {
  try {
    const r = await wapi(`/api/write/${WR.doc.id}/lease`, { method: 'POST', body: { surfaceId: WR.surfaceId, surf: WR.surf } });
    WR.lease = r.lease;
    writerLoadServerText(r.doc, { force: true });
    writerRefresh();
    writerCheckStoredQueue();
    wsBeat();
    WR.quill?.focus();
  } catch (e) {
    if (e.data?.ended) return wsSessionEnded(e.data);
    toast(e.message, 'err');
  }
}

async function wsEnd() {
  if (!await confirmModal('End this writing session?', 'Your writing is saved. You can start another session later' + (WR.data.assignment.writing.timeLimitMin ? '; the time limit counts every session.' : '.'), { okLabel: 'End session' })) return;
  await writerFlush();
  try { const r = await wapi(`/api/write/${WR.doc.id}/end`, { method: 'POST', body: {} }); await wsSessionEnded({ session: r.session, endReason: 'student' }); }
  catch (e) { toast(e.message, 'err'); }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

async function wsSubmit() {
  const w = WR.data.assignment.writing;
  const words = writerWordCount();
  let note = 'You can’t write in it after this unless your teacher returns it to you.';
  if (w.minWords && words < w.minWords) note = `It has ${words} words; the assignment asks for at least ${w.minWords}. ` + note;
  if (w.maxWords && words > w.maxWords) note = `It has ${words} words; the assignment asks for at most ${w.maxWords}. ` + note;
  if (!await confirmModal('Submit your essay?', note, { okLabel: 'Submit' })) return;
  await writerFlush();
  try {
    const r = await wapi(`/api/write/${WR.doc.id}/submit`, { method: 'POST', body: {} });
    if (r.warning) toast(r.warning);
    WR.token = null;
    if (window.VisorExt) VisorExt.endSession(WR.doc.id).catch(() => {});
    WR.data = await writerFetch(); WR.doc = WR.data.doc; WR.session = WR.data.session;
    writerClearStoredQueue();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    toast('Submitted');
    writerRefresh();
  } catch (e) { toast(e.message, 'err'); }
}

// Resume from the paused card: only if this window really has focus
function wsResume() {
  const mode = WR.data.assignment.writing.mode;
  if (mode === 'locked' && !WR.embed && !document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {}).finally(() => { writerRefresh(); wsBeat(); WR.quill?.focus(); });
    return;
  }
  window.focus();
  WR.quill?.focus();
  writerRefresh(); wsBeat();
}

/* ---- timers and listeners ---- */
function wsInstall() {
  const on = (target, ev, fn, opts) => { target.addEventListener(ev, fn, opts); WR.listeners.push([target, ev, fn, opts]); };
  const changed = () => { writerRefresh(); wsBeat(); };
  on(window, 'focus', changed);
  // Losing focus (often to the side panel) sends what's typed right away, so a
  // lease handoff doesn't strand the last keystrokes
  on(window, 'blur', () => { changed(); writerFlush(); });
  on(document, 'visibilitychange', () => { changed(); if (document.visibilityState === 'hidden') writerFlush({ unload: false }); });
  on(document, 'fullscreenchange', changed);
  on(window, 'online', () => { if (WR.offline) { wsBeat(); writerFlush(); } });
  on(window, 'offline', () => { if (wsActive()) wsGoOffline(); });
  on(window, 'beforeunload', e => { if (wsActive() && isLeaseHolder() && WR.data.assignment.writing.mode === 'locked') { e.preventDefault(); e.returnValue = ''; } });
  on(window, 'pagehide', () => writerFlush({ unload: true }));
  WR.timers.push(setInterval(wsBeat, 10000));
  WR.timers.push(setInterval(wsTick, 1000));
  WR.timers.push(setInterval(() => writerFlush(), 1500));
  WR.timers.push(setInterval(wsCheckExtension, 15000));
}
function wsUninstall() {
  WR.timers.forEach(clearInterval); WR.timers = [];
  WR.listeners.forEach(([t, ev, fn, opts]) => t.removeEventListener(ev, fn, opts)); WR.listeners = [];
}

// Every second: the timer, the 5-minute warning, time up, and the lock
function wsTick() {
  const el = $('wrTimer');
  if (wsActive()) {
    const s = WR.session;
    if (s.deadlineAt) {
      const left = Date.parse(s.deadlineAt) - serverNow();
      if (el) { el.textContent = vcClock(Math.max(0, left)) + ' left'; el.classList.toggle('low', left < 5 * 60000); }
      if (left < 5 * 60000 && left > 0 && !WR.warned) { WR.warned = true; writerBanner('5 minutes left.', 'warn'); }
      if (left <= 0 && !WR.timeUpShown) { WR.timeUpShown = true; writerFlush({ final: true }).then(wsBeat); writerBanner('Time’s up.', 'warn'); }
    } else if (el) {
      el.textContent = vcClock(serverNow() - Date.parse(s.startedAt));
    }
    // "Away 2m 14s": from when this page locked, or the server's pause if it began earlier
    const p = $('wrAwayTime');
    if (p) {
      const since = Math.min(WR.awaySince || Date.now(), WR.session.pause ? Date.parse(WR.session.pause.from) - WR.serverOffset : Infinity);
      p.textContent = vcDur(Date.now() - since);
    }
  }
  writerApplyLock();
}

// The page checks the extension now and then; if it vanishes mid-session
// (turned off), the page records it and, in locked mode, pauses.
async function wsCheckExtension() {
  if (!window.VisorExt || !wsActive() || WR.embed) return;
  const p = await VisorExt.ping();
  const was = WR.extPresent;
  wsNoteExt(p);
  if (was && !WR.extPresent) { wsNoteEvent('ext-missing', { detail: 'turned-off' }); writerRefresh(); wsBeat(); }
  if (!was && WR.extPresent) { wsNoteEvent('ext-back'); writerRefresh(); wsBeat(); }
  wsRearmExtension(p);
}
