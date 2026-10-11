// Visor Writer: the server's copy of every student document, and the op log
// that built it.
//
// The editor (public/writer.js) turns each user edit into ops:
//   { k:'i', at, s }        insert text s at index at (0-based)
//   { k:'d', at, len }      delete len characters from at
//   { k:'f', at, len, attrs } apply formatting (bold, italic, underline,
//                           header 1–3, bullet/numbered list) to a span
// The text is Quill's text without its final line break. Quill always ends a
// document with one, and line formats (a heading on the last line) sit on it,
// so format ops may reach one past the end: index text.length is that break.
// plus where it came from (src: type, paste, drop, cite, …). The server applies
// each op to its own copy of the text, numbers it, and appends it to the op
// log, which is stored in chunks of 500 ops ("opchunk" records). Every 2,000
// ops a snapshot of the whole text is kept on the document so replay can seek.
//
// Nothing here touches storage: server.js runs these inside one transaction
// over the document and the chunks its new ops land in.

const crypto = require('crypto');

const LIMITS = {
  BATCH_OPS: 500,          // ops per POST
  INSERT_CHARS: 50000,     // characters per inserted string
  DOC_CHARS: 400000,       // characters per document
  CHUNK_OPS: 500,          // ops per opchunk record
  SNAPSHOT_EVERY: 2000,    // ops between snapshots
  SNAPSHOTS_KEPT: 20,
  FORMAT_RUNS_COMPACT: 400 // tidy the formatting list past this many runs
};
const SRC = ['type', 'paste', 'drop', 'cite', 'template', 'replace', 'undo', 'redo', 'autocorrect', 'ime', 'other'];
const ATTR_KEYS = ['bold', 'italic', 'underline', 'header', 'list'];

class WritingError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}

const sha256 = s => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
// Whitespace-insensitive, so a paste whose line breaks changed still matches the copy
const normalizeWs = s => String(s || '').replace(/\s+/g, ' ').trim();
const pasteHash = s => sha256(normalizeWs(s));
const wordCount = t => (String(t).trim() ? String(t).trim().split(/\s+/).length : 0);

// Op chunk ids sort in order: "<docId>:000000", "<docId>:000001", …
const chunkNo = n => Math.floor((n - 1) / LIMITS.CHUNK_OPS);
const chunkId = (docId, no) => `${docId}:${String(no).padStart(6, '0')}`;

// The student document's id is fixed by assignment + student, so two tabs
// opening it at once can't create two documents.
const docIdFor = (assignmentId, studentId) => sha256(`${assignmentId}\n${studentId}`).slice(0, 32);

function cleanAttrs(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const k of ATTR_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
    const v = raw[k];
    if (v === null || v === false) { out[k] = null; continue; }
    if (k === 'header') { const h = Number(v); if ([1, 2, 3].includes(h)) out.header = h; continue; }
    if (k === 'list') { if (v === 'bullet' || v === 'ordered') out.list = v; continue; }
    if (v === true) out[k] = true;
  }
  return Object.keys(out).length ? out : null;
}

const isIdx = v => Number.isInteger(v) && v >= 0;

// Check one op from the editor and keep only known fields. The server fills
// n, st, sid and surf, and paste.origin; a client can't claim 'template'.
function cleanOp(raw) {
  if (!raw || typeof raw !== 'object') throw new WritingError(400, 'bad op');
  const k = raw.k;
  if (!['i', 'd', 'f'].includes(k)) throw new WritingError(400, 'bad op kind');
  if (!isIdx(raw.at)) throw new WritingError(400, 'bad op position');
  const op = { k, at: raw.at };
  if (k === 'i') {
    if (typeof raw.s !== 'string' || !raw.s.length) throw new WritingError(400, 'an insert needs text');
    if (raw.s.length > LIMITS.INSERT_CHARS) throw new WritingError(413, 'That insert is too large (50,000 characters at most).');
    op.s = raw.s;
    const attrs = cleanAttrs(raw.attrs);
    if (attrs) op.attrs = attrs;
  } else {
    if (!Number.isInteger(raw.len) || raw.len < 1) throw new WritingError(400, 'bad op length');
    op.len = raw.len;
    if (k === 'f') {
      const attrs = cleanAttrs(raw.attrs);
      if (!attrs) throw new WritingError(400, 'a format op needs attributes');
      op.attrs = attrs;
    }
  }
  op.t = Number.isFinite(raw.t) ? Math.round(raw.t) : Date.now();
  op.src = SRC.includes(raw.src) && raw.src !== 'template' ? raw.src : 'other';
  if (typeof raw.it === 'string') op.it = raw.it.slice(0, 40);
  if (k === 'i' && (op.src === 'paste' || op.src === 'drop') && raw.paste && typeof raw.paste === 'object') {
    op.paste = {
      hash: /^[0-9a-f]{64}$/.test(String(raw.paste.hash)) ? raw.paste.hash : pasteHash(op.s),
      len: op.s.length,
      origin: null,
      internal: !!raw.paste.internal
    };
  }
  return op;
}

