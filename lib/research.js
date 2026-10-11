// Research recorded by the Visor extension during writing sessions, and the
// link between a paste in the essay and the page it was copied from.
//
// The extension sends events in batches (POST /api/ext/research). They're
// kept in "research" records, chunks of up to 500 events per session, keyed
// by sessionId, docId, studentId, assignmentId and classId (so a class's
// retention sweep can find them).
//
// Paste origins (Section 7.6): when a paste arrives, the server looks for a
// research "copy" event by the same student, in any session of the same
// assignment, in the last 3 hours, with the same hash (sha256 of the text with
// whitespace collapsed). Found: the paste gets origin { url, title, copiedAt }.
// Not found and not marked internal: it's "pasted from outside Visor's view".

const LIMITS = { BATCH: 200, URL: 2000, QUERY: 500, TITLE: 300, PREVIEW: 140, CHUNK: 500, ORIGIN_WINDOW_MS: 3 * 60 * 60 * 1000, PER_MINUTE: 30 };
const TYPES = ['search', 'visit', 'leave', 'copy', 'cite', 'blocked', 'ai-site'];
const ENGINES = ['google', 'bing', 'duckduckgo', 'yahoo', 'youtube', 'scholar', 'wikipedia', 'ecosia', 'brave', 'perplexity', 'other'];

class ResearchError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const str = (v, max) => (v == null ? undefined : String(v).slice(0, max));
const hostOf = url => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };

// Keep only known fields, capped (Section 12: URLs 2k, queries 500).
function cleanEvent(raw, now) {
  if (!raw || typeof raw !== 'object' || !TYPES.includes(raw.type)) return null;
  const t = Number.isFinite(raw.t) ? Math.min(now + 60000, Math.round(raw.t)) : now;
  const ev = { t, type: raw.type };
  if (raw.url != null) { ev.url = str(raw.url, LIMITS.URL); ev.host = str(raw.host || hostOf(raw.url), 255); }
  if (raw.title != null) ev.title = str(raw.title, LIMITS.TITLE);
  if (raw.type === 'search') { ev.query = str(raw.query, LIMITS.QUERY) || ''; ev.engine = ENGINES.includes(raw.engine) ? raw.engine : 'other'; }
  if (raw.type === 'leave') ev.dwellMs = Math.max(0, Math.min(24 * 3600e3, Math.round(Number(raw.dwellMs) || 0)));
  if (raw.type === 'copy') {
    const c = raw.copy || {};
    if (!/^[0-9a-f]{64}$/.test(String(c.hash))) return null;
    ev.copy = { hash: c.hash, len: Math.max(0, Math.round(Number(c.len) || 0)), preview: str(c.preview, LIMITS.PREVIEW) || '' };
  }
  if (raw.type === 'cite') ev.sourceId = str(raw.sourceId, 80);
  if (raw.type === 'ai-site' || raw.type === 'blocked') { ev.blocked = !!raw.blocked; if (raw.site) ev.site = str(raw.site, 200); }
  return ev;
}

function cleanEvents(list, now = Date.now()) {
  if (!Array.isArray(list)) throw new ResearchError(400, 'events must be a list');
  if (list.length > LIMITS.BATCH) throw new ResearchError(413, 'At most 200 research events per batch.');
  return list.map(e => cleanEvent(e, now)).filter(Boolean).sort((a, b) => a.t - b.t);
}

// Best-effort, per server instance: 30 batches a minute per session.
const buckets = new Map();
function rateLimit(key, now = Date.now()) {
  const b = buckets.get(key) || { tokens: LIMITS.PER_MINUTE, at: now };
  b.tokens = Math.min(LIMITS.PER_MINUTE, b.tokens + ((now - b.at) / 60000) * LIMITS.PER_MINUTE);
  b.at = now;
  if (b.tokens < 1) { buckets.set(key, b); return false; }
  b.tokens -= 1;
  buckets.set(key, b);
  if (buckets.size > 5000) for (const [k, v] of buckets) if (now - v.at > 120000) buckets.delete(k);
  return true;
}

const chunkId = (sessionId, no) => `${sessionId}:${String(no).padStart(4, '0')}`;

// Append events to a session's research chunks. `last` is its newest chunk
// (or null). Returns the chunks to write.
function appendEvents(session, last, events, now = Date.now()) {
  const base = { sessionId: session.id, docId: session.docId, studentId: session.studentId, assignmentId: session.assignmentId, classId: session.classId };
  const out = [];
  let cur = last && last.events.length < LIMITS.CHUNK ? { ...last, events: [...last.events] } : null;
  let no = last ? last.no + (cur ? 0 : 1) : 0;
  for (const ev of events) {
    if (!cur) cur = { id: chunkId(session.id, no), no, ...base, events: [] };
    cur.events.push(ev);
    if (cur.events.length >= LIMITS.CHUNK) { out.push(cur); cur = null; no += 1; }
  }
  if (cur) out.push(cur);
  const iso = new Date(now).toISOString();
  return out.map(c => ({ ...c, updatedAt: iso }));
}

// Every copy event from a list of research chunks: [{ hash, url, title, t, studentId }]
function copiesFrom(chunks) {
  const out = [];
  for (const c of chunks) for (const e of c.events || []) if (e.type === 'copy' && e.copy) out.push({ hash: e.copy.hash, url: e.url, title: e.title || '', t: e.t, studentId: c.studentId, preview: e.copy.preview });
  return out;
}

// Fill paste.origin on stamped ops from matching copies (same student, same
// hash, copied within 3 hours before the paste). Most recent copy wins.
function matchPasteOrigins(ops, copies, { studentId, now = Date.now() } = {}) {
  for (const op of ops) {
    if (!op.paste || op.paste.origin) continue;
    const when = op.t || now;
    const match = copies
      .filter(c => c.studentId === studentId && c.hash === op.paste.hash && c.t <= when + 60000 && when - c.t <= LIMITS.ORIGIN_WINDOW_MS)
      .sort((a, b) => b.t - a.t)[0];
    if (match) op.paste.origin = { url: match.url, title: match.title, copiedAt: new Date(match.t).toISOString() };
  }
  return ops;
}

module.exports = { LIMITS, TYPES, ResearchError, cleanEvent, cleanEvents, rateLimit, chunkId, appendEvents, copiesFrom, matchPasteOrigins };
