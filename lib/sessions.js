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
  EVENTS_MAX: 5000
};

// Events the editor may report itself (the rest the server records).
const CLIENT_EVENTS = ['paste-blocked', 'resync', 'offline', 'online', 'fullscreen-exit', 'fullscreen-enter', 'ext-missing', 'ext-back', 'lock-violation', 'ai-site', 'time-up', 'source-edit'];
const PAUSE_REASONS = ['left-tab', 'left-window', 'exit-fullscreen', 'offline', 'teacher', 'ext-missing'];

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

const fmtWhen = t => new Date(t).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// Is `now` inside the assignment's session window? Returns a message if not.
function windowProblem(w, now) {
  const a = ms(w?.windowStart), b = ms(w?.windowEnd);
  if (a && now < a) return `This writing session opens ${fmtWhen(a)}.`;
  if (b && now >= b) return `The writing window closed ${fmtWhen(b)}.`;
  return null;
}

// Wall-clock time a student has already spent in sessions on this document.
function usedMs(sessions, exceptId) {
  return sessions.filter(s => s.id !== exceptId && s.startedAt).reduce((sum, s) => {
    const end = ms(s.endedAt) || ms(s.lastBeat) || ms(s.startedAt);
    return sum + Math.max(0, end - ms(s.startedAt));
  }, 0);
}

// When this session must end: time limit × accommodation, plus any time the
// teacher added, minus what earlier sessions used. Null without a limit.
function computeDeadline({ timeLimitMin, multiplier = 1, used = 0, extraMs = 0, now }) {
  if (!timeLimitMin) return null;
  const total = timeLimitMin * 60 * 1000 * (multiplier || 1) + (extraMs || 0);
  return iso(now + total - used);
}

// The checks in order (Section 7.1). Each failure is a message the editor
// shows as-is. `active` is the doc's current non-ended session, if any.
function checkStart({ doc, assignment, userId, active, extAck, body = {}, now }) {
  const w = assignment.writing || {};
  // 1. the student's own document, not submitted
  if (!doc || doc.studentId !== userId) throw new SessionError(403, 'This isn’t your document.');
  if (doc.status === 'submitted') throw new SessionError(409, 'You’ve submitted this. Your teacher can return it if you need to keep writing.');
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

function newSession({ doc, assignment, userId, body = {}, deadlineAt, extAck, now }) {
  const s = {
    id: crypto.randomUUID(), docId: doc.id, assignmentId: doc.assignmentId, classId: doc.classId, studentId: userId,
    startedAt: iso(now), endedAt: null, endReason: null, state: 'active',
    mode: assignment.writing?.mode || 'open', deadlineAt: deadlineAt || null,
    pauseGraceSec: Number(assignment.writing?.pauseGraceSec) || 0, requireExtension: !!assignment.writing?.requireExtension,
    extension: { present: !!body.extPresent, version: String(body.extVersion || extAck?.version || '').slice(0, 20) || null, lockActive: false, hasHostPermission: extAck?.hasHostPermission ?? null },
    fullscreen: body.fullscreen !== false,
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

// Why the student isn't writing, from the beat that says so.
function reasonFor(beat, mode) {
  if (beat.online === false) return 'offline';
  if (mode === 'locked' && beat.extPresent === false) return 'ext-missing';
  if (beat.visible === false) return 'left-tab';
  if (mode === 'locked' && beat.surf !== 'panel' && beat.fullscreen === false) return 'exit-fullscreen';
  return 'left-window';
}

// Does this surface count as focused? Locked mode: the tab out of full screen
// doesn't (unless the panel is the one being used), and nothing counts while
// the extension is missing.
function effectiveFocus(beat, mode) {
  if (!beat.focused || beat.visible === false) return false;
  if (mode === 'locked' && beat.extPresent === false) return false;
  if (mode === 'locked' && beat.surf !== 'panel' && beat.fullscreen === false) return false;
  return true;
}

function anyFocused(s, now) {
  return Object.values(s.surfaces || {}).some(x => x.focused && now - ms(x.lastBeat) <= C.SURFACE_STALE_MS);
}

// Re-evaluate pauses at `now`. Called on every beat and every read.
function evaluateFocus(s, now) {
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
      s.pauses.push({ from: iso(s.away.since), to: iso(now), reason: s.away.reason });
      addEvent(s, { t: s.away.since, type: 'pause', reason: s.away.reason });
      addEvent(s, { t: now, type: 'resume', reason: s.away.reason, awayMs: now - s.away.since });
    }
    s.away = null;
  } else {
    if (!s.away) {
      // Surfaces that stopped beating went away when they were last heard from
      const last = Math.max(0, ...Object.values(s.surfaces || {}).filter(x => x.focused).map(x => ms(x.lastBeat)));
      s.away = { since: last && last < now ? last : now, reason: s.awayReason || 'left-window' };
    }
    if (!open && now - s.away.since > graceMs(s)) {
      s.pauses.push({ from: iso(s.away.since), to: null, reason: s.away.reason });
      addEvent(s, { t: s.away.since, type: 'pause', reason: s.away.reason });
    }
  }
  s.state = openPause(s) ? 'paused' : 'active';
  return s;
}

// A beat from one surface: { surfaceId, surf, focused, visible, fullscreen,
// extPresent, extLock, online, events?, offlinePause? }
function applyBeat(s, beat, now) {
  if (s.state === 'ended') return s;
  const mode = s.mode;
  const surfaceId = String(beat.surfaceId || 'tab').slice(0, 60);
  const prev = s.surfaces[surfaceId] || {};
  const kind = beat.surf === 'panel' ? 'panel' : 'tab';
  const focused = effectiveFocus({ ...beat, surf: kind }, mode);
  s.surfaces[surfaceId] = { kind, focused, visible: beat.visible !== false, fullscreen: beat.fullscreen !== false, lastBeat: iso(now) };
  s.lastBeat = iso(now);
  if (!focused) s.awayReason = reasonFor({ ...beat, surf: kind }, mode);

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
    if (to - from > graceMs(s)) {
      s.pauses.push({ from: iso(from), to: iso(to), reason: 'offline' });
      addEvent(s, { t: from, type: 'pause', reason: 'offline' });
      addEvent(s, { t: to, type: 'resume', reason: 'offline', awayMs: to - from });
    }
  }
  return evaluateFocus(s, now);
}

