// Writing sessions: when a student may write, and the record of what happened
// while they did.
//
// A session belongs to one student document. Every surface writing to it (the
// Visor tab, the extension's side panel) sends a beat every 10 seconds and on
// every focus change. From those beats the server decides, on its own clock:
//   • pauses: no surface focused for more than max(pauseGraceSec, 2) seconds.
//     The 2 seconds let the student move between the tab and the side panel
//     without a pause being recorded. The editor locks instantly on its own;
//     this is only the record.
//   • timeout: no beat for 3 minutes ends the session.
//   • time limit: deadlineAt passed (time limit × accommodation, minus time
//     already used in earlier sessions on this assignment).
//   • window: the assignment's session window closed.
//   • research: while the side panel holds the editing lease, time on other
//     Chrome tabs counts as research, not time away (unless the page is
//     blocked, or Chrome itself lost focus).
//
// Everything here works on plain objects and a `now` in milliseconds, so the
// rules can be tested without a server. server.js SECTION 12 stores the
// results ("session" records) and wires the routes.

const crypto = require('crypto');

const C = {
  HANDOFF_GRACE_SEC: 2,          // minimum grace: tab ↔ panel handoff
  TAKEOVER_STALE_MS: 90 * 1000,  // starting a session ends one this quiet first
  TIMEOUT_MS: 3 * 60 * 1000,     // no beat this long ends the session
  SURFACE_STALE_MS: 30 * 1000,   // a surface not heard from this long isn't "focused"
  WARNING_MS: 5 * 60 * 1000,     // "5 minutes left"
  EXT_ACK_MS: 30 * 1000,         // the extension must have confirmed within this
  EXT_SILENT_MS: 150 * 1000,     // a locked session's extension reports every minute
  MISMATCH_MS: 8 * 1000,         // how long the page and the extension may disagree
  EVENTS_MAX: 5000,
  RESEARCH_SPANS_MAX: 500,
  PANEL_HANDOFF_MS: 15 * 1000     // the tab handed the lease to the side panel: present while it loads
};

// Events the editor may report itself (the rest the server records).
// assistant-ext: another extension's writing tool on the essay page (detail: its name)
const CLIENT_EVENTS = ['second-screen', 'paste-blocked', 'resync', 'offline', 'online', 'fullscreen-exit', 'fullscreen-enter', 'ext-missing', 'ext-back', 'lock-violation', 'ai-site', 'time-up', 'source-edit', 'assistant-ext'];
const PAUSE_REASONS = ['left-tab', 'left-window', 'exit-fullscreen', 'offline', 'teacher', 'ext-missing', 'blocked-site'];
// Where the extension sees the student, reported by itself and not through the
// page. Another app leaves Visor on screen; on another desktop it's hidden.
const PLACES = ['visor', 'research', 'other-tab', 'browser-ui', 'other-window', 'other-app', 'other-desktop', 'minimized'];
const isElsewhere = where => !!where && where !== 'visor' && where !== 'research';

class SessionError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}

const iso = ms => new Date(ms).toISOString();
const ms = v => (v == null ? null : typeof v === 'number' ? v : Date.parse(v));

function addEvent(s, ev) {
  s.events = s.events || [];
  if (s.events.length < C.EVENTS_MAX) s.events.push(ev);
}

// ---- starting ----

// The server doesn't know the student's time zone, so a time in a message goes
// out marked, and the page writes it in local time (localWhen in app.js)
const fmtWhen = t => `{{when:${iso(t)}}}`;

// Is `now` inside the assignment's session window? Returns a message if not.
function windowProblem(w, now) {
  const a = ms(w?.windowStart), b = ms(w?.windowEnd);
  if (a && now < a) return `This writing session opens ${fmtWhen(a)}.`;
  if (b && now >= b) return `The writing window closed ${fmtWhen(b)}.`;
  return null;
}

// Time a student has already spent in sessions on this document. A teacher's
// pause doesn't count: the clock stops for it.
function usedMs(sessions, exceptId) {
  return sessions.filter(s => s.id !== exceptId && s.startedAt).reduce((sum, s) => {
    const end = ms(s.endedAt) || ms(s.lastBeat) || ms(s.startedAt);
    const paused = (s.pauses || []).filter(p => p.reason === 'teacher').reduce((a, p) => a + Math.max(0, Math.min(ms(p.to) || end, end) - ms(p.from)), 0);
    return sum + Math.max(0, end - ms(s.startedAt) - paused);
  }, 0);
}

