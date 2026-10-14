/* Visor Writer — the writing session around the editor (writer.js).
   Starts, takes over, ends and submits sessions; sends a beat every 10
   seconds and on every focus change; tracks whether this surface may write;
   runs the timer; asks for full screen in locked mode; talks to the Visor
   extension through ext.js when it's there.

   Focus rule (Section 6.4): a surface is focused when the page is visible AND
   the document has focus. The editor accepts input only while its surface is
   focused, holds the lease, and the session is active.

   Side-panel research: once the side panel holds the lease, time on other
   Chrome tabs is research, not time away. The panel's parent page tells this
   page whether Chrome has focus and whether it shows Visor's blocked page
   (PANEL_CONTEXT, kept in WR.panelCtx). */

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
  seenMessage: null, unloadWarn: false,
  panelCtx: null,         // side panel: { focused, blocked } from the extension (PANEL_CONTEXT)
  researchSent: undefined, // the tab: the research mode last sent to the extension
  imageToken: null,       // lets <img> load this essay's pictures (GET /api/write/:id, 12 h)
  imageIds: new Set()     // pictures this essay may show: ids seen in it, plus uploads this visit
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
// A lease handed to the side panel belongs to every copy of it (Chrome can give each tab its own)
const isLeaseHolder = () => !!(WR.lease && WR.session && WR.lease.sessionId === WR.session.id && (WR.lease.surfaceId === WR.surfaceId || (WR.lease.surf === 'panel' && WR.embed)));
// May this session write in the side panel? Locked ones only if the teacher allows it
// May this session use the side panel? The running session's own answer (set
// when it started) wins over the assignment's current setting.
const wsPanelAllowed = () => {
  if (wsActive() && typeof WR.session.panelResearch === 'boolean') return WR.session.panelResearch;
  const w = WR.data.assignment.writing; return w.mode !== 'locked' || w.panelBrowsing !== false;
};