// ---- formatting runs ----
// doc.formats is a list of { at, len, attrs } applied in order (later wins).
// Inserts and deletes move and shrink the runs like the text around them.

function shiftFormatsForInsert(formats, at, n) {
  for (const r of formats) {
    if (at <= r.at) r.at += n;
    else if (at < r.at + r.len) r.len += n;
  }
}
function shiftFormatsForDelete(formats, at, len) {
  const end = at + len;
  for (const r of formats) {
    const rEnd = r.at + r.len;
    const cutStart = Math.max(r.at, at), cutEnd = Math.min(rEnd, end);
    const cut = Math.max(0, cutEnd - cutStart);
    if (r.at >= end) r.at -= len;
    else if (r.at > at) r.at = at;
    r.len -= cut;
  }
  for (let i = formats.length - 1; i >= 0; i--) if (formats[i].len <= 0) formats.splice(i, 1);
}

// Rewrite the run list as the fewest runs that format the text the same way.
function compactFormats(formats, textLength) {
  const per = new Array(textLength);
  for (const r of formats) {
    for (let i = r.at; i < Math.min(textLength, r.at + r.len); i++) per[i] = { ...(per[i] || {}), ...r.attrs };
  }
  const key = a => { if (!a) return ''; const o = {}; for (const k of ATTR_KEYS) if (a[k] != null) o[k] = a[k]; return Object.keys(o).length ? JSON.stringify(o) : ''; };
  const out = [];
  let cur = null;
  for (let i = 0; i < textLength; i++) {
    const k = key(per[i]);
    if (cur && cur.k === k) { cur.len++; continue; }
    if (cur && cur.k) out.push({ at: cur.at, len: cur.len, attrs: JSON.parse(cur.k) });
    cur = { at: i, len: 1, k };
  }
  if (cur && cur.k) out.push({ at: cur.at, len: cur.len, attrs: JSON.parse(cur.k) });
  return out;
}

// Apply one op to { text, formats } in place. Throws 409 if it doesn't fit.
function applyOp(state, op) {
  const len = state.text.length;
  if (op.k === 'i') {
    if (op.at > len) throw new WritingError(409, 'out of range');
    if (len + op.s.length > LIMITS.DOC_CHARS) throw new WritingError(413, 'This document has reached the 400,000-character limit.');
    state.text = state.text.slice(0, op.at) + op.s + state.text.slice(op.at);
    shiftFormatsForInsert(state.formats, op.at, op.s.length);
    if (op.attrs) state.formats.push({ at: op.at, len: op.s.length, attrs: op.attrs });
  } else if (op.k === 'd') {
    if (op.at + op.len > len) throw new WritingError(409, 'out of range');
    state.text = state.text.slice(0, op.at) + state.text.slice(op.at + op.len);
    shiftFormatsForDelete(state.formats, op.at, op.len);
  } else if (op.k === 'f') {
    if (op.at + op.len > len + 1) throw new WritingError(409, 'out of range');
    state.formats.push({ at: op.at, len: op.len, attrs: op.attrs });
  }
  if (state.formats.length > LIMITS.FORMAT_RUNS_COMPACT) state.formats = compactFormats(state.formats, state.text.length + 1);
  return state;
}

// Apply a batch to a document record. Ops are numbered from doc.seq + 1 and
// stamped with the server time, session and surface. Snapshots are taken at
// every 2,000th op. Returns the stamped ops. Nothing is changed if any op
// fails: the caller runs this on a copy inside a transaction.
function applyBatch(doc, rawOps, { baseSeq, textHash, sid, surf, now = Date.now() } = {}) {
  if (!Array.isArray(rawOps)) throw new WritingError(400, 'ops must be a list');
  if (rawOps.length > LIMITS.BATCH_OPS) throw new WritingError(413, 'Too many ops in one batch (500 at most).');
  if (baseSeq !== doc.seq) throw new WritingError(409, 'out of sequence', resyncData(doc));
  const ops = rawOps.map(cleanOp);
  const state = { text: doc.text, formats: doc.formats.map(r => ({ ...r })) };
  const snapshots = [...(doc.snapshots || [])];
  const stamped = [];
  let n = doc.seq;
  try {
    for (const op of ops) {
      applyOp(state, op);
      n += 1;
      stamped.push({ n, ...op, st: now, sid, surf });
      if (n % LIMITS.SNAPSHOT_EVERY === 0) snapshots.push({ seq: n, text: state.text, formats: state.formats.map(r => ({ ...r })) });
    }
  } catch (err) {
    if (err.status === 409) throw new WritingError(409, 'That edit doesn’t fit the saved document.', resyncData(doc));
    throw err;
  }
  if (textHash && textHash !== sha256(state.text)) throw new WritingError(409, 'The saved text doesn’t match yours.', resyncData(doc));
  doc.text = state.text;
  doc.formats = state.formats;
  doc.seq = n;
  doc.snapshots = snapshots.slice(-LIMITS.SNAPSHOTS_KEPT);
  return stamped;
}