// How far past the session window a student's extra time carries them
const windowExtra = ({ timeLimitMin, multiplier = 1 }) => (timeLimitMin ? Math.max(0, timeLimitMin * 60 * 1000 * ((multiplier || 1) - 1)) : 0);

// When this session must end: time limit × accommodation, plus any time the
// teacher added, minus what earlier sessions used. Null without a limit. A
// session window ends it sooner, except that extra time carries past the window.
function computeDeadline({ timeLimitMin, multiplier = 1, used = 0, extraMs = 0, windowEnd, now }) {
  if (!timeLimitMin) return null;
  const total = timeLimitMin * 60 * 1000 * (multiplier || 1) + (extraMs || 0);
  const we = ms(windowEnd);
  const end = now + total - used;
  return iso(we ? Math.min(end, we + windowExtra({ timeLimitMin, multiplier })) : end);
}

// The checks in order (Section 7.1). Each failure is a message the editor
// shows as-is. `active` is the doc's current non-ended session, if any.
function checkStart({ doc, assignment, userId, active, extAck, body = {}, now }) {
  const w = assignment.writing || {};
  // 1. the student's own document, not submitted
  if (!doc || doc.studentId !== userId) throw new SessionError(403, 'This isn’t your document.');
  if (doc.status === 'submitted') throw new SessionError(409, 'You’ve submitted this. Unsubmit it if you need to keep writing.');
  if (doc.status === 'returned' && !doc.reopened) throw new SessionError(409, 'Your teacher returned this without reopening it for more writing.');
  // 2. published, inside the window
  if (!assignment.publishedAt) throw new SessionError(403, 'This assignment isn’t published.');
  const win = windowProblem(w, now);
  if (win) throw new SessionError(403, win);
  // 3. another active session: stale ones time out; a live one is taken over
  let takeover = null;
  if (active && active.state !== 'ended') {
    if (now - ms(active.lastBeat || active.startedAt) > C.TAKEOVER_STALE_MS) takeover = { end: 'timeout' };
    else takeover = { reuse: true };
  }
  // 4. the extension, when required
  if (w.mode === 'locked' || w.requireExtension) {
    const fresh = extAck && extAck.userId === userId && now - ms(extAck.at) <= C.EXT_ACK_MS;
    if (!body.extPresent || !fresh) throw new SessionError(409, w.mode === 'locked' ? 'Locked sessions need the Visor extension. Connect it, then try again.' : 'This assignment needs the Visor extension. Connect it, then try again.');
    // The lockdown redirects pages, which Chrome only lets an extension do on
    // sites it may see, so a locked session needs that permission either way.
    if (w.mode === 'locked' && extAck.hasHostPermission === false) throw new SessionError(409, 'Locked sessions need the Visor extension to see the sites you visit (for research and the allowed-sites list). Allow it, then try again.');
  }
  if (w.mode === 'locked' && body.surf !== 'panel' && body.fullscreen === false && !takeover?.reuse) {
    // The page asks for fullscreen on the Start click; if the browser refused, say so.
    throw new SessionError(409, 'Locked sessions run in full screen. Allow full screen, then try again.');
  }
  return { takeover };
}

// Why a submitted essay can't be unsubmitted right now (null if it can). It stays
// open until the due date or the teacher's review. Past that, or with no way left
// to write and hand it in again, taking it back would only strand it.
function unsubmitProblem({ doc, assignment, timeLeftMs, now }) {
  if (doc.status !== 'submitted') return 'This isn’t submitted.';
  if (doc.submittedBy === 'teacher') return 'Your teacher ended this session and submitted it, so it can’t be unsubmitted.';
  if (doc.feedback && ms(doc.feedback.at) >= ms(doc.submittedAt)) return 'Your teacher has reviewed this, so it can’t be unsubmitted.';
  if (ms(assignment.dueAt) != null && now >= ms(assignment.dueAt)) return 'The due date has passed, so this can’t be unsubmitted.';
  if (!assignment.publishedAt) return 'This assignment isn’t published.';
  const win = windowProblem(assignment.writing, now);
  if (win) return win;
  if (timeLeftMs != null && timeLeftMs <= 5000) return 'You’ve used all of your time for this assignment, so this can’t be unsubmitted.';
  return null;
}

