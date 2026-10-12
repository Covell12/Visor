// Visor Writer: the server's copy of every student document, and the op log
// that built it.
//
// The editor (public/writer.js) turns each user edit into ops:
//   { k:'i', at, s, attrs? }  insert text s at index at (0-based), with exactly
//                             the formats in attrs (inserted text inherits none)
//   { k:'d', at, len }        delete len characters from at
//   { k:'f', at, len, attrs } apply formatting to a span
// The text is Quill's text without its final line break. Quill always ends a
// document with one, and line formats (a heading on the last line) sit on it,
// so format ops may reach one past the end: index text.length is that break.
// An image is one EMBED character (U+FFFC) inserted on its own, whose attrs
// name the uploaded image. Which formats exist, and how they're checked, lives
// in lib/doc-format.js (shared with the browser).
//
// Each op also says where it came from (src: type, paste, drop, cite, image,
// structure, …). The server applies each op to its own copy of the text,
// numbers it, and appends it to the op log, which is stored in chunks of 500
// ops ("opchunk" records). Every 2,000 ops a snapshot of the whole text is kept
// on the document so replay can seek.
//
// Nothing here touches storage: server.js runs these inside one transaction
// over the document and the chunks its new ops land in.

const crypto = require('crypto');
const DF = require('./doc-format.js');

const LIMITS = {
  BATCH_OPS: 500,          // ops per POST
  INSERT_CHARS: 50000,     // characters per inserted string
  DOC_CHARS: 400000,       // characters per document
  CHUNK_OPS: 500,          // ops per opchunk record
  SNAPSHOT_EVERY: 2000,    // ops between snapshots
  SNAPSHOTS_KEPT: 20,
  FORMAT_RUNS_COMPACT: 400, // tidy the formatting list past this many runs (and past twice the last tidy size)
  // The formatting of one document, measured tidy: how many runs, and their
  // size as stored (JSON, UTF-8 bytes). A long essay with heavy formatting
  // has a few thousand runs and well under 200 KB.
  FORMAT_RUNS: 20000,
  FORMAT_BYTES: 1000000,
  SNAPSHOT_FORMAT_BYTES: 2000000 // the formatting kept in all the snapshots together
};
const TOO_MUCH_FORMATTING = 'This document has too much formatting to save (links, styles or picture descriptions). Remove some and try again.';
// image: an image inserted from a file. structure: tables, rows, columns and
// other toolbar or menu changes to the document's structure.
const SRC = ['type', 'paste', 'drop', 'cite', 'template', 'replace', 'undo', 'redo', 'autocorrect', 'ime', 'image', 'structure', 'other'];
const { EMBED } = DF;

class WritingError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}

const sha256 = s => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
// Whitespace-insensitive, so a paste whose line breaks changed still matches the copy
const normalizeWs = s => String(s || '').replace(/\s+/g, ' ').trim();
const pasteHash = s => sha256(normalizeWs(s));
const wordCount = DF.wordCount;

// Op chunk ids sort in order: "<docId>:000000", "<docId>:000001", …
const chunkNo = n => Math.floor((n - 1) / LIMITS.CHUNK_OPS);
const chunkId = (docId, no) => `${docId}:${String(no).padStart(6, '0')}`;

// The student document's id is fixed by assignment + student, so two tabs
// opening it at once can't create two documents.
const docIdFor = (assignmentId, studentId) => sha256(`${assignmentId}\n${studentId}`).slice(0, 32);

// Attributes an insert or format op may carry: lib/doc-format.js decides
const cleanAttrs = DF.cleanAttrs;
const without = (attrs, test) => {
  if (!attrs) return null;
  const out = {};
  for (const k of Object.keys(attrs)) if (!test(k, attrs[k])) out[k] = attrs[k];
  return Object.keys(out).length ? out : null;
};

const isIdx = v => Number.isInteger(v) && v >= 0;

// Check one op from the editor and keep only known fields. The server fills
// n, st, sid and surf, and paste.origin; a client can't claim 'template'.
// Returns null for a format op with nothing valid left to apply: it's skipped,
// never a reason to refuse the batch.
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
    // New text has no formats to remove, so nulls mean nothing here
    let attrs = without(cleanAttrs(raw.attrs), (key, v) => v === null);
    if (raw.s.includes(EMBED)) {
      // An image is its own one-character insert, naming its upload
      if (raw.s !== EMBED || !attrs || !attrs.image) throw new WritingError(400, 'An image is missing its upload.');
    } else {
      // Text has no image, and so no image size or description either
      attrs = without(attrs, DF.isEmbedKey);
    }
    if (attrs) op.attrs = attrs;
  } else {
    if (!Number.isInteger(raw.len) || raw.len < 1) throw new WritingError(400, 'bad op length');
    op.len = raw.len;
    if (k === 'f') {
      // Which image an embed shows never changes; its size and alt text can
      const attrs = without(cleanAttrs(raw.attrs), key => key === 'image');
      if (!attrs) return null;
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
    // One paste can arrive as several inserts (pieces of a very long paste, or
    // text and a picture pasted together): the later ones say so
    const part = Number(raw.part);
    if (Number.isInteger(part) && part >= 1 && part <= 1000) op.paste.part = part;
  }
  return op;
}