// What the editor needs to reload after a 409
function resyncData(doc) {
  return { seq: doc.seq, text: doc.text, formats: doc.formats };
}

// Add stamped ops to their chunks. `chunks` maps chunk id -> existing chunk (or
// undefined); returns the chunks to write.
function appendToChunks(docId, chunks, stamped) {
  const touched = new Map();
  for (const op of stamped) {
    const id = chunkId(docId, chunkNo(op.n));
    let c = touched.get(id) || chunks[id] || { id, docId, no: chunkNo(op.n), ops: [] };
    if (c.ops.length >= LIMITS.CHUNK_OPS) throw new Error(`chunk ${id} is full`);
    c = touched.get(id) || { ...c, ops: [...c.ops] };
    c.ops.push(op);
    c.updatedAt = new Date().toISOString();
    touched.set(id, c);
  }
  return [...touched.values()];
}
// The chunk ids a batch of `count` ops after `seq` will touch
function chunkIdsFor(docId, seq, count) {
  if (!count) return [];
  const a = chunkNo(seq + 1), b = chunkNo(seq + count);
  const out = [];
  for (let i = a; i <= b; i++) out.push(chunkId(docId, i));
  return out;
}

// Rebuild the text from a full op log (tests, and the replay's sanity check).
function replayOps(ops, upTo = Infinity) {
  const state = { text: '', formats: [] };
  for (const op of ops) {
    if (op.n > upTo) break;
    applyOp(state, op);
  }
  return state;
}

// A brand-new student document. Starter text from the teacher becomes op 1,
// marked src:'template' so it's never counted as the student's writing.
function newDoc({ id, assignmentId, classId, studentId, templateText = '', now = Date.now() }) {
  const iso = new Date(now).toISOString();
  const doc = {
    id, assignmentId, classId, studentId,
    text: '', formats: [], sources: [], seq: 0, snapshots: [],
    status: 'not-started', submittedAt: null, returnedAt: null, reopened: false,
    lease: null,
    stats: { words: 0, activeMs: 0, sessions: 0, pauses: 0, awayMs: 0, pastes: 0, externalPasteChars: 0, typedChars: 0 },
    createdAt: iso, updatedAt: iso
  };
  const firstOps = [];
  if (templateText) {
    const op = { n: 1, t: now, st: now, k: 'i', at: 0, s: templateText.slice(0, LIMITS.INSERT_CHARS), src: 'template', sid: null, surf: null, u: 'teacher-template' };
    applyOp(doc, op);
    doc.seq = 1;
    firstOps.push(op);
  }
  doc.stats.words = wordCount(doc.text);
  return { doc, firstOps };
}

// Cached counters for lists and the live board, updated with each batch.
function updateStats(doc, stamped) {
  const s = doc.stats || (doc.stats = {});
  s.words = wordCount(doc.text);
  for (const op of stamped) {
    if (op.k !== 'i') continue;
    if (op.paste) {
      s.pastes = (s.pastes || 0) + 1;
      if (!op.paste.internal && !op.paste.origin) s.externalPasteChars = (s.externalPasteChars || 0) + op.s.length;
      if (op.paste.origin) s.researchPasteChars = (s.researchPasteChars || 0) + op.s.length;
    } else if (op.src === 'type' || op.src === 'ime') {
      s.typedChars = (s.typedChars || 0) + op.s.length;
    } else if (op.src === 'other' && op.s.length > 1) {
      s.otherChars = (s.otherChars || 0) + op.s.length;
    }
    if (op.paste && op.s.length > (s.biggestPaste || 0) && !op.paste.internal) s.biggestPaste = op.s.length;
  }
  return s;
}

module.exports = {
  LIMITS, SRC, WritingError, sha256, normalizeWs, pasteHash, wordCount,
  chunkNo, chunkId, chunkIdsFor, docIdFor, cleanOp, cleanAttrs, applyOp, applyBatch, appendToChunks,
  replayOps, newDoc, updateStats, compactFormats, resyncData
};