function newSession({ doc, assignment, userId, body = {}, deadlineAt, windowExtraMs = 0, extAck, now }) {
  const s = {
    id: crypto.randomUUID(), docId: doc.id, assignmentId: doc.assignmentId, classId: doc.classId, studentId: userId,
    startedAt: iso(now), endedAt: null, endReason: null, state: 'active',
    mode: assignment.writing?.mode || 'open', deadlineAt: deadlineAt || null, windowExtraMs,
    pauseGraceSec: Number(assignment.writing?.pauseGraceSec) || 0, requireExtension: !!assignment.writing?.requireExtension,
    extension: { present: !!body.extPresent, version: String(body.extVersion || extAck?.version || '').slice(0, 20) || null, lockActive: false, hasHostPermission: extAck?.hasHostPermission ?? null },
    fullscreen: body.fullscreen !== false,
    // May a locked session switch to the side panel? (Open sessions always may.)
    panelResearch: assignment.writing?.mode !== 'locked' || assignment.writing?.panelBrowsing !== false,
    events: [], pauses: [], lastBeat: iso(now), surfaces: {},
    opsFrom: doc.seq + 1, opsTo: doc.seq,
    away: null, warned: false, teacherPaused: false, messages: []
  };
  addEvent(s, { t: now, type: 'start', surf: body.surf || 'tab' });
  if (body.surfaceId) s.surfaces[body.surfaceId] = { kind: body.surf === 'panel' ? 'panel' : 'tab', focused: true, visible: true, fullscreen: body.fullscreen !== false, lastBeat: iso(now) };
  if ((assignment.writing?.researchTracking) && extAck && extAck.hasHostPermission === false) addEvent(s, { t: now, type: 'ext-missing', detail: 'no-permission' });
  return s;
}

// ---- beats, focus and pauses ----

const graceMs = s => Math.max(Number(s.pauseGraceSec) || 0, C.HANDOFF_GRACE_SEC) * 1000;
const openPause = s => (s.pauses || []).find(p => p.to == null) || null;
// Sessions started before the setting existed have no panelResearch: allowed
const panelAllowed = s => s.mode !== 'locked' || s.panelResearch !== false;

// Does this surface hold the editing lease? A lease handed to the side panel
// belongs to every copy of it (Chrome can give each tab its own).
function holdsLease(lease, sessionId, surfaceId, surf) {
  return !!lease && lease.sessionId === sessionId && (lease.surfaceId === surfaceId || (lease.surf === 'panel' && surf === 'panel'));
}

// The side panel holds the lease and the student is on another Chrome tab
// that isn't blocked: researching, not away. The panel's page learns this
// from the extension (browser: { focused, blocked }).
const researchPresence = beat => !!(beat.holdsLease && beat.browser && beat.browser.focused === true && beat.browser.blocked !== true);

// Why the student isn't writing, from the beat that says so.
function reasonFor(beat, mode, s = {}) {
  if (beat.online === false) return 'offline';
  if (beat.surf === 'panel') {
    if (mode === 'locked' && !panelAllowed(s)) return 'exit-fullscreen';
    if (beat.browser?.blocked) return 'blocked-site';
    return 'left-window';
  }
  if (mode === 'locked' && (beat.extPresent !== true || s.extension?.silent)) return 'ext-missing';
  if (beat.visible === false) return 'left-tab';
  if (mode === 'locked' && beat.fullscreen !== true) return 'exit-fullscreen';
  return 'left-window';
}

// Does this surface count as focused? Locked mode: the tab out of full screen
// doesn't, and nothing counts while the extension is missing. The side panel
// counts while it has focus, or while the student researches on another tab;
// in a locked session that may not switch to it, it never counts.
function effectiveFocus(beat, mode, s = {}) {
  if (beat.surf === 'panel') {
    if (mode === 'locked' && !panelAllowed(s)) return false;
    if (beat.visible === false) return false;
    if (beat.focused) return true;
    return researchPresence(beat);
  }
  if (!beat.focused || beat.visible === false) return false;
  // Locked: every one of these has to be stated, and only the copy that's writing counts
  if (mode === 'locked' && (beat.extPresent !== true || beat.fullscreen !== true || beat.holdsLease === false)) return false;
  return true;
}