// ---- ending ----

function endSession(s, reason, now, { at } = {}) {
  if (s.state === 'ended') return s;
  const end = at != null ? at : now;
  const open = openPause(s);
  if (open) open.to = iso(Math.max(ms(open.from), end));
  if (s.away && !open && end - s.away.since > graceMs(s)) s.pauses.push({ from: iso(s.away.since), to: iso(end), reason: s.away.reason });
  s.away = null;
  s.state = 'ended'; s.endedAt = iso(end); s.endReason = reason; s.teacherPaused = false;
  addEvent(s, { t: end, type: 'end', reason });
  return s;
}

// Lazy checks on any read: timeout, time limit, window, and the 5-minute
// warning. Returns the reason if it ended the session now.
function sweep(s, now, { windowEnd } = {}) {
  if (s.state === 'ended') return null;
  const last = ms(s.lastBeat || s.startedAt);
  if (now - last > C.TIMEOUT_MS) { endSession(s, 'timeout', now, { at: last }); return 'timeout'; }
  const dl = ms(s.deadlineAt);
  if (dl && now >= dl) { addEvent(s, { t: dl, type: 'time-up' }); endSession(s, 'time-limit', now, { at: dl }); return 'time-limit'; }
  const we = ms(windowEnd);
  if (we && now >= we) { endSession(s, 'window-closed', now, { at: we }); return 'window-closed'; }
  if (dl && !s.warned && dl - now <= C.WARNING_MS) { s.warned = true; addEvent(s, { t: now, type: 'time-warning', leftMs: dl - now }); }
  evaluateFocus(s, now);
  return null;
}

// ---- the teacher's controls (live board) ----

function teacherPause(s, now) {
  if (s.state === 'ended' || s.teacherPaused) return s;
  const open = openPause(s);
  if (open) { open.to = iso(now); }
  s.teacherPaused = true;
  s.pauses.push({ from: iso(now), to: null, reason: 'teacher' });
  addEvent(s, { t: now, type: 'teacher-pause' });
  s.state = 'paused';
  return s;
}
function teacherResume(s, now) {
  if (s.state === 'ended' || !s.teacherPaused) return s;
  const open = openPause(s);
  if (open) open.to = iso(now);
  s.teacherPaused = false; s.away = null;
  addEvent(s, { t: now, type: 'teacher-resume' });
  return evaluateFocus(s, now);
}
function addTime(s, minutes, now) {
  const m = Math.max(1, Math.min(240, Math.round(Number(minutes) || 0)));
  if (s.state === 'ended') return s;
  if (s.deadlineAt) { s.deadlineAt = iso(ms(s.deadlineAt) + m * 60000); s.warned = false; }
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

// Away time and counts across a document's sessions, for doc.stats
function docSessionStats(sessions, now) {
  let awayMs = 0, pauses = 0, wallMs = 0;
  for (const s of sessions) {
    for (const p of s.pauses || []) { if (p.reason === 'teacher') continue; pauses++; awayMs += pauseMs(p, now); }
    wallMs += Math.max(0, (ms(s.endedAt) || ms(s.lastBeat) || now) - ms(s.startedAt));
  }
  return { sessions: sessions.length, pauses, awayMs, sessionMs: wallMs };
}

// What the editor needs from a beat or start reply
function clientView(s, now) {
  const open = openPause(s);
  return {
    id: s.id, state: s.state, endReason: s.endReason, startedAt: s.startedAt, endedAt: s.endedAt, deadlineAt: s.deadlineAt, mode: s.mode,
    pause: open ? { reason: open.reason, from: open.from, ms: pauseMs(open, now) } : null,
    awayMs: (s.pauses || []).filter(p => p.reason !== 'teacher').reduce((a, p) => a + pauseMs(p, now), 0),
    pauseCount: (s.pauses || []).filter(p => p.reason !== 'teacher').length,
    teacherMessage: (s.messages || []).slice(-1)[0] || null,
    serverNow: iso(now)
  };
}

module.exports = {
  C, CLIENT_EVENTS, PAUSE_REASONS, SessionError, windowProblem, usedMs, computeDeadline, checkStart, newSession,
  applyBeat, evaluateFocus, endSession, sweep, teacherPause, teacherResume, addTime, teacherMessage,
  docSessionStats, clientView, openPause, addEvent
};