// fetch with the session token (and the extension token inside the side panel).
// raw: a Blob sent as it is (a picture), with its own type, instead of JSON.
async function wapi(path, { method = 'GET', body, raw, headers: extra, keepalive = false } = {}) {
  const headers = { ...(extra || {}) };
  if (raw) headers['Content-Type'] = raw.type || 'application/octet-stream';
  else if (body) headers['Content-Type'] = 'application/json';
  if (WR.token) headers['X-Visor-Session'] = WR.token;
  if (WR.extToken) headers['X-Visor-Token'] = WR.extToken;
  let r;
  try {
    r = await fetch(path, { method, headers, body: raw || (body ? JSON.stringify(body) : undefined), credentials: 'same-origin', keepalive });
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
  if (!f.focused) {
    // The side panel, while the student researches on another tab: no pause
    // card; clicking back into the editor is enough to type
    if (WR.embed && wsPanelAllowed()) {
      if (WR.panelCtx?.focused && !WR.panelCtx.blocked) return null;
      if (WR.panelCtx?.blocked) return 'blocked-site';
    }
    return 'left-window';
  }
  if (mode === 'locked' && !WR.embed && !f.fullscreen) return 'exit-fullscreen';
  return null;
}

/* ---- beats ---- */
// A hidden copy of the side panel (another tab's, while Chrome has focus)
// doesn't report: the copy on screen does. Once Chrome loses focus it
// reports again, so the time away is recorded.
const wsQuietCopy = () => WR.embed && document.hidden && WR.panelCtx?.focused !== false;
let beatInFlight = false, beatAgain = false;
async function wsBeat() {
  if (!wsActive() || !WR.token || wsQuietCopy()) return;
  if (beatInFlight) { beatAgain = true; return; }
  beatInFlight = true;
  const f = surfaceFocus();
  const events = WR.events.splice(0);
  const offlinePause = WR.offlinePause; WR.offlinePause = null;
  try {
    const r = await wapi(`/api/write/${WR.doc.id}/beat`, { method: 'POST', body: {
      surfaceId: WR.surfaceId, surf: WR.surf, ...f, online: !WR.offline, extPresent: WR.extKnown ? WR.extPresent : undefined, extLock: WR.extInfo?.lockActive,
      events, offlinePause, seq: WR.seq,
      // Every copy of the side panel may hold the lease, so each keeps up with the others' writing
      wantText: WR.embed ? true : !isLeaseHolder(),
      browser: WR.embed && WR.panelCtx ? WR.panelCtx : undefined
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
  const wasPanel = WR.lease?.surf === 'panel';
  WR.session = { ...WR.session, ...r };
  WR.lease = r.lease;
  if (r.teacherMessage && r.teacherMessage.id !== wsSeenMessage()) { wsSeenMessage(r.teacherMessage.id); writerBanner(`Message from your teacher: ${r.teacherMessage.text}`, 'teacher'); }
  if (r.ended) return wsSessionEnded(r);
  // Someone else (the side panel, another tab) took the lease: become a mirror
  if (wasHolder && !isLeaseHolder()) { writerFlush(); }
  if (!isLeaseHolder() && r.text != null) writerLoadServerText({ text: r.text, formats: r.formats, seq: r.seq });
  // Just became a mirror: this beat didn't ask for the text, so ask again now
  else if (!isLeaseHolder() && r.seq !== WR.seq) beatAgain = true;
  // Another copy of the side panel wrote: catch up, but never go back to older text
  else if (WR.embed && isLeaseHolder() && r.text != null && r.seq > WR.seq && !WR.queue.length && !flushing) writerLoadServerText({ text: r.text, formats: r.formats, seq: r.seq });
  wsKeepResearchInStep(wasPanel);
  writerRefresh();
}

// The tab, in a locked session that may use the side panel: the extension's
// research mode (only blocked and AI sites stay blocked) follows the lease.
function wsSendResearch(on) {
  WR.researchSent = on;
  VisorExt.researchMode(WR.doc.id, on).catch(() => {});
}
function wsKeepResearchInStep(wasPanel) {
  if (WR.embed || !window.VisorExt || !WR.extPresent || !wsActive()) return;
  if (WR.data.assignment.writing.mode !== 'locked' || !wsPanelAllowed()) return;
  const inPanel = WR.lease?.surf === 'panel' && WR.lease.sessionId === WR.session.id;
  if (inPanel) {
    if (WR.researchSent !== true) wsSendResearch(true);
    if (!wasPanel && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  } else if (isLeaseHolder() && WR.researchSent !== false) wsSendResearch(false);
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
  return { mode: w.mode, researchTracking: w.researchTracking, allowedSites: w.allowedSites, blockedSites: w.blockedSites, blockAiSites: w.blockAiSites, citationStyle: w.citationStyle,
    // No one-click citing when the assignment has no Works Cited (students write their own)
    oneClickCite: w.oneClickCite !== false && w.worksCited !== 'off', panelBrowsing: w.panelBrowsing !== false,
    // Where the writing is now, so an extension that lost its state (a browser
    // restart) starts in the right mode
    research: !!(WR.session && WR.lease && WR.lease.sessionId === WR.session.id && WR.lease.surf === 'panel'), title: WR.data.assignment.title, origin: location.origin, deadlineAt: WR.session?.deadlineAt || null, startedAt: WR.session?.startedAt || null };
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

// The tab, locked session: write in the side panel and research in other
// tabs (blocked and AI sites stay blocked). The panel opens first, while this
// click still counts as a user gesture.
async function wsResearchMode() {
  const opened = VisorExt.openPanel(WR.doc.id);
  wsSendResearch(true);
  // What's typed here goes first: once the panel holds the lease it would be refused
  await writerFlush();
  try {
    const r = await wapi(`/api/write/${WR.doc.id}/lease`, { method: 'POST', body: { give: 'panel' } });
    WR.lease = r.lease;
  } catch (e) {
    wsSendResearch(false);
    if (e.data?.ended) return wsSessionEnded(e.data);
    toast(e.message, 'err');
    return;
  }
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  writerRefresh();
  wsBeat();
  const r = await opened;
  if (!r || !r.ok) toast('Click the Visor icon in Chrome’s toolbar to open the side panel.', 'err');
}

// Back from the side panel: full screen first (it needs this click's gesture),
// then the lease, then the extension's usual lockdown
async function wsBackToFullscreen() {
  await document.documentElement.requestFullscreen().catch(() => {});
  await wsTakeLease();
  if (isLeaseHolder() && window.VisorExt) wsSendResearch(false);
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
  // lease handoff doesn't strand the last keystrokes. Only a page with edits
  // of its own stores them now: with none, it must not touch the stored copy
  // (another tab's, or writing waiting for Send / Start a session).
  const keep = () => { if (WR.queue.length) writerPersistQueue(true); };
  on(window, 'blur', () => { keep(); changed(); writerFlush(); });
  on(document, 'visibilitychange', () => { keep(); changed(); if (document.visibilityState === 'hidden') writerFlush({ unload: false }); });
  on(document, 'fullscreenchange', changed);
  on(window, 'online', () => { if (WR.offline) { wsBeat(); writerFlush(); } });
  on(window, 'offline', () => { if (wsActive()) wsGoOffline(); });
  on(window, 'beforeunload', e => { if (wsActive() && isLeaseHolder() && WR.data.assignment.writing.mode === 'locked') { e.preventDefault(); e.returnValue = ''; } });
  on(window, 'pagehide', () => writerFlush({ unload: true }));
  // A hidden copy of the side panel doesn't report on the clock
  // (wsBeat keeps a hidden copy of the side panel quiet while Chrome is in use)
  WR.timers.push(setInterval(wsBeat, 10000));
  WR.timers.push(setInterval(wsTick, 1000));
  WR.timers.push(setInterval(() => writerFlush(), WR_FLUSH_MS));
  WR.timers.push(setInterval(wsCheckExtension, 15000));
}
/* ---- other extensions' writing tools on the page ----
   Grammar checkers and AI writing helpers from other extensions show up on
   the page as their own elements (Grammarly's <grammarly-extension>,
   LanguageTool's <lt-toolbar>…). On an assignment that blocks AI sites, each
   one seen during a session is recorded once ('assistant-ext', with its name:
   the live board and the notes show it) and the student is asked to turn it
   off. Only names are matched, never content; a tool that isn't on this list
   (a password manager, a translator) is never reported. */
const WS_TOOLS = [
  ['Grammarly', /^grammarly(-|$)/i, /grammarly/i],
  ['LanguageTool', /^lt-(toolbar|highlighter|mirror|span|div|card)/i, /languagetool/i],
  ['QuillBot', /^quillbot/i, /^quillbot/i],
  ['Wordtune', /^wordtune/i, /^wordtune/i],
  ['Sider', /^sider-/i, /^sider[-_]/i],
  ['Monica', /^monica-/i, /^monica[-_]/i],
  ['MaxAI', /^(maxai|use-chat-gpt-ai)/i, /^(maxai|use_chat_gpt_ai)/i],
  ['Merlin', /^merlin-/i, /^merlin[-_]/i],
  ['HARPA AI', /^harpa-/i, /^harpa[-_]/i],
  ['Compose AI', /^compose-ai/i, /^compose-?ai/i],
  ['Text Blaze', /^text-?blaze/i, /^text-?blaze/i]
];
function wsToolName(el) {
  if (!el || el.nodeType !== 1) return null;
  const tag = el.tagName, id = el.id || '';
  if (el.hasAttribute('data-grammarly-shadow-root')) return 'Grammarly';
  for (const [name, tagRe, idRe] of WS_TOOLS) if ((tag.includes('-') && tagRe.test(tag)) || (id && idRe.test(id))) return name;
  return null;
}
function wsToolSeen(name) {
  if (!name || !WR.data || WR.data.assignment.writing.blockAiSites === false || !wsActive()) return;
  if (WR.toolsSeen.has(`${WR.session.id}|${name}`)) return;
  WR.toolsSeen.add(`${WR.session.id}|${name}`);
  WR.events.push({ t: Date.now(), type: 'assistant-ext', detail: name });
  // One notice naming every tool seen this session
  const names = [...WR.toolsSeen].filter(k => k.startsWith(`${WR.session.id}|`)).map(k => k.slice(WR.session.id.length + 1));
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are` : `${names[0]} is`;
  writerBanner(`${list} running on this page. Writing tools from other extensions aren’t allowed in this assignment: turn ${names.length > 1 ? 'them' : 'it'} off for this site. Visor notes that ${names.length > 1 ? 'they were' : 'it was'} here.`, 'warn');
}
// Everything already on the page, then whatever is added later
function wsScanTools() {
  for (const el of document.querySelectorAll('[data-grammarly-shadow-root], [id]')) wsToolSeen(wsToolName(el));
  const walk = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT, { acceptNode: n => (n.tagName.includes('-') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) });
  while (walk.nextNode()) wsToolSeen(wsToolName(walk.currentNode));
}
function wsWatchTools() {
  WR.toolsObserver?.disconnect();
  if (!window.MutationObserver) return;
  WR.toolsObserver = new MutationObserver(list => {
    if (!wsActive()) return;
    for (const m of list) for (const n of m.addedNodes) { if (n.nodeType === 1) wsToolSeen(wsToolName(n)); }
  });
  WR.toolsObserver.observe(document.documentElement, { childList: true, subtree: true });
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