// Research time: s.research = { since } while it lasts, then a span in
// s.researchSpans. A new span that starts right where the last one ended
// (one copy of the panel handing over to another) continues it.
function openResearch(s, now) {
  if (s.research) return;
  const spans = s.researchSpans || [];
  const last = spans[spans.length - 1];
  if (last && now - ms(last.to) <= C.HANDOFF_GRACE_SEC * 1000) { spans.pop(); s.research = { since: ms(last.from) }; }
  else s.research = { since: now };
}
function closeResearch(s, at) {
  if (!s.research) return;
  s.researchSpans = s.researchSpans || [];
  if (s.researchSpans.length < C.RESEARCH_SPANS_MAX) s.researchSpans.push({ from: iso(s.research.since), to: iso(Math.max(s.research.since, at)) });
  s.research = null;
}

function anyFocused(s, now) {
  if (s.handoffUntil && now < s.handoffUntil) return true;
  // The extension's own word beats the page's in a locked session
  if (s.mode === 'locked' && (s.extension?.silent || isElsewhere(s.extension?.where))) return false;
  return Object.values(s.surfaces || {}).some(x => x.focused && now - ms(x.lastBeat) <= C.SURFACE_STALE_MS);
}

// The editing lease moved to a surface of kind `surf`. To the side panel from
// the tab (handoff): present for a moment while the panel loads. Away from the
// panel: its research time ends and its copies stop counting as present.
function leaseMoved(s, surf, now, { handoff = false } = {}) {
  if (surf === 'panel') { if (handoff) s.handoffUntil = now + C.PANEL_HANDOFF_MS; return s; }
  s.handoffUntil = null;
  closeResearch(s, now);
  for (const x of Object.values(s.surfaces || {})) if (x.kind === 'panel') x.focused = false;
  return s;
}

// Re-evaluate pauses at `now`. Called on every beat and every read.
// notBefore: the beating surface was still focused then, so time away can't
// start earlier (a copy of the side panel that went quiet would backdate it).
function evaluateFocus(s, now, { notBefore = 0 } = {}) {
  if (s.state === 'ended') return s;
  if (s.teacherPaused) { s.state = 'paused'; return s; }
  const focused = anyFocused(s, now);
  const open = openPause(s);
  if (focused) {
    if (open) {
      open.to = iso(now);
      addEvent(s, { t: now, type: 'resume', reason: open.reason, awayMs: now - ms(open.from) });
    } else if (s.away && now - s.away.since > graceMs(s)) {
      // Back before the server noticed (no beat while away): record it now.
      closeResearch(s, s.away.since);
      s.pauses.push({ from: iso(s.away.since), to: iso(now), reason: s.away.reason });
      addEvent(s, { t: s.away.since, type: 'pause', reason: s.away.reason });
      addEvent(s, { t: now, type: 'resume', reason: s.away.reason, awayMs: now - s.away.since });
    } else if (s.away) addEvent(s, { t: now, type: 'brief-away', reason: s.away.reason, awayMs: now - s.away.since }); // too short to pause
    s.away = null;
  } else {
    if (!s.away) {
      // Surfaces that stopped beating went away when they were last heard from
      const last = Math.max(0, ...Object.values(s.surfaces || {}).filter(x => x.focused).map(x => ms(x.lastBeat)));
      s.away = { since: last && last < now ? Math.max(last, notBefore) : now, reason: s.awayReason || 'left-window' };
    }
    if (!open && now - s.away.since > graceMs(s)) {
      closeResearch(s, s.away.since);
      s.pauses.push({ from: iso(s.away.since), to: null, reason: s.away.reason });
      addEvent(s, { t: s.away.since, type: 'pause', reason: s.away.reason });
    }
  }
  s.state = openPause(s) ? 'paused' : 'active';
  return s;
}

// A beat from one surface: { surfaceId, surf, focused, visible, fullscreen,
// extPresent, extLock, online, events?, offlinePause? }. The route adds
// holdsLease, and the side panel's browser: { focused, blocked }.
// The extension reports on its own every minute. If that stops, the page's word
// that it's there counts for nothing.
function noteExtension(s, now) {
  if (s.mode !== 'locked' || s.state === 'ended') return;
  const silent = now - ms(s.extension?.lastBeat || s.startedAt) > C.EXT_SILENT_MS;
  if (silent === !!s.extension?.silent) return;
  s.extension = { ...s.extension, silent };
  if (silent) s.awayReason = 'ext-missing';
  addEvent(s, { t: now, type: silent ? 'ext-missing' : 'ext-back', detail: silent ? 'stopped reporting' : undefined });
}