// ---- formatting runs ----
// doc.formats is a list of { at, len, attrs } applied in order (later wins).
// Inserts and deletes move and shrink the runs like the text around them
// (lib/doc-format.js: insertRuns, deleteRuns, formatRuns, shared with the
// replay). The list is tidied with compactFormats, amortised: only when it has
// grown past twice its size after the last tidy (and past 400 runs).
const compactFormats = DF.compactFormats;

function maybeCompact(state) {
  const limit = Math.max(LIMITS.FORMAT_RUNS_COMPACT, 2 * (state.compactedRuns || 0));
  if (state.formats.length <= limit) return;
  state.formats = compactFormats(state.formats, state.text.length);
  state.compactedRuns = state.formats.length;
}

// ---- how much formatting a document may hold ----
// Each value is checked on its own (a link up to 2,048 characters, alt text up
// to 300), and the whole formatting list is held to LIMITS.FORMAT_RUNS runs
// and LIMITS.FORMAT_BYTES, the way the text is held to 400,000 characters.
const formatBytes = formats => Buffer.byteLength(JSON.stringify(formats || []), 'utf8');
const formatsFit = formats => formats.length <= LIMITS.FORMAT_RUNS && formatBytes(formats) <= LIMITS.FORMAT_BYTES;

// After a batch: tidy the list if it's over the limit, and refuse the batch
// (413) if it's still over. A document saved over the limit before it existed
// isn't locked: a batch that doesn't add to its formatting still goes through.
function checkFormatSize(state, before) {
  if (formatsFit(state.formats)) return;
  state.formats = compactFormats(state.formats, state.text.length);
  state.compactedRuns = state.formats.length;
  if (formatsFit(state.formats)) return;
  const prev = compactFormats(before.formats, before.textLength);
  if (state.formats.length <= prev.length && formatBytes(state.formats) <= formatBytes(prev)) return;
  throw new WritingError(413, TOO_MUCH_FORMATTING);
}

// alt and width describe a picture: on a span with no picture in it they mean
// nothing, so they're dropped (and an op left with nothing is skipped). An op
// that doesn't fit is left for applyOp to refuse.
function imageAttrsOnImages(state, op) {
  if (op.k !== 'f' || !Object.keys(op.attrs).some(DF.isEmbedKey)) return op;
  if (op.at + op.len > state.text.length + 1) return op;
  if (state.text.slice(op.at, op.at + op.len).includes(EMBED)) return op;
  const attrs = without(op.attrs, DF.isEmbedKey);
  return attrs ? { ...op, attrs } : null;
}

// Snapshots keep their formatting tidy, and together under
// LIMITS.SNAPSHOT_FORMAT_BYTES: past it the oldest go first (the newest stays).
// Nothing reads them back yet; they're there so a replay can seek.
function trimSnapshots(snapshots) {
  const kept = snapshots.slice(-LIMITS.SNAPSHOTS_KEPT);
  let total = 0;
  for (let i = kept.length - 1; i >= 0; i--) {
    total += formatBytes(kept[i].formats);
    if (total > LIMITS.SNAPSHOT_FORMAT_BYTES && i < kept.length - 1) return kept.slice(i + 1);
  }
  return kept;
}

// Apply one op to { text, formats, compactedRuns? } in place (the run list is
// replaced, never edited). Throws 409 if it doesn't fit.
function applyOp(state, op) {
  const len = state.text.length;
  if (op.k === 'i') {
    if (op.at > len) throw new WritingError(409, 'out of range');
    if (len + op.s.length > LIMITS.DOC_CHARS) throw new WritingError(413, 'This document has reached the 400,000-character limit.');
    state.text = state.text.slice(0, op.at) + op.s + state.text.slice(op.at);
    state.formats = DF.insertRuns(state.formats, op.at, op.s.length, op.attrs);
  } else if (op.k === 'd') {
    if (op.at + op.len > len) throw new WritingError(409, 'out of range');
    state.text = state.text.slice(0, op.at) + state.text.slice(op.at + op.len);
    state.formats = DF.deleteRuns(state.formats, op.at, op.len);
  } else if (op.k === 'f') {
    if (op.at + op.len > len + 1) throw new WritingError(409, 'out of range');
    state.formats = DF.formatRuns(state.formats, op.at, op.len, op.attrs);
  }
  maybeCompact(state);
  return state;
}