// What the extension sees, from its own part of the Visor page: where the student
// is, and whether more than one screen is attached. Sent to the server directly.
function applyPresence(s, p, now) {
  if (s.state === 'ended') return s;
  const where = PLACES.includes(p?.where) ? p.where : s.extension?.where || 'visor';
  const before = s.extension || {};
  s.extension = { ...before, where, whereAt: iso(now), extended: !!p?.extended, devtools: !!p?.devtools };
  if (where !== before.where && isElsewhere(where)) addEvent(s, { t: now, type: 'ext-where', detail: where });
  if (p?.extended && !before.extended) addEvent(s, { t: now, type: 'second-screen' });
  if (p?.devtools && !before.devtools) addEvent(s, { t: now, type: 'devtools' });
  if (isElsewhere(where) && s.mode === 'locked') s.awayReason = where === 'other-tab' || where === 'browser-ui' ? 'left-tab' : 'left-window';
  const open = openPause(s);
  if (open && isElsewhere(where) && open.reason !== 'teacher') open.where = where;
  evaluateFocus(s, now);
  return s;
}

function applyBeat(s, beat, now) {
  if (s.state === 'ended') return s;
  noteExtension(s, now);
  const mode = s.mode;
  const surfaceId = String(beat.surfaceId || 'tab').slice(0, 60);
  const prev = s.surfaces[surfaceId] || {};
  const kind = beat.surf === 'panel' ? 'panel' : 'tab';
  const focused = effectiveFocus({ ...beat, surf: kind }, mode, s);
  // The page says it's focused while the extension sees them elsewhere: one is wrong
  if (mode === 'locked' && focused && isElsewhere(s.extension?.where) && now - ms(s.extension.whereAt) > C.MISMATCH_MS && !s.extension.mismatch) {
    s.extension = { ...s.extension, mismatch: true };
    addEvent(s, { t: now, type: 'page-mismatch', detail: s.extension.where });
  }
  s.surfaces[surfaceId] = { kind, focused, visible: beat.visible !== false, fullscreen: beat.fullscreen !== false, lastBeat: iso(now) };
  s.lastBeat = iso(now);
  // The panel has loaded after a handoff; or the tab writes again, so the
  // side panel's research (if any) is over
  if (kind === 'panel' && focused) s.handoffUntil = null;
  if (kind === 'tab' && beat.holdsLease) { s.handoffUntil = null; closeResearch(s, now); }
  // While the side panel holds the lease, the tab is out of full screen (or
  // hidden) by design: why the student is away is the panel's to say
  const panelSays = kind === 'tab' && beat.panelLease && panelAllowed(s);
  if (!focused && !panelSays) {
    s.awayReason = reasonFor({ ...beat, surf: kind }, mode, s);
    // Switching tabs reports "window" (blur) a moment before "tab" (hidden):
    // the more specific reason wins for this time away
    if (s.away && s.away.reason === 'left-window' && s.awayReason !== 'left-window') {
      s.away.reason = s.awayReason;
      const open = openPause(s);
      if (open && open.reason === 'left-window' && Date.parse(open.from) === s.away.since) open.reason = s.awayReason;
    }
  }

  // Full screen (locked mode, the tab)
  if (mode === 'locked' && kind === 'tab' && typeof beat.fullscreen === 'boolean' && prev.fullscreen !== undefined && prev.fullscreen !== beat.fullscreen) {
    addEvent(s, { t: now, type: beat.fullscreen ? 'fullscreen-enter' : 'fullscreen-exit' });
  }
  if (kind === 'tab' && typeof beat.fullscreen === 'boolean') s.fullscreen = beat.fullscreen;
  // The extension (the page's own check; the extension's beats add lockActive)
  if (typeof beat.extPresent === 'boolean' && beat.extPresent !== s.extension.present) {
    if (s.mode === 'locked' || s.requireExtension) addEvent(s, { t: now, type: beat.extPresent ? 'ext-back' : 'ext-missing', detail: beat.extPresent ? undefined : 'turned-off' });
    s.extension.present = beat.extPresent;
  }
  // Events the editor recorded (pastes it blocked, resyncs, going offline…)
  for (const ev of Array.isArray(beat.events) ? beat.events.slice(0, 50) : []) {
    if (!ev || !CLIENT_EVENTS.includes(ev.type)) continue;
    const clean = { t: Number.isFinite(ev.t) ? Math.min(now, Math.round(ev.t)) : now, type: ev.type };
    for (const k of ['len', 'hash', 'detail', 'url', 'reason']) if (ev[k] != null) clean[k] = typeof ev[k] === 'number' ? ev[k] : String(ev[k]).slice(0, 300);
    addEvent(s, clean);
  }
  // Time spent offline, reported once the editor reconnected
  const op = beat.offlinePause;
  if (op && Number.isFinite(op.from) && Number.isFinite(op.to) && op.to > op.from && now - op.from < 24 * 3600 * 1000) {
    const from = Math.max(op.from, ms(s.startedAt)), to = Math.min(op.to, now);
    // While the page was offline its beats stopped, so the server may already
    // have opened a pause for that time: that pause is the offline time, not a second one
    const overlap = (s.pauses || []).filter(p => p.reason !== 'teacher' && ms(p.from) < to + graceMs(s) && (p.to == null || ms(p.to) > from - graceMs(s)));
    if (overlap.length) {
      for (const p of overlap) p.reason = 'offline';
      if (s.away) s.away.reason = 'offline';
    } else if (to - from > graceMs(s)) {
      // Offline time isn't research time (research starts again below if it goes on)
      if (s.research && s.research.since < to) closeResearch(s, from);
      s.pauses.push({ from: iso(from), to: iso(to), reason: 'offline' });
      addEvent(s, { t: from, type: 'pause', reason: 'offline' });
      addEvent(s, { t: to, type: 'resume', reason: 'offline', awayMs: to - from });
    }
  }
  evaluateFocus(s, now, { notBefore: prev.focused ? ms(prev.lastBeat) : 0 });
  // Research time: the panel counts only because the student is on another
  // tab. Any other beat from the panel ends it; the tab's beats don't.
  if (kind === 'panel') {
    if (focused && !beat.focused && !s.teacherPaused) openResearch(s, now);
    else closeResearch(s, now);
  }
  return s;
}

// ---- ending ----

function endSession(s, reason, now, { at } = {}) {
  if (s.state === 'ended') return s;
  const end = at != null ? at : now;
  const open = openPause(s);
  if (open) open.to = iso(Math.max(ms(open.from), end));
  if (s.away && !open && end - s.away.since > graceMs(s)) s.pauses.push({ from: iso(s.away.since), to: iso(end), reason: s.away.reason });
  s.away = null;
  closeResearch(s, end);
  s.state = 'ended'; s.endedAt = iso(end); s.endReason = reason; s.teacherPaused = false;
  addEvent(s, { t: end, type: 'end', reason });
  return s;
}

// Lazy checks on any read: timeout, time limit, window, and the 5-minute
// warning. Returns the reason if it ended the session now.
function sweep(s, now, { windowEnd } = {}) {
  if (s.state === 'ended') return null;
  noteExtension(s, now);
  const last = ms(s.lastBeat || s.startedAt);
  if (now - last > C.TIMEOUT_MS) { endSession(s, 'timeout', now, { at: last }); return 'timeout'; }
  // A teacher's pause stops the clock: nothing runs out until they resume
  if (s.teacherPaused) { evaluateFocus(s, now); return null; }
  const dl = ms(s.deadlineAt);
  if (dl && now >= dl) { addEvent(s, { t: dl, type: 'time-up' }); endSession(s, 'time-limit', now, { at: dl }); return 'time-limit'; }
  const we = ms(windowEnd) ? ms(windowEnd) + (s.windowExtraMs || 0) : 0;
  if (we && now >= we) { endSession(s, 'window-closed', now, { at: we }); return 'window-closed'; }
  if (dl && !s.warned && dl - now <= C.WARNING_MS) { s.warned = true; addEvent(s, { t: now, type: 'time-warning', leftMs: dl - now }); }
  evaluateFocus(s, now);
  return null;
}

// Writing typed in the last moments is still on its way when time runs out (it
// goes out every second or two). The session is over, but those edits are taken
// for a moment longer. Not after a student or a timeout ended it: then nothing
// was cut off.
const FINAL_SAVE_MS = 20000;
const inFinalSave = (s, now) => s.state === 'ended' && ['time-limit', 'window-closed', 'teacher'].includes(s.endReason) && now - ms(s.endedAt) <= FINAL_SAVE_MS;