// Apply a batch to a document record. Ops are numbered from doc.seq + 1 and
// stamped with the server time, session and surface. Snapshots are taken at
// every 2,000th op. Returns the stamped ops (format ops with nothing valid to
// apply are left out). A batch that leaves the formatting over its limit is
// refused with 413. Nothing is changed if any op fails: the caller runs
// this on a copy inside a transaction.
function applyBatch(doc, rawOps, { baseSeq, textHash, sid, surf, now = Date.now() } = {}) {
  if (!Array.isArray(rawOps)) throw new WritingError(400, 'ops must be a list');
  if (rawOps.length > LIMITS.BATCH_OPS) throw new WritingError(413, 'Too many ops in one batch (500 at most).');
  if (baseSeq !== doc.seq) throw new WritingError(409, 'out of sequence', resyncData(doc));
  const ops = rawOps.map(cleanOp).filter(Boolean);
  const state = { text: doc.text, formats: doc.formats.map(r => ({ ...r })), compactedRuns: doc.formatsCompacted || 0 };
  const snapshots = [...(doc.snapshots || [])];
  const stamped = [];
  let n = doc.seq, snapped = false, formatted = false;
  try {
    for (const raw of ops) {
      const op = imageAttrsOnImages(state, raw);
      if (!op) continue;
      applyOp(state, op);
      if (op.k !== 'd') formatted = true;   // inserts can split runs too
      n += 1;
      stamped.push({ n, ...op, st: now, sid, surf });
      if (n % LIMITS.SNAPSHOT_EVERY === 0) { snapshots.push({ seq: n, text: state.text, formats: compactFormats(state.formats, state.text.length) }); snapped = true; }
    }
  } catch (err) {
    if (err.status === 409) throw new WritingError(409, 'That edit doesn’t fit the saved document.', resyncData(doc));
    throw err;
  }
  if (textHash && textHash !== sha256(state.text)) throw new WritingError(409, 'The saved text doesn’t match yours.', resyncData(doc));
  if (formatted) checkFormatSize(state, { formats: doc.formats, textLength: doc.text.length });
  doc.text = state.text;
  doc.formats = state.formats;
  doc.formatsCompacted = state.compactedRuns || 0;
  doc.seq = n;
  doc.snapshots = snapped ? trimSnapshots(snapshots) : snapshots.slice(-LIMITS.SNAPSHOTS_KEPT);
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
  const state = { text: '', formats: [], compactedRuns: 0 };
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
  // Starter text is plain: an image placeholder in it would have no upload
  const starter = String(templateText || '').split(EMBED).join('').slice(0, LIMITS.INSERT_CHARS);
  if (starter) {
    const op = { n: 1, t: now, st: now, k: 'i', at: 0, s: starter, src: 'template', sid: null, surf: null, u: 'teacher-template' };
    applyOp(doc, op);
    doc.seq = 1;
    firstOps.push(op);
  }
  doc.stats.words = wordCount(doc.text);
  return { doc, firstOps };
}

// Cached counters for lists and the live board, updated with each batch.
// Images and structure changes (tables, lists from the menus…) aren't typing
// and aren't "other" text; images are counted on their own.
function updateStats(doc, stamped) {
  const s = doc.stats || (doc.stats = {});
  s.words = wordCount(doc.text);
  for (const op of stamped) {
    if (op.k !== 'i') continue;
    if (op.s === EMBED) s.images = (s.images || 0) + 1;
    if (op.paste) {
      // The later pieces of one paste count as the same paste
      const piece = op.paste.part > 0;
      if (!piece) s.pastes = (s.pastes || 0) + 1;
      s.lastPasteLen = (piece ? s.lastPasteLen || 0 : 0) + op.s.length;
      if (!op.paste.internal && !op.paste.origin) s.externalPasteChars = (s.externalPasteChars || 0) + op.s.length;
      if (op.paste.origin) s.researchPasteChars = (s.researchPasteChars || 0) + op.s.length;
    } else if (op.src === 'type' || op.src === 'ime') {
      s.typedChars = (s.typedChars || 0) + op.s.length;
    } else if (op.src === 'other' && op.s.length > 1) {
      s.otherChars = (s.otherChars || 0) + op.s.length;
    }
    if (op.paste && s.lastPasteLen > (s.biggestPaste || 0) && !op.paste.internal) s.biggestPaste = s.lastPasteLen;
  }
  return s;
}

module.exports = {
  LIMITS, SRC, EMBED, WritingError, sha256, normalizeWs, pasteHash, wordCount,
  chunkNo, chunkId, chunkIdsFor, docIdFor, cleanOp, cleanAttrs, applyOp, applyBatch, appendToChunks,
  replayOps, newDoc, updateStats, compactFormats, formatBytes, resyncData
};