// ---- the teacher's controls (live board) ----

function teacherPause(s, now) {
  if (s.state === 'ended' || s.teacherPaused) return s;
  const open = openPause(s);
  if (open) { open.to = iso(now); }
  closeResearch(s, now);
  s.teacherPaused = true;
  s.pauses.push({ from: iso(now), to: null, reason: 'teacher' });
  addEvent(s, { t: now, type: 'teacher-pause' });
  s.state = 'paused';
  return s;
}
function teacherResume(s, now) {
  if (s.state === 'ended' || !s.teacherPaused) return s;
  const open = openPause(s);
  if (open) {
    open.to = iso(now);
    // The clock stopped for the pause, so what's left is what was left
    const paused = Math.max(0, now - ms(open.from));
    if (s.deadlineAt) s.deadlineAt = iso(ms(s.deadlineAt) + paused);
    s.windowExtraMs = (s.windowExtraMs || 0) + paused;
  }
  s.teacherPaused = false; s.away = null;
  addEvent(s, { t: now, type: 'teacher-resume' });
  return evaluateFocus(s, now);
}
function addTime(s, minutes, now) {
  const m = Math.max(1, Math.min(240, Math.round(Number(minutes) || 0)));
  if (s.state === 'ended') return s;
  if (s.deadlineAt) { s.deadlineAt = iso(ms(s.deadlineAt) + m * 60000); s.warned = false; }
  s.windowExtraMs = (s.windowExtraMs || 0) + m * 60000; // and it carries past the session window
  addEvent(s, { t: now, type: 'time-added', minutes: m });
  return s;
}
function teacherMessage(s, text, now) {
  const msg = { id: crypto.randomUUID().slice(0, 8), text: String(text || '').trim().replace(/\s+/g, ' ').slice(0, 200), at: iso(now) };
  if (!msg.text) throw new SessionError(400, 'Type a message first');
  s.messages = [...(s.messages || []), msg].slice(-10);
  addEvent(s, { t: now, type: 'teacher-message', text: msg.text });
  return msg;
}

// ---- summaries ----

const pauseMs = (p, now) => Math.max(0, (ms(p.to) || now) - ms(p.from));
// Time researching with the side panel open (never counted as time away)
const researchMsOf = (s, now) => (s.researchSpans || []).reduce((a, r) => a + Math.max(0, ms(r.to) - ms(r.from)), 0)
  + (s.research ? Math.max(0, (ms(s.endedAt) || now) - s.research.since) : 0);

// Away time and counts across a document's sessions, for doc.stats
function docSessionStats(sessions, now) {
  let awayMs = 0, pauses = 0, wallMs = 0, researchMs = 0;
  for (const s of sessions) {
    for (const p of s.pauses || []) { if (p.reason === 'teacher') continue; pauses++; awayMs += pauseMs(p, now); }
    wallMs += Math.max(0, (ms(s.endedAt) || ms(s.lastBeat) || now) - ms(s.startedAt));
    researchMs += researchMsOf(s, now);
  }
  return { sessions: sessions.length, pauses, awayMs, sessionMs: wallMs, researchMs };
}

// What the editor needs from a beat or start reply
function clientView(s, now) {
  const open = openPause(s);
  return {
    id: s.id, state: s.state, endReason: s.endReason, startedAt: s.startedAt, endedAt: s.endedAt, deadlineAt: s.deadlineAt, mode: s.mode,
    pause: open ? { reason: open.reason, from: open.from, ms: pauseMs(open, now) } : null,
    awayMs: (s.pauses || []).filter(p => p.reason !== 'teacher').reduce((a, p) => a + pauseMs(p, now), 0),
    pauseCount: (s.pauses || []).filter(p => p.reason !== 'teacher').length,
    panelResearch: panelAllowed(s),
    teacherMessage: (s.messages || []).slice(-1)[0] || null,
    serverNow: iso(now)
  };
}

module.exports = {
  C, CLIENT_EVENTS, PAUSE_REASONS, PLACES, SessionError, applyPresence, windowProblem, usedMs, computeDeadline, windowExtra, checkStart, unsubmitProblem, newSession,
  applyBeat, evaluateFocus, endSession, sweep, inFinalSave, teacherPause, teacherResume, addTime, teacherMessage,
  docSessionStats, researchMsOf, clientView, openPause, addEvent, panelAllowed, holdsLease, leaseMoved
};
